import './polyfill.js'
import * as sock from 'sock'
import { HeadersImpl, RequestImpl, ResponseImpl, _readStream } from './http-common.js'

type SockHandle = import('sock').SockHandle

// ── Public API ──

export type ServerHandler = (req: Request) => Promise<Response>

// ── Internal types ──

interface NetEvent { lNetworkEvents: number; iErrorCode: number[] }

interface ParsedHeader {
    method: string
    target: string
    version: string
    headers: Record<string, string>
    chunked: boolean
    contentLength: number
}

interface PendingReq {
    parsed: ParsedHeader
    bodyStart: number
}

interface ActiveReq {
    req: RequestImpl
}

interface Conn {
    sock: SockHandle
    parts: Uint8Array[]
    pending: PendingReq | null
    current: ActiveReq | null
    outQueue: Uint8Array | null
    closed: boolean
    closeAfterFlush: boolean
    keepAlive: boolean
    owner: HttpServer
}

const STATUS_TEXT: Record<number, string> = {
    100: 'Continue', 101: 'Switching Protocols',
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
    301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 408: 'Request Timeout', 413: 'Payload Too Large',
    500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable',
}

// ── Byte helpers ──

function concatU8(parts: Uint8Array[]): Uint8Array {
    let total = 0
    for (const p of parts) total += p.length
    const out = new Uint8Array(total)
    let off = 0
    for (const p of parts) { out.set(p, off); off += p.length }
    return out
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

function findCrLfCrLf(buf: Uint8Array): number {
    const n = buf.length - 3
    for (let i = 0; i < n; i++) {
        if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i
    }
    return -1
}

/** Decode a chunked-transfer body starting at `start`. Returns the decoded
 *  data and the offset just past the terminating CRLF, or null if the buffer
 *  does not yet contain the complete chunked body. */
function decodeChunked(buf: Uint8Array, start: number): { data: Uint8Array; end: number } | null {
    let pos = start
    const parts: Uint8Array[] = []
    const decoder = new TextDecoder('utf-8')
    while (pos < buf.length) {
        let eol = pos
        while (eol < buf.length && buf[eol] !== 13) eol++
        if (eol >= buf.length || eol + 1 >= buf.length || buf[eol + 1] !== 10) return null
        const sizeLine = decoder.decode(buf.subarray(pos, eol)).trim()
        const semi = sizeLine.indexOf(';')
        const hex = (semi >= 0 ? sizeLine.slice(0, semi) : sizeLine).trim()
        const size = parseInt(hex, 16)
        if (isNaN(size) || size < 0) return null
        pos = eol + 2
        if (size === 0) {
            while (true) {
                if (pos >= buf.length) return null
                if (buf[pos] === 13) {
                    if (pos + 1 >= buf.length || buf[pos + 1] !== 10) return null
                    pos += 2
                    return { data: concatU8(parts), end: pos }
                }
                let t = pos
                while (t < buf.length && buf[t] !== 13) t++
                if (t >= buf.length || t + 1 >= buf.length || buf[t + 1] !== 10) return null
                pos = t + 2
            }
        }
        if (pos + size > buf.length) return null
        parts.push(buf.subarray(pos, pos + size))
        pos += size
        if (pos + 1 >= buf.length || buf[pos] !== 13 || buf[pos + 1] !== 10) return null
        pos += 2
    }
    return null
}

// ── Parsing ──

function parseHeader(headerStr: string): ParsedHeader | null {
    const lines = headerStr.split('\r\n')
    const first = lines[0]
    if (!first) return null
    const sp1 = first.indexOf(' ')
    const sp2 = first.lastIndexOf(' ')
    if (sp1 <= 0 || sp2 <= sp1) return null
    const method = first.slice(0, sp1)
    const target = first.slice(sp1 + 1, sp2)
    const version = first.slice(sp2 + 1).trim()

    const headers: Record<string, string> = {}
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i]
        if (!line) continue
        const ci = line.indexOf(':')
        if (ci <= 0) continue
        const name = line.slice(0, ci).trim().toLowerCase()
        const value = line.slice(ci + 1).trim()
        if (headers[name] !== undefined) headers[name] = headers[name] + ', ' + value
        else headers[name] = value
    }

    const te = (headers['transfer-encoding'] || '').toLowerCase()
    const chunked = te.indexOf('chunked') >= 0
    const contentLength = parseInt(headers['content-length'] || '0', 10) || 0
    return { method, target, version, headers, chunked, contentLength }
}

// ── Server ──

export class HttpServer {
    readonly handler: ServerHandler
    private serverSock: SockHandle | null = null
    readonly conns = new Map<SockHandle, Conn>()
    private closed = false

    constructor(handler: ServerHandler) {
        this.handler = handler
    }

    /** Actual bound address, or null if not listening. */
    address(): { addr: string; port: number } | null {
        if (this.serverSock === null) return null
        return sock.getsockname(this.serverSock)
    }

    /** Bind and start listening. Returns 0 on success, -1 on failure. */
    listen(port: number, host?: string, backlog?: number): number {
        if (this.serverSock !== null) return -1
        const s = sock.socket()
        if (s < 0) return -1
        if (sock.bind(s, host ?? null, port) !== 0) { sock.closesocket(s); return -1 }
        if (sock.listen(s, backlog ?? 64) !== 0) { sock.closesocket(s); return -1 }
        this.serverSock = s
        sock.set_on_event(s, (event: NetEvent) => {
            if (event.lNetworkEvents & sock.FdEvent.FD_ACCEPT) this.acceptLoop()
        })
        return 0
    }

    close(): void {
        if (this.closed) return
        this.closed = true
        for (const c of Array.from(this.conns.values())) closeConn(c)
        this.conns.clear()
        if (this.serverSock !== null) { sock.closesocket(this.serverSock); this.serverSock = null }
    }

    private acceptLoop(): void {
        if (this.closed || this.serverSock === null) return
        while (true) {
            const ac = sock.accept(this.serverSock)
            if (!ac) break
            const c: Conn = {
                sock: ac.handle,
                parts: [],
                pending: null,
                current: null,
                outQueue: null,
                closed: false,
                closeAfterFlush: false,
                keepAlive: true,
                owner: this,
            }
            this.conns.set(c.sock, c)
            sock.set_on_event(c.sock, (event: NetEvent) => this.onConnEvent(c, event))
        }
    }

    private onConnEvent(c: Conn, event: NetEvent): void {
        if (c.closed) return
        if (event.lNetworkEvents & sock.FdEvent.FD_READ) onRead(c)
        if (event.lNetworkEvents & sock.FdEvent.FD_WRITE) flushQueue(c)
        if (event.lNetworkEvents & sock.FdEvent.FD_CLOSE) {
            onRead(c)
            if (!c.current && !c.pending) closeConn(c)
        }
    }
}

export function createServer(handler: ServerHandler): HttpServer {
    return new HttpServer(handler)
}

// ── Connection I/O ──

function onRead(c: Conn): void {
    if (c.closed) return
    while (true) {
        const d = sock.recv(c.sock, 8192)
        if (!d) break
        c.parts.push(new Uint8Array(d))
    }
    if (!c.closed) tryProcess(c)
}

function queueSend(c: Conn, data: Uint8Array): void {
    if (c.closed || data.length === 0) return
    if (c.outQueue && c.outQueue.length > 0) {
        c.outQueue = concatU8([c.outQueue, data])
        return
    }
    const ret = sock.send(c.sock, toArrayBuffer(data))
    if (ret < 0) {
        c.outQueue = data
        return
    }
    if (ret < data.length) {
        c.outQueue = data.subarray(ret)
        return
    }
    if (c.closeAfterFlush) closeConn(c)
}

function flushQueue(c: Conn): void {
    if (c.closed) return
    if (!c.outQueue || c.outQueue.length === 0) {
        if (c.closeAfterFlush) closeConn(c)
        return
    }
    const q = c.outQueue
    const ret = sock.send(c.sock, toArrayBuffer(q))
    if (ret < 0) return
    if (ret < q.length) {
        c.outQueue = q.subarray(ret)
        return
    }
    c.outQueue = null
    if (c.closeAfterFlush) closeConn(c)
}

function closeConn(c: Conn): void {
    if (c.closed) return
    c.closed = true
    if (c.sock >= 0) sock.closesocket(c.sock)
    c.owner.conns.delete(c.sock)
}

// ── Request state machine ──

function whole(c: Conn): Uint8Array {
    return concatU8(c.parts)
}

function trimParts(c: Conn, buf: Uint8Array, consumed: number): void {
    if (consumed >= buf.length) {
        c.parts = []
    } else {
        c.parts = [buf.subarray(consumed)]
    }
}

function tryProcess(c: Conn): void {
    if (c.closed || c.current) return
    const buf = whole(c)

    if (c.pending) {
        const bodyStart = c.pending.bodyStart
        const parsed = c.pending.parsed
        let body: Uint8Array
        let end: number
        if (parsed.chunked) {
            const dec = decodeChunked(buf, bodyStart)
            if (!dec) return
            body = dec.data
            end = dec.end
        } else {
            const needed = parsed.contentLength
            if (bodyStart + needed > buf.length) return
            body = buf.subarray(bodyStart, bodyStart + needed)
            end = bodyStart + needed
        }
        c.pending = null
        dispatchRequest(c, parsed, body, end)
        return
    }

    const headerEnd = findCrLfCrLf(buf)
    if (headerEnd < 0) return
    const absEnd = headerEnd + 4
    const headerStr = new TextDecoder('utf-8').decode(buf.subarray(0, absEnd))
    const parsed = parseHeader(headerStr)
    if (!parsed) { closeConn(c); return }

    const bodyStart = absEnd
    if (parsed.chunked) {
        const dec = decodeChunked(buf, bodyStart)
        if (!dec) {
            c.pending = { parsed, bodyStart }
            return
        }
        dispatchRequest(c, parsed, dec.data, dec.end)
    } else if (parsed.contentLength > 0) {
        if (bodyStart + parsed.contentLength > buf.length) {
            c.pending = { parsed, bodyStart }
            return
        }
        dispatchRequest(c, parsed, buf.subarray(bodyStart, bodyStart + parsed.contentLength), bodyStart + parsed.contentLength)
    } else {
        dispatchRequest(c, parsed, new Uint8Array(0), bodyStart)
    }
}

function dispatchRequest(c: Conn, parsed: ParsedHeader, body: Uint8Array, end: number): void {
    const connHeader = (parsed.headers['connection'] || '').toLowerCase()
    if (parsed.version === 'HTTP/1.1') c.keepAlive = connHeader.indexOf('close') < 0
    else c.keepAlive = connHeader.indexOf('keep-alive') >= 0

    let host = parsed.headers['host']
    if (!host) {
        const a = c.owner.address()
        const addrStr = a ? (a.addr.includes(':') ? `[${a.addr}]` : a.addr) : 'localhost'
        host = a ? addrStr + ':' + a.port : 'localhost'
    }

    const isAbsolute = parsed.target.startsWith('http://') || parsed.target.startsWith('https://')
    const url = isAbsolute ? parsed.target : 'http://' + host + parsed.target

    const req = new RequestImpl(url, {
        method: parsed.method,
        headers: new HeadersImpl(parsed.headers),
        body: body.length > 0 ? body : undefined,
    })

    c.current = { req }
    trimParts(c, whole(c), end)
    void handleRequest(c)
}

async function handleRequest(c: Conn): Promise<void> {
    const req = c.current?.req
    if (!req) { c.current = null; return }

    let res: Response
    try {
        const result = await c.owner.handler(req)
        if (result instanceof ResponseImpl) {
            res = result
        } else {
            console.error('[http-server] handler must return a Response')
            res = new ResponseImpl('Internal Server Error', { status: 500 })
        }
    } catch (e) {
        console.error('[http-server] handler error:', e)
        res = new ResponseImpl('Internal Server Error', { status: 500 })
    }

    if (c.closed) return
    await sendResponse(c, req.method, res)
    if (c.closed) return

    c.current = null
    if (!c.closeAfterFlush) tryProcess(c)
}

async function sendResponse(c: Conn, method: string, res: Response): Promise<void> {
    const status = res.status
    const statusText = res.statusText || STATUS_TEXT[status] || 'OK'
    const headers = new HeadersImpl(res.headers)

    let body: Uint8Array
    try {
        body = await _readStream(res.body)
    } catch {
        body = new Uint8Array(0)
    }
    if (c.closed) return

    const headOnly = method === 'HEAD'
    const bodyless = (status >= 100 && status < 200) || status === 204 || status === 304

    if (!headers.has('content-length') && !bodyless) headers.set('Content-Length', String(body.length))
    if (!headers.has('connection')) headers.set('Connection', c.keepAlive ? 'keep-alive' : 'close')

    const connHdr = (headers.get('connection') || '').toLowerCase()
    if (!c.keepAlive || connHdr === 'close') c.closeAfterFlush = true

    let head = 'HTTP/1.1 ' + status + ' ' + statusText + '\r\n'
    for (const [name, value] of headers) head += name + ': ' + value + '\r\n'
    head += '\r\n'

    const headBytes = new TextEncoder().encode(head)
    const payload = headOnly || body.length === 0 ? headBytes : concatU8([headBytes, body])
    queueSend(c, payload)
}
