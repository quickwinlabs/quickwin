import './polyfill.js'
import * as sock from 'sock'
import { HeadersImpl, RequestImpl, ResponseImpl, _readStream } from './http-common.js'
import { AbortController } from './abort.js'
import { FdEvent } from '../constants'

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

interface ActiveReq {
    req: RequestImpl
}

interface Conn {
    sock: SockHandle
    parts: Uint8Array[]
    /** Cached total length of `parts` — lets header/body boundary checks run
     *  in O(1) instead of re-concatenating every received byte on each read
     *  event (O(n²) for large headers). */
    partsLen: number
    current: ActiveReq | null
    outQueue: Uint8Array | null
    resumeRead: (() => void) | null
    closed: boolean
    closeAfterFlush: boolean
    keepAlive: boolean
    owner: HttpServer
    /** AbortController for the request currently served on this connection,
     *  aborted when the client disconnects mid-response. */
    ac: AbortController | null
    /** Active request-body source, or null when the body is absent or done.
     *  While non-null, `pull()` is the only thing that calls `sock.recv` on
     *  this connection, so buffered input can never outrun a slow handler —
     *  peak memory stays at a handful of chunks instead of the request size. */
    body: BodySource | null
    /** Wakes a `pull()` that is suspended waiting for more bytes. */
    bodyWaiter: (() => void) | null
}

const STATUS_TEXT: Record<number, string> = {
    100: 'Continue', 101: 'Switching Protocols',
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
    301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 408: 'Request Timeout', 411: 'Length Required',
    413: 'Payload Too Large',
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
    // 已经是完整 buffer（byteOffset=0、无尾部余量）时零复制返回——发送大
    // body 的主路径，避免每片 send 前白拷一份。视图场景仍 slice 出独立副本
    //（FFI 持有的 buffer 生命周期不受 view 约束）。
    if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8.buffer as ArrayBuffer
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

function findCrLfCrLf(buf: Uint8Array): number {
    const n = buf.length - 3
    for (let i = 0; i < n; i++) {
        if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i
    }
    return -1
}

/** Flatten a `HeadersInit` into `[name, value]` pairs, preserving the
 *  casing the caller provided (Node `addTrailers` semantics). */
function headersInitToPairs(init: HeadersInit): [string, string][] {
    if (init instanceof HeadersImpl) {
        const out: [string, string][] = []
        for (const [name, value] of init) out.push([name, value])
        return out
    }
    if (Array.isArray(init)) return init.map(([name, value]) => [name, String(value)])
    const out: [string, string][] = []
    for (const name of Object.keys(init)) out.push([name, String((init as Record<string, string>)[name])])
    return out
}

// ── Request body source ──

/** Incremental request-body decoder. For `length` framing every byte is
 *  deliverable immediately; for `chunked` framing a byte is deliverable as
 *  soon as its chunk's declared size is reached, so output flows at roughly
 *  the `sock.recv` granularity instead of per-chunk. */
interface BodySource {
    framing: 'length' | 'chunked'
    /** 'length': body bytes not yet delivered. 'chunked': bytes left in the
     *  chunk whose data is currently being collected. */
    remain: number
    /** Raw bytes recv'd but not yet decoded; `head` is the consumed offset
     *  into `raw[0]`. */
    raw: Uint8Array[]
    head: number
    rawBytes: number
    /** Decoded bytes produced but not yet enqueued. */
    out: Uint8Array[]
    outLen: number
    done: boolean
    bad: boolean
    /** Chunked framing phase. */
    phase: 'size' | 'data' | 'crlf' | 'trailers'
    line: string
    /** True when a `\r` was read and its `\n` has not arrived yet. */
    pendingCR: boolean
    /** Live stream controller, so a mid-body disconnect can error the stream
     *  even when the handler is not currently suspended in `read()`. */
    ctrl: ReadableStreamDefaultController<Uint8Array> | null
}

function appendRaw(src: BodySource, buf: ArrayBuffer, n: number): void {
    const p = new Uint8Array(n)
    p.set(new Uint8Array(buf, 0, n))
    src.raw.push(p)
    src.rawBytes += n
}

/** Consume one byte from the front of the raw window; -1 when it is empty. */
function readByte(src: BodySource): number {
    for (;;) {
        const p = src.raw[0]
        if (!p) return -1
        if (src.head < p.length) {
            const b = p[src.head++]!
            src.rawBytes--
            if (src.head >= p.length) { src.raw.shift(); src.head = 0 }
            return b
        }
        src.raw.shift()
        src.head = 0
    }
}

/** Consume up to `want` bytes from the front of the raw window. */
function takeRaw(src: BodySource, want: number): Uint8Array {
    const n = Math.min(want, src.rawBytes)
    if (n <= 0) return new Uint8Array(0)
    const parts: Uint8Array[] = []
    let got = 0
    while (got < n) {
        const p = src.raw[0]!
        const take = Math.min(p.length - src.head, n - got)
        parts.push(p.subarray(src.head, src.head + take))
        got += take
        src.head += take
        src.rawBytes -= take
        if (src.head >= p.length) { src.raw.shift(); src.head = 0 }
    }
    return concatU8(parts)
}

function pushOut(src: BodySource, chunk: Uint8Array): void {
    if (chunk.length === 0) return
    src.out.push(chunk)
    src.outLen += chunk.length
}

function takeOut(src: BodySource): Uint8Array {
    if (src.out.length === 0) return new Uint8Array(0)
    const r = concatU8(src.out)
    src.out = []
    src.outLen = 0
    return r
}

/** Consume the `\n` of a `\r\n` whose `\r` was already taken. Returns 1 on a
 *  complete pair, 0 when the `\n` has not arrived yet (pendingCR stays set),
 *  -1 when the line ending is bad. */
function eatLf(src: BodySource): number {
    if (src.rawBytes === 0) return 0
    const b = readByte(src)
    src.pendingCR = false
    return b === 0x0a ? 1 : -1
}

/** Consume a full `\r\n`, possibly split across reads. Returns 1 / 0 / -1. */
function readEol(src: BodySource): number {
    if (src.pendingCR) return eatLf(src)
    if (src.rawBytes === 0) return 0
    if (readByte(src) !== 0x0d) return -1
    src.pendingCR = true
    return eatLf(src)
}

/** Parse the size line just terminated and arm the next phase. */
function finishSizeLine(src: BodySource): void {
    const semi = src.line.indexOf(';')
    const hex = (semi >= 0 ? src.line.slice(0, semi) : src.line).trim()
    const size = parseInt(hex, 16)
    src.line = ''
    if (!Number.isFinite(size) || size < 0) { src.bad = true; return }
    src.remain = size
    src.phase = size > 0 ? 'data' : 'trailers'
}

/** A size line without a line ending would grow `src.line` without limit, so
 *  cap it. 4 KiB covers a 16 EiB chunk with room to spare. */
function lineTooLong(src: BodySource): boolean {
    if (src.line.length > 4096) src.bad = true
    return src.bad
}

/** Consume buffered raw bytes, producing output in `src.out`.
 *
 *  Invariant the `pull` loop relies on: if this returns with `outLen === 0`,
 *  `!done` and `!bad`, then `rawBytes === 0` — the decoder is genuinely
 *  blocked and `pull` may go back to `sock.recv`. A phase must therefore
 *  `continue` on partial progress and only `return` when blocked or when it
 *  has produced output. */
function decodeBody(src: BodySource): void {
    if (src.bad || src.done) return
    if (src.framing === 'length') {
        if (src.rawBytes === 0) return
        const n = Math.min(src.remain, src.rawBytes)
        pushOut(src, takeRaw(src, n))
        src.remain -= n
        if (src.remain <= 0) src.done = true
        return
    }
    for (;;) {
        switch (src.phase) {
            case 'size': {
                if (src.pendingCR) {
                    const e = eatLf(src)
                    if (e === 0) return
                    if (e < 0) { src.bad = true; return }
                    finishSizeLine(src)
                    continue
                }
                if (src.rawBytes === 0) return
                const b = readByte(src)
                if (b !== 0x0d) {
                    src.line += String.fromCharCode(b)
                    if (lineTooLong(src)) return
                    continue
                }
                src.pendingCR = true
                continue
            }
            case 'data': {
                if (src.rawBytes === 0) return
                const n = Math.min(src.remain, src.rawBytes)
                pushOut(src, takeRaw(src, n))
                src.remain -= n
                if (src.remain === 0) { src.phase = 'crlf'; continue }
                return
            }
            case 'crlf': {
                const e = readEol(src)
                if (e === 0) return
                if (e < 0) { src.bad = true; return }
                src.phase = 'size'
                continue
            }
            case 'trailers': {
                // Trailers are discarded; an empty line ends the body.
                if (src.pendingCR) {
                    const e = eatLf(src)
                    if (e === 1) { src.done = true; return }
                    if (e < 0) { src.bad = true; return }
                    return
                }
                if (src.rawBytes === 0) return
                if (readByte(src) === 0x0d) src.pendingCR = true
                continue
            }
        }
    }
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
            if (event.lNetworkEvents & FdEvent.FD_ACCEPT) this.acceptLoop()
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
                partsLen: 0,
                current: null,
                outQueue: null,
                resumeRead: null,
                closed: false,
                closeAfterFlush: false,
                keepAlive: true,
                owner: this,
                ac: null,
                body: null,
                bodyWaiter: null,
            }
            this.conns.set(c.sock, c)
            sock.set_on_event(c.sock, (event: NetEvent) => this.onConnEvent(c, event))
        }
    }

    private onConnEvent(c: Conn, event: NetEvent): void {
        if (c.closed) return
        if (event.lNetworkEvents & FdEvent.FD_READ) onRead(c)
        if (event.lNetworkEvents & FdEvent.FD_WRITE) flushQueue(c)
        if (event.lNetworkEvents & FdEvent.FD_CLOSE) {
            onRead(c)
            abortConn(c)
            closeConn(c)
        }
    }
}

export function createServer(handler: ServerHandler): HttpServer {
    return new HttpServer(handler)
}

// ── Connection I/O ──

// Reusable recv target: each chunk is copied out before the next call, so
// nothing we hand to a handler ever aliases this buffer.
const _recvBuf = new ArrayBuffer(8192)

function onRead(c: Conn): void {
    if (c.closed) return
    if (c.body) {
        // Body phase: `pull()` owns the socket. Only wake a suspended pull —
        // draining here would let input outrun a slow handler and grow the
        // buffer with the request size, which is what this exists to avoid.
        const w = c.bodyWaiter
        c.bodyWaiter = null
        if (w) w()
        return
    }
    while (true) {
        const n = sock.recv(c.sock, _recvBuf)
        if (n <= 0) break
        c.parts.push(new Uint8Array(_recvBuf.slice(0, n)))
        c.partsLen += n
    }
    if (!c.closed) tryProcess(c)
}

/** Send `data`, or queue it when the kernel send buffer is full.
 *  Returns true when the data was fully handed to the kernel, or false
 *  when it has been buffered (or partially handed over) and the caller
 *  should back off until `flushQueue` drains and calls `c.resumeRead`. */
function queueSend(c: Conn, data: Uint8Array): boolean {
    if (c.closed || data.length === 0) return true
    if (c.outQueue && c.outQueue.length > 0) {
        c.outQueue = concatU8([c.outQueue, data])
        return false
    }
    const ret = sock.send(c.sock, toArrayBuffer(data))
    if (ret < 0) {
        abortConn(c)
        closeConn(c)
        return true
    }
    if (ret < data.length) {
        c.outQueue = data.subarray(ret)
        return false
    }
    return true
}

function flushQueue(c: Conn): void {
    if (c.closed) return
    if (!c.outQueue || c.outQueue.length === 0) {
        if (c.closeAfterFlush) closeConn(c)
        else resumeReader(c)
        return
    }
    const q = c.outQueue
    const ret = sock.send(c.sock, toArrayBuffer(q))
    if (ret < 0) {
        abortConn(c)
        closeConn(c)
        return
    }
    if (ret < q.length) {
        c.outQueue = q.subarray(ret)
        return
    }
    c.outQueue = null
    if (c.closeAfterFlush) closeConn(c)
    else resumeReader(c)
}

function closeConn(c: Conn): void {
    if (c.closed) return
    c.closed = true
    resumeReader(c)
    if (c.sock >= 0) sock.closesocket(c.sock)
    c.owner.conns.delete(c.sock)
}

/** Abort the in-flight request (notifying its handler via `req.signal`).
 *  Safe to call when idle or already aborted: the controller is cleared so
 *  a fresh request on this connection gets a fresh signal. */
function abortConn(c: Conn): void {
    const ac = c.ac
    c.ac = null
    if (ac) ac.abort()

    const src = c.body
    if (!src) return
    // Error the body stream even when the handler is not suspended in a
    // `read()` right now — otherwise a client disconnect would leave it
    // pending forever. Then drop the source so no later `pull` touches a
    // socket that is being torn down or reused.
    if (src.ctrl) {
        try { src.ctrl.error(new Error('client disconnected')) } catch { /* already closed */ }
    }
    src.raw = []
    src.rawBytes = 0
    src.head = 0
    c.body = null
    const w = c.bodyWaiter
    c.bodyWaiter = null
    if (w) w()
}

/** Resolve the pending back-pressure awaiter, if any. Called whenever the
 *  send queue drains or the connection closes. */
function resumeReader(c: Conn): void {
    const r = c.resumeRead
    c.resumeRead = null
    if (r) r()
}

/** Close the connection once a response is fully flushed, when the
 *  handler or client asked for `Connection: close`. */
function finishResponse(c: Conn): void {
    if (c.closeAfterFlush && !c.outQueue) closeConn(c)
}

/** Frame `data` as a single chunked-transfer block: `<hex size>\r\n<data>\r\n`. */
function encodeChunkFrame(data: Uint8Array, enc: TextEncoder): Uint8Array {
    return concatU8([enc.encode(data.byteLength.toString(16) + '\r\n'), data, enc.encode('\r\n')])
}

/** Read `body` one chunk at a time and send it out. When the kernel send
 *  buffer fills up (`queueSend` returns false) we pause on `c.resumeRead`,
 *  which `flushQueue` resumes once the socket drains — backpressure. */
async function writeStreamingBody(c: Conn, body: ReadableStream<Uint8Array> | null, chunked: boolean, trailer: Promise<HeadersInit> | undefined): Promise<void> {
    if (c.closed || body == null) return
    const reader = body.getReader()
    const enc = new TextEncoder()
    try {
        while (!c.closed) {
            const { done, value } = await reader.read()
            if (done) break
            if (value && value.byteLength > 0) {
                // 切成 ≤64KB 再入 queueSend：单发 200MB 级大 chunk 时
                // toArrayBuffer 会全量 slice 复制，partial drain 又每次复制
                // 剩余（O(n²)），XP 32 位 1GB 上直接把进程水位顶穿导致断连；
                // 小片让每次复制/发送恒为常数大小，backpressure 语义不变。
                const MAX_SEND = 65536
                for (let off = 0; off < value.byteLength; off += MAX_SEND) {
                    const piece = value.byteLength <= MAX_SEND ? value : value.subarray(off, Math.min(off + MAX_SEND, value.byteLength))
                    const frame = chunked ? encodeChunkFrame(piece, enc) : piece
                    if (!queueSend(c, frame)) {
                        await new Promise<void>((resolve) => { c.resumeRead = resolve })
                    }
                    if (c.closed) break
                }
            }
        }
        if (c.closed) {
            // 客户端断开（FD_CLOSE / send 失败）：取消响应体，让 producer 感知
            //（execd 借此 kill 子进程），而不是干等它自然结束。
            try { await reader.cancel() } catch (e) {
                console.error('[http-server] body cancel error:', e)
            }
            return
        }
        if (chunked) {
            let terminator = '0\r\n\r\n'
            if (trailer) {
                try {
                    const pairs = headersInitToPairs(await trailer)
                    if (pairs.length > 0) {
                        let s = '0\r\n'
                        for (const [name, value] of pairs) s += name + ': ' + value + '\r\n'
                        s += '\r\n'
                        terminator = s
                    }
                } catch (e) {
                    console.error('[http-server] trailers promise rejected:', e)
                }
            }
            queueSend(c, enc.encode(terminator))
        }
        finishResponse(c)
    } finally {
        reader.releaseLock()
    }
}

// ── Request state machine ──

function whole(c: Conn): Uint8Array {
    return concatU8(c.parts)
}

/** Result of one `drainAndDeliver` pass: a chunk was enqueued, the stream is
 *  settled (closed or errored), or the socket is empty and more input needed. */
type BodyStep = 'chunk' | 'settled' | 'blocked'

/** One pass of the body-state machine: drain what the socket offers, decode,
 *  and at most enqueue one chunk. Returns 'blocked' when the socket is empty
 *  and more input is needed — the caller must park until the next FD_READ. */
function drainAndDeliver(c: Conn, src: BodySource, controller: ReadableStreamDefaultController<Uint8Array>): BodyStep {
    const fail = () => {
        try { controller.error(new Error('client disconnected')) } catch { /* already closed */ }
    }
    if (src.bad) {
        try { controller.error(new Error('malformed request body')) } catch { /* already closed */ }
        return 'settled'
    }
    if (src.done) { finishBody(c, src); controller.close(); return 'settled' }
    if (c.closed || c.body !== src) { fail(); return 'settled' }

    for (;;) {
        decodeBody(src)
        if (src.bad) {
            try { controller.error(new Error('malformed request body')) } catch { /* already closed */ }
            return 'settled'
        }
        // One enqueue per pass: `enqueue` re-enters `pull` via requestPull, so
        // a second one here would run pull reentrantly inside its own pull.
        if (src.outLen > 0) { controller.enqueue(takeOut(src)); return 'chunk' }
        if (src.done) { finishBody(c, src); controller.close(); return 'settled' }
        if (c.closed || c.body !== src) { fail(); return 'settled' }

        const n = sock.recv(c.sock, _recvBuf)
        if (n < 0) {
            c.closed = true
            // FIN on a fully-received body is a clean shutdown, not a
            // disconnect — keep-alive pipelining relies on it.
            if (src.done) { finishBody(c, src); controller.close(); return 'settled' }
            fail(); return 'settled'
        }
        if (n === 0) return 'blocked'
        appendRaw(src, _recvBuf, n)
    }
}

/** Build the lazy request body. Bytes already buffered while the header was
 *  being parsed are seeded in so nothing recv'd during the header phase is
 *  lost. `pull` is the only caller of `sock.recv` for the rest of the body,
 *  so it runs the recv loop itself rather than draining from `onRead`. */
function makeBodyStream(c: Conn, parsed: ParsedHeader, buffered: Uint8Array): ReadableStream<Uint8Array> {
    const src: BodySource = {
        framing: parsed.chunked ? 'chunked' : 'length',
        remain: parsed.chunked ? 0 : parsed.contentLength,
        raw: [], head: 0, rawBytes: 0,
        out: [], outLen: 0,
        done: false, bad: false,
        phase: 'size', line: '', pendingCR: false,
        ctrl: null,
    }
    if (buffered.length > 0) {
        src.raw.push(buffered)
        src.rawBytes = buffered.length
    }
    c.body = src

    return new ReadableStream<Uint8Array>({
        pull: (controller) => {
            // `abortConn` already errored this stream and dropped the source.
            if (c.body !== src) return
            src.ctrl = controller
            if (drainAndDeliver(c, src, controller) !== 'blocked') return

            // Parked: no output, not done, socket drained. Resolving a promise
            // here would only END this pull — the ponyfill re-runs pull solely
            // when requestPull fires while one is in flight — so instead we
            // return and let the wake callback enqueue into the controller;
            // `enqueue` calls requestPull and `pull` re-enters from there.
            const wake = () => {
                c.bodyWaiter = null
                if (drainAndDeliver(c, src, controller) === 'blocked') c.bodyWaiter = wake
            }
            c.bodyWaiter = wake
        },
    })
}

/** The declared body is complete. Anything still buffered belongs to the next
 *  request on this connection, so hand it back to the header phase — this is
 *  what makes keep-alive pipelining work. `pull` owns the `close()` call. */
function finishBody(c: Conn, src: BodySource): void {
    const tail = takeRaw(src, src.rawBytes)
    if (tail.length > 0) { c.parts.push(tail); c.partsLen += tail.length }
    src.raw = []
    src.rawBytes = 0
    src.head = 0
    src.ctrl = null
    c.body = null
    c.bodyWaiter = null
}

/** Methods for which a body is expected when framing is declared. DELETE is
 *  deliberately excluded: clients routinely send it with no framing at all,
 *  and requiring a length there would break those. */
function methodHasBody(method: string): boolean {
    return method === 'POST' || method === 'PUT' || method === 'PATCH'
}

/** Send a bare error response and close. Used for framing problems that can
 *  be detected before the body is read. */
function sendErrorAndClose(c: Conn, status: number, message: string): void {
    const enc = new TextEncoder()
    const body = enc.encode(message + '\r\n')
    const headers = new HeadersImpl([
        ['Content-Type', 'text/plain; charset=utf-8'],
        ['Content-Length', String(body.length)],
        ['Connection', 'close'],
    ])
    c.keepAlive = false
    c.closeAfterFlush = true
    queueSend(c, buildHead(status, STATUS_TEXT[status] || 'Error', headers))
    queueSend(c, body)
    if (c.outQueue && c.outQueue.length > 0) flushQueue(c)
    else finishResponse(c)
}

function tryProcess(c: Conn): void {
    if (c.closed || c.current) return

    // Headers are checked against `partsLen` per read event, so a full
    // concatenation only happens once here, when the header block is complete.
    const buf = whole(c)
    const headerEnd = findCrLfCrLf(buf)
    if (headerEnd < 0) return
    const absEnd = headerEnd + 4
    const headerStr = new TextDecoder('utf-8').decode(buf.subarray(0, absEnd))
    const parsed = parseHeader(headerStr)
    if (!parsed) { closeConn(c); return }

    // A method that may carry a body but declares no framing never says where
    // the body ends, so refuse rather than guess (RFC 7230 §6.6.3). Without
    // this the only delimiter left would be the FIN.
    if (parsed.contentLength === 0 && !parsed.chunked && methodHasBody(parsed.method)) {
        sendErrorAndClose(c, 411, 'Length Required')
        return
    }

    const bodyStart = absEnd
    const tail = buf.length > bodyStart ? buf.subarray(bodyStart) : new Uint8Array(0)
    const hasBody = parsed.chunked || parsed.contentLength > 0
    // With a body, the buffered bytes belong to the body source, not to the
    // next request, so the header buffer is dropped here and only repopulated
    // when `finishBody` hands back the surplus.
    c.parts = hasBody ? [] : [tail]
    c.partsLen = hasBody ? 0 : tail.length

    dispatchRequest(c, parsed, hasBody ? makeBodyStream(c, parsed, tail) : undefined)
}

function dispatchRequest(c: Conn, parsed: ParsedHeader, body: ReadableStream<Uint8Array> | undefined): void {
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

    const ac = new AbortController()
    const req = new RequestImpl(url, {
        method: parsed.method,
        headers: new HeadersImpl(parsed.headers),
        body: body,
        signal: ac.signal,
    })

    c.ac = ac
    c.current = { req }
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
    // A request body the handler never drained still has bytes sitting in the
    // socket, which would desynchronize the next request on this connection.
    // Closing is always safe; it only forfeits keep-alive for such handlers
    // (e.g. a proxy that answers `new Response(req.body)`).
    if (c.body) c.keepAlive = false
    try {
        await sendResponse(c, req.method, res)
    } catch (e) {
        console.error('[http-server] response send error:', e)
        if (!c.closed) closeConn(c)
        return
    }
    if (c.closed) return

    c.current = null
    if (!c.closeAfterFlush) tryProcess(c)
}

function buildHead(status: number, statusText: string, headers: HeadersImpl): Uint8Array {
    let head = 'HTTP/1.1 ' + status + ' ' + statusText + '\r\n'
    for (const [name, value] of headers) head += name + ': ' + value + '\r\n'
    head += '\r\n'
    return new TextEncoder().encode(head)
}

async function sendResponse(c: Conn, method: string, res: Response): Promise<void> {
    const status = res.status
    const statusText = res.statusText || STATUS_TEXT[status] || 'OK'
    const headers = new HeadersImpl(res.headers)

    const headOnly = method === 'HEAD'
    const bodyless = (status >= 100 && status < 200) || status === 204 || status === 304

    if (!headers.has('connection')) headers.set('Connection', c.keepAlive ? 'keep-alive' : 'close')
    const connHdr = (headers.get('connection') || '').toLowerCase()
    if (!c.keepAlive || connHdr === 'close') c.closeAfterFlush = true

    if (bodyless) {
        headers.delete('Transfer-Encoding')
        headers.delete('Content-Length')
        headers.delete('Trailer')
        queueSend(c, buildHead(status, statusText, headers))
        finishResponse(c)
        return
    }

    if (headOnly) {
        headers.delete('Transfer-Encoding')
        headers.delete('Trailer')
        if (!headers.has('content-length')) {
            try {
                const full = await _readStream(res.body)
                headers.set('Content-Length', String(full.length))
            } catch { /* leave length unspecified */ }
        }
        if (c.closed) return
        queueSend(c, buildHead(status, statusText, headers))
        finishResponse(c)
        return
    }

    // Body is streamed out chunk by chunk. A declared Content-Length sends
    // the bytes as-is; otherwise we use chunked framing.
    const chunked = (headers.get('transfer-encoding') || '').toLowerCase() === 'chunked' ||
        !headers.has('content-length')
    // Trailing headers are only emitted when the body is chunk-framed and a
    // `Trailer` declaration header is present (Node addTrailers semantics).
    const trailerDeclared = (headers.get('trailer') || '').trim().length > 0
    if (chunked) {
        headers.delete('Content-Length')
        if (!headers.has('transfer-encoding')) headers.set('Transfer-Encoding', 'chunked')
        if (!trailerDeclared) headers.delete('Trailer')
    } else {
        headers.delete('Transfer-Encoding')
        headers.delete('Trailer')
    }
    queueSend(c, buildHead(status, statusText, headers))
    await writeStreamingBody(c, res.body, chunked, (chunked && trailerDeclared) ? res.trailers : undefined)
}
