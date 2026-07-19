import '../lib/polyfill.js'
import './stream.js'
import * as sock from 'sock'
import * as wolfssl from 'wolfssl'
import * as brotli from 'brotli'
import { parseIni, toIni } from '../lib/cache-utils.js'

function _concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    if (parts.length === 0) return new Uint8Array(0)
    let totalLen = 0
    for (const p of parts) totalLen += p.length
    const result = new Uint8Array(totalLen)
    let offset = 0
    for (const p of parts) { result.set(p, offset); offset += p.length }
    return result
}

function _toReadableStream(body: BodyInit): ReadableStream<Uint8Array> {
    if (body instanceof ReadableStream) return body
    const bytes = (typeof body === 'string')
        ? new TextEncoder().encode(body)
        : (body instanceof ArrayBuffer)
            ? new Uint8Array(body)
            : new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    return new ReadableStream<Uint8Array>({
        start(ctrl) {
            ctrl.enqueue(bytes)
            ctrl.close()
        }
    })
}

async function _readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
    }
    return _concat(chunks)
}

function _hasChunkedEnd(data: Uint8Array): boolean {
    if (data.length < 7) return false
    let i = data.length - 7
    return data[i] === 0x0D && data[i+1] === 0x0A && data[i+2] === 0x30 && data[i+3] === 0x0D && data[i+4] === 0x0A && data[i+5] === 0x0D && data[i+6] === 0x0A
}

function decodeChunked(data: Uint8Array): Uint8Array {
    const chunks: Uint8Array[] = []
    let pos = 0
    while (pos < data.length) {
        let crlf = -1
        for (let i = pos; i < data.length - 1; i++) {
            if (data[i] === 0x0D && data[i + 1] === 0x0A) { crlf = i; break }
        }
        if (crlf < 0) break

        let size = 0
        for (let i = pos; i < crlf; i++) {
            const b = data[i]!
            if (b >= 0x30 && b <= 0x39) size = size * 16 + (b - 0x30)
            else if (b >= 0x41 && b <= 0x46) size = size * 16 + (b - 0x37)
            else if (b >= 0x61 && b <= 0x66) size = size * 16 + (b - 0x57)
            else break
        }

        const dataStart = crlf + 2
        if (size === 0) {
            for (let i = dataStart; i < data.length - 3; i++) {
                if (data[i] === 0x0D && data[i+1] === 0x0A && data[i+2] === 0x0D && data[i+3] === 0x0A) {
                    pos = i + 4; break
                }
            }
            if (pos === dataStart) break
            break
        }

        if (dataStart + size > data.length) break
        chunks.push(data.subarray(dataStart, dataStart + size))
        pos = dataStart + size + 2
    }
    return _concat(chunks)
}

// ── Headers ──

// Flat array storage: [name0, value0, name1, value1, ...]
// Pairs at even/odd indices. Strings are immutable, so [...this._headers] is a correct deep copy.

class HeadersImpl {
    private _headers: string[] = []

    constructor(init?: HeadersInit) {
        if (init) {
            if (init instanceof HeadersImpl) {
                this._headers = [...init._headers]
            } else if (Array.isArray(init)) {
                this._headers = init.flatMap(([k, v]) => [k.toLowerCase(), v])
            } else if (typeof init === 'object') {
                this._headers = Object.entries(init).flatMap(([k, v]) => [k.toLowerCase(), v])
            }
        }
    }

    append(name: string, value: string): void {
        this._headers.push(name.toLowerCase(), value)
    }

    delete(name: string): void {
        const key = name.toLowerCase()
        const h = this._headers
        let i = h.length - 2
        while (i >= 0) {
            if (h[i] === key) { h.splice(i, 2); i -= 2 } else i -= 2
        }
    }

    get(name: string): string | null {
        const key = name.toLowerCase()
        const matches = [...this.entries()].filter(([k]) => k === key).map(([, v]) => v)
        return matches.length ? matches.join(', ') : null
    }

    has(name: string): boolean {
        return [...this.keys()].includes(name.toLowerCase())
    }

    set(name: string, value: string): void {
        const key = name.toLowerCase()
        const h = this._headers
        let found = false
        let i = h.length - 2
        while (i >= 0) {
            if (h[i] === key) {
                if (!found) {
                    h[i + 1] = value
                    found = true
                } else {
                    h.splice(i, 2)
                }
            }
            i -= 2
        }
        if (!found) h.push(key, value)
    }

    forEach(callback: (value: string, name: string, headers: HeadersImpl) => void): void {
        for (const [name, value] of this) {
            callback(value, name, this)
        }
    }

    *entries(): IterableIterator<[string, string]> {
        const h = this._headers
        for (let i = 0; i < h.length; i += 2) {
            yield [h[i]!, h[i + 1]!]
        }
    }

    *keys(): IterableIterator<string> {
        for (const [k] of this) yield k
    }

    *values(): IterableIterator<string> {
        for (const [, v] of this) yield v
    }

    [Symbol.iterator](): IterableIterator<[string, string]> {
        return this.entries()
    }
}

// ── Request ──

class RequestImpl {
    readonly url: string
    readonly method: string
    readonly headers: HeadersImpl
    private _body: ReadableStream<Uint8Array> | null
    readonly redirect: RequestRedirect
    readonly timeout: number
    readonly maxRedirects: number
    private _bodyConsumed: boolean = false
    readonly integrity: string = ''
    readonly keepalive: boolean = false
    readonly mode: string = 'cors'
    readonly cache: string = 'default'
    readonly credentials: string = 'same-origin'
    readonly referrer: string = 'about:client'
    readonly referrerPolicy: string = ''
    readonly signal: AbortSignal | null = null
    readonly destination: string = ''

    get body(): ReadableStream<Uint8Array> | null { return this._body }

    get bodyUsed(): boolean {
        return this._bodyConsumed || (this._body?.locked ?? false)
    }

    constructor(input: string | RequestImpl, init: RequestInit = {}) {
        const initBody = init.body
        if (input instanceof RequestImpl) {
            this.url = input.url
            this.method = init.method || input.method
            this.headers = new HeadersImpl(init.headers || input.headers)
            if (initBody !== undefined && initBody !== null) {
                this._body = _toReadableStream(initBody)
            } else {
                this._body = input._body
            }
            this.redirect = init.redirect || input.redirect
            this.timeout = init.timeout || input.timeout
            this.maxRedirects = init.maxRedirects || input.maxRedirects
        } else {
            this.url = input
            this.method = init.method || 'GET'
            this.headers = new HeadersImpl(init.headers)
            this._body = initBody !== null && initBody !== undefined ? _toReadableStream(initBody) : null
            this.redirect = init.redirect || 'follow'
            this.timeout = init.timeout || 30000
            this.maxRedirects = init.maxRedirects || 5
        }
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        if (!this.body) return new ArrayBuffer(0)
        if (this._bodyConsumed) throw new TypeError('Body already used')
        this._bodyConsumed = true
        const bytes = await _readStream(this.body)
        return bytes.buffer
    }

    async json(): Promise<any> {
        return JSON.parse(await this.text())
    }

    async text(): Promise<string> {
        if (!this.body) return ''
        if (this._bodyConsumed) throw new TypeError('Body already used')
        this._bodyConsumed = true
        const bytes = await _readStream(this.body)
        return new TextDecoder('utf-8').decode(bytes)
    }

    clone(): RequestImpl {
        if (this.bodyUsed) throw new TypeError('Body already used')
        if (this._body) {
            const [branch1, branch2] = this._body.tee()
            this._body = branch1
            const req = new RequestImpl(this.url, {
                method: this.method,
                headers: this.headers,
                body: branch2,
                redirect: this.redirect,
                timeout: this.timeout,
                maxRedirects: this.maxRedirects,
            })
            return req
        }
        return new RequestImpl(this.url, {
            method: this.method,
            headers: this.headers,
            redirect: this.redirect,
            timeout: this.timeout,
            maxRedirects: this.maxRedirects,
        })
    }
}

// ── Response ──

class ResponseImpl {
    readonly status: number
    readonly statusText: string
    readonly ok: boolean

    private _headers: HeadersImpl
    _redirected: boolean = false
    private _type: ResponseType = 'basic'
    _url: string = ''
    private _body: ReadableStream<Uint8Array>
    private _bodyConsumed: boolean = false

    get body(): ReadableStream<Uint8Array> { return this._body }
    get bodyUsed(): boolean { return this._bodyConsumed || this._body.locked }
    get headers(): HeadersImpl { return this._headers }
    get redirected(): boolean { return this._redirected }
    get type(): ResponseType { return this._type }
    get url(): string { return this._url }

    constructor(body?: BodyInit | null, init?: ResponseInit) {
        const status = init?.status ?? 200
        const statusText = init?.statusText ?? ''
        const headers = new HeadersImpl(init?.headers)
        this.status = status
        this.statusText = statusText
        this._headers = headers
        this.ok = status >= 200 && status < 300
        this._body = body != null ? _toReadableStream(body) : new ReadableStream<Uint8Array>({
            start(ctrl) { ctrl.close() }
        })
    }

    async text(): Promise<string> {
        if (this.bodyUsed) throw new TypeError('Body already used')
        this._bodyConsumed = true
        const bytes = await _readStream(this._body)
        return new TextDecoder('utf-8').decode(bytes)
    }

    async json(): Promise<any> {
        return JSON.parse(await this.text())
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        if (this.bodyUsed) throw new TypeError('Body already used')
        this._bodyConsumed = true
        const bytes = await _readStream(this._body)
        return bytes.buffer
    }

    async bytes(): Promise<Uint8Array> {
        if (this.bodyUsed) throw new TypeError('Body already used')
        this._bodyConsumed = true
        return await _readStream(this._body)
    }

    clone(): Response {
        if (this.bodyUsed) throw new TypeError('Body already used')
        const [branch1, branch2] = this._body.tee()
        this._body = branch1
        return new ResponseImpl(branch2, { status: this.status, statusText: this.statusText, headers: this._headers })
    }

    _applyDecompressedBody(stream: ReadableStream<Uint8Array>, _body: ArrayBuffer, newHeaders: HeadersImpl): void {
        this._bodyConsumed = false
        this._body = stream
        this._headers = newHeaders
    }
}

// ── HTTP Response Parser ──

interface ParsedResponse {
    status: number
    statusText: string
    headers: HeadersImpl
}

function parseHeaders(data: string): ParsedResponse | null {
    const headerEnd = data.indexOf('\r\n\r\n')
    if (headerEnd < 0) return null

    const headerPart = data.slice(0, headerEnd)
    const lines = headerPart.split('\r\n')
    const statusLine = lines[0]!
    const match = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)\s+(.*)$/)
    if (!match) throw new Error('Invalid HTTP response: ' + statusLine)

    const status = parseInt(match[1]!, 10)
    const statusText = match[2]!

    const headers = new HeadersImpl()
    for (let i = 1; i < lines.length; i++) {
        const colonIndex = lines[i]!.indexOf(':')
        if (colonIndex > 0) {
            const name = lines[i]!.slice(0, colonIndex).trim()
            const value = lines[i]!.slice(colonIndex + 1).trim()
            headers.append(name, value)
        }
    }

    return { status, statusText, headers }
}

// ── State machine constants ──

const ST_CONNECTING = 0
const ST_HANDSHAKE = 1
const ST_RECV_HEADERS = 3
const ST_RECV_BODY = 4
const ST_DONE = 5

// ── Main fetch request ──

async function fetchRequest(req: RequestImpl): Promise<ResponseImpl> {
    const parsedUrl = new URL(req.url)
    const method = req.method
    const headers = new HeadersImpl(req.headers)
    const timeout = req.timeout || 30000
    const isHTTPS = parsedUrl.protocol === 'https:'

    const defaultPort = isHTTPS ? 443 : 80
    const hostname = parsedUrl.hostname.includes(':') ? `[${parsedUrl.hostname}]` : parsedUrl.hostname
    const hostHeader = parsedUrl.port && parsedUrl.port !== String(defaultPort)
        ? hostname + ':' + parsedUrl.port
        : hostname
    if (!headers.has('host')) headers.set('Host', hostHeader)
    if (!headers.has('user-agent')) headers.set('User-Agent', 'QuickJS/1.0')
    if (!headers.has('connection')) headers.set('Connection', 'close')
    if (!headers.has('accept-encoding')) headers.set('Accept-Encoding', 'br')
    let bodyBytes: Uint8Array | null = null
    if (req.body) {
        bodyBytes = await _readStream(req.body)
    }
    if (bodyBytes && !headers.has('content-length')) headers.set('Content-Length', String(bodyBytes.length))

    return new Promise((resolve, reject) => {
    let request = method + ' ' + parsedUrl.pathname + (parsedUrl.search || '') + ' HTTP/1.1\r\n'
    headers.forEach((value: string, name: string) => {
        request += name + ': ' + value + '\r\n'
    })
    request += '\r\n'

    const requestBytes = new TextEncoder().encode(request)
    const httpRequest = _concat(
        bodyBytes ? [requestBytes, bodyBytes] : [requestBytes]
    ).buffer

    let s: sock.SockHandle | null = null
    let ssl: wolfssl.WOLFSSL | null = null
    let ctx: wolfssl.WOLFSSL_CTX | null = null
    let state = ST_CONNECTING
    let resolved = false
    let timerId: TimerId | undefined
    let stream: ReadableStream<Uint8Array> | null = null
    let _controller: ReadableStreamDefaultController<Uint8Array> | null = null
    let headerRaw: Uint8Array = new Uint8Array(0)
    let isChunked = false
    let contentLength = 0
    let chunkedParts: Uint8Array[] = []
    let receivedBytes = 0

        const cleanupSocket = (): void => {
            state = ST_DONE
            if (ssl) { wolfssl.wolfSSL_free(ssl); ssl = null }
            if (ctx) { wolfssl.wolfSSL_CTX_free(ctx); ctx = null }
            if (s !== null && s >= 0) { sock.closesocket(s); s = null }
        }

        const cleanup = (): void => {
            if (timerId) { clearTimeout(timerId); timerId = undefined }
        }

        const doResolve = (response: ResponseImpl): void => {
            if (!resolved) { resolved = true; cleanup(); resolve(response) }
        }

        const doReject = (error: Error): void => {
            if (!resolved) { resolved = true; cleanup(); cleanupSocket(); reject(error) }
        }

        timerId = setTimeout(() => {
            doReject(new Error('Request timeout'))
        }, timeout)

        s = sock.socket()
        if (s < 0) { doReject(new Error('Failed to create socket')); return }
        const fd = s

        sock.set_on_event(fd, (event: { lNetworkEvents: number; iErrorCode: number[] }) => {
            if (state === ST_DONE) return

            if (event.lNetworkEvents & sock.FdEvent.FD_CONNECT) {
                const err = event.iErrorCode[0]
                if (err !== 0) { doReject(new Error('Connection failed: ' + err)); return }

                if (isHTTPS) {
                    const tlsMethod = wolfssl.wolfTLSv1_2_client_method()
                    ctx = wolfssl.wolfSSL_CTX_new(tlsMethod)
                    if (!ctx) { doReject(new Error('SSL_CTX_new failed')); return }
                    wolfssl.wolfSSL_CTX_set_verify(ctx, wolfssl.VerifyMode.SSL_VERIFY_NONE)
                    ssl = wolfssl.wolfSSL_new(ctx)
                    if (!ssl) { doReject(new Error('SSL_new failed')); return }
                    wolfssl.wolfSSL_set_fd(ssl, sock.get_fd(fd))
                    if (parsedUrl.hostname) wolfssl.wolfSSL_UseSNI(ssl, wolfssl.SniType.WOLFSSL_SNI_HOST_NAME, parsedUrl.hostname)
                    state = ST_HANDSHAKE
                } else {
                    sock.send(fd, httpRequest)
                    state = ST_RECV_HEADERS
                }
            }

            if ((event.lNetworkEvents & sock.FdEvent.FD_READ) || (event.lNetworkEvents & sock.FdEvent.FD_WRITE)) {
                if (state === ST_HANDSHAKE) {
                    if (!ssl) { doReject(new Error('TLS not initialized')); return }
                    const ret = wolfssl.wolfSSL_connect(ssl)
                    if (ret === wolfssl.ReturnCode.SSL_SUCCESS) {
                        wolfssl.wolfSSL_write(ssl, httpRequest)
                        state = ST_RECV_HEADERS
                    } else {
                        const err = wolfssl.wolfSSL_get_error(ssl, ret)
                        if (err !== wolfssl.ErrorCode.WOLFSSL_ERROR_WANT_READ &&
                            err !== wolfssl.ErrorCode.WOLFSSL_ERROR_WANT_WRITE) {
                            doReject(new Error('TLS handshake failed: ' + err))
                        }
                    }
                }
                else if (state === ST_RECV_HEADERS) {
                    while (true) {
                        if (s !== null && s < 0 && !ssl) break
                        let data: ArrayBuffer | null
                        if (isHTTPS && ssl) {
                            data = wolfssl.wolfSSL_read(ssl, 8192)
                        } else if (s !== null && s >= 0) {
                            data = sock.recv(s, 8192)
                        } else { break }
                        if (!data || data.byteLength === 0) break
                        const incoming = new Uint8Array(data)
                        headerRaw = _concat([headerRaw, incoming])

                        let headerEnd = -1
                        for (let i = 0; i < headerRaw.length - 3; i++) {
                            if (headerRaw[i] === 0x0D && headerRaw[i+1] === 0x0A && headerRaw[i+2] === 0x0D && headerRaw[i+3] === 0x0A) {
                                headerEnd = i; break
                            }
                        }
                        if (headerEnd >= 0) {
                            const headerStr = new TextDecoder('utf-8').decode(headerRaw.subarray(0, headerEnd + 4))
                            const parsed = parseHeaders(headerStr)
                            if (!parsed) { doReject(new Error('Failed to parse HTTP headers')); return }

                            const trailingBodyBytes = headerRaw.subarray(headerEnd + 4)

                            isChunked = (parsed.headers.get('transfer-encoding') || '').toLowerCase().includes('chunked')
                            contentLength = isChunked ? 0 : parseInt(
                                parsed.headers.get('content-length') || '0', 10
                            )
                            _controller = null
                            stream = new ReadableStream<Uint8Array>({
                                start(ctrl: ReadableStreamDefaultController<Uint8Array>) { _controller = ctrl },
                                cancel() { cleanup(); cleanupSocket() }
                            })
                            if (trailingBodyBytes.length > 0) {
                                if (isChunked) {
                                    chunkedParts = [trailingBodyBytes]
                                    if (_hasChunkedEnd(trailingBodyBytes)) {
                                        const decoded = decodeChunked(trailingBodyBytes)
                                        _controller!.enqueue(decoded)
                                        _controller!.close()
                                        state = ST_DONE
                                    }
                                } else {
                                    receivedBytes += trailingBodyBytes.length
                                    _controller!.enqueue(trailingBodyBytes)
                                    if (contentLength > 0 && receivedBytes >= contentLength) {
                                        _controller!.close()
                                    }
                                }
                            }

                            const response = new ResponseImpl(
                                stream, { status: parsed.status, statusText: parsed.statusText, headers: parsed.headers }
                            )
                            if (state !== ST_DONE) {
                                state = ST_RECV_BODY
                            }
                            doResolve(response)
                            // Break out of header recv loop — any remaining data
                            // in the socket will be handled by the ST_RECV_BODY path below
                            break
                        }
                    }
                }
                else if (state === ST_RECV_BODY && stream) {
                    while (true) {
                        if (s !== null && s < 0 && !ssl) break
                        let data: ArrayBuffer | null
                        if (isHTTPS && ssl) {
                            data = wolfssl.wolfSSL_read(ssl, 8192)
                        } else if (s !== null && s >= 0) {
                            data = sock.recv(s, 8192)
                        } else { break }
                        if (!data || data.byteLength === 0) break
                        if (isChunked) {
                            chunkedParts.push(new Uint8Array(data))
                            const combined = _concat(chunkedParts)
                            if (_hasChunkedEnd(combined)) {
                                const decoded = decodeChunked(combined)
                                _controller!.enqueue(decoded)
                                _controller!.close()
                                stream = null
                                state = ST_DONE
                                break
                            }
                        } else {
                            receivedBytes += data.byteLength
                            _controller!.enqueue(new Uint8Array(data))
                            if (contentLength > 0 && receivedBytes >= contentLength) {
                                _controller!.close()
                            }
                        }
                    }
                }
            }

            if (event.lNetworkEvents & sock.FdEvent.FD_CLOSE) {
                if (state === ST_DONE) return
                if (state === ST_RECV_HEADERS) {
                    doReject(new Error('Connection closed before response'))
                } else if (state === ST_RECV_BODY && stream) {
                    let remainingParts: Uint8Array[] = []
                    while (true) {
                        if (s !== null && s < 0 && !ssl) break
                        let data: ArrayBuffer | null
                        if (isHTTPS && ssl) {
                            data = wolfssl.wolfSSL_read(ssl, 8192)
                        } else if (s !== null && s >= 0) {
                            data = sock.recv(s, 8192)
                        } else { break }
                        if (!data || data.byteLength === 0) break
                        remainingParts.push(new Uint8Array(data))
                    }
                    if (isChunked) {
                        chunkedParts.push(...remainingParts)
                        const decoded = decodeChunked(_concat(chunkedParts))
                        _controller!.enqueue(decoded)
                    } else if (remainingParts.length > 0) {
                        _controller!.enqueue(_concat(remainingParts))
                    }
                    _controller!.close()
                    stream = null
                    state = ST_DONE
                }
            }
        })

        const ip = sock.resolve(parsedUrl.hostname)
        if (!ip) {
            doReject(new Error('DNS resolution failed for: ' + parsedUrl.hostname))
            return
        }
        sock.connect(s, ip, parseInt(parsedUrl.port, 10) || (isHTTPS ? 443 : 80))
    })
}

// ── Public fetch (with redirect handling and caching) ──

function parseMaxAge(cc: string): number {
    const m = cc.match(/max-age=(\d+)/)
    return m ? parseInt(m[1]!, 10) : 0
}

interface CacheMeta {
    storedAt: number;
    maxAge: number;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    etag?: string;
    lastModified?: string;
}

async function doFetch(url: string | Request, init: RequestInit, redirectCount: number): Promise<ResponseImpl> {
    let req = new RequestImpl(url, init)
    const redirectMode = req.redirect || 'follow'
    const maxRedirects = redirectMode === 'follow' ? (req.maxRedirects || 5) : 0
    const cache = typeof __httpCache__ !== 'undefined' ? __httpCache__ : null
    const method = req.method
    const currentUrl = req.url

    // ── Cache lookup (GET only) ──
    let cachedMeta: CacheMeta | null = null

    if (cache && method === 'GET') {
        const metaStr = cache.readMeta(currentUrl)
        if (metaStr) {
            const ini = parseIni(metaStr)
            cachedMeta = {
                storedAt: parseInt(ini.meta.storedAt || '0', 10),
                maxAge: parseInt(ini.meta.maxAge || '0', 10),
                status: parseInt(ini.meta.status || '200', 10),
                statusText: ini.meta.statusText || 'OK',
                headers: ini.headers,
                etag: ini.headers['etag'] || undefined,
                lastModified: ini.headers['last-modified'] || undefined,
            }
            const age = Math.floor(Date.now() / 1000) - cachedMeta.storedAt
            if (cachedMeta.maxAge > 0 && age < cachedMeta.maxAge) {
                const body = cache.readBody(currentUrl)
                if (body) {
                    ini.meta.lastAccess = String(Math.floor(Date.now() / 1000))
                    cache.writeMeta(currentUrl, toIni(ini.headers, ini.meta))
                    const resp = new ResponseImpl(
                        _toReadableStream(new Uint8Array(body)), { status: cachedMeta.status, statusText: cachedMeta.statusText, headers: new HeadersImpl(cachedMeta.headers || {}) }
                    )
                    resp._url = currentUrl
                    return resp
                }
            }
            if (cachedMeta.etag) req.headers.set('If-None-Match', cachedMeta.etag)
            if (cachedMeta.lastModified) req.headers.set('If-Modified-Since', cachedMeta.lastModified)
        }
    }

    const response = await fetchRequest(req)

    response._url = currentUrl

    // ── Handle brotli Content-Encoding ──
    const contentEncoding = response.headers.get('content-encoding') || ''
    if (contentEncoding.includes('br')) {
        const compressedBody = await response.arrayBuffer()
        const decompressedBody = brotli.decompress(compressedBody)
        const newHeaders = new HeadersImpl()
        response.headers.forEach((v: string, k: string) => {
            if (k !== 'content-encoding') newHeaders.set(k, v)
        })
        newHeaders.set('content-length', String(decompressedBody.byteLength))
        const stream = _toReadableStream(new Uint8Array(decompressedBody))
        response._applyDecompressedBody(stream, decompressedBody, newHeaders)
    }

    // ── Handle 304 Not Modified ──
    if (response.status === 304 && cachedMeta && cache) {
        const body = cache.readBody(currentUrl)
        if (body) {
            cachedMeta.storedAt = Math.floor(Date.now() / 1000)
            response.headers.forEach((value: string, name: string) => {
                cachedMeta.headers[name] = value
            })
            const now = String(Math.floor(Date.now() / 1000))
            const iniMeta: Record<string, string> = {
                url: currentUrl,
                storedAt: String(cachedMeta.storedAt),
                maxAge: String(cachedMeta.maxAge),
                lastAccess: now,
                status: String(cachedMeta.status),
                statusText: cachedMeta.statusText,
            }
            cache.writeMeta(currentUrl, toIni(cachedMeta.headers, iniMeta))
            const resp = new ResponseImpl(
                _toReadableStream(new Uint8Array(body)), { status: cachedMeta.status, statusText: cachedMeta.statusText, headers: new HeadersImpl(cachedMeta.headers) }
            )
            resp._url = currentUrl
            return resp
        }
    }

    // ── Cache 200 GET responses ──
    if (cache && method === 'GET' && response.status === 200) {
        const body = await response.arrayBuffer()
        const cc = response.headers.get('cache-control') || ''
        const maxAge = parseMaxAge(cc)
        if (maxAge > 0) {
            const resHeaders = Object.fromEntries(response.headers)
            const now = String(Math.floor(Date.now() / 1000))
            const iniMeta: Record<string, string> = {
                url: currentUrl,
                storedAt: now,
                maxAge: String(maxAge),
                lastAccess: now,
                status: String(response.status),
                statusText: response.statusText,
            }
            cache.writeBodyOnly(currentUrl, body)
            cache.writeMeta(currentUrl, toIni(resHeaders, iniMeta))
        }
        const resp = new ResponseImpl(
            _toReadableStream(new Uint8Array(body)), { status: response.status, statusText: response.statusText, headers: response.headers }
        )
        resp._url = currentUrl
        return resp
    }

    // ── Redirect handling ──
    const isRedirect = response.status === 301 || response.status === 302 ||
                      response.status === 303 || response.status === 307 || response.status === 308

    if (isRedirect) {
        if (redirectMode === 'error') {
            response.body.cancel('redirect')
            throw new TypeError('Redirect not allowed for: ' + currentUrl)
        }
        if (redirectMode === 'manual') {
            response._redirected = true
            return response
        }
        if (redirectCount >= maxRedirects) {
            response.body.cancel('redirect')
            throw new TypeError('Redirect count exceeded')
        }

        const location = response.headers.get('location')
        if (!location) throw new Error('Redirect response missing Location header')

        response.body.cancel('redirect')
        const newUrl = new URL(location, currentUrl).href
        const isGet = response.status === 301 || response.status === 302 || response.status === 303
        const newInit: RequestInit = {
            ...init,
            method: isGet ? 'GET' : req.method,
            headers: req.headers,
            body: isGet ? undefined : (req.body ?? undefined),
        }
        const result = await doFetch(newUrl, newInit, redirectCount + 1)
        result._redirected = true
        return result
    }

    if (redirectCount > 0) response._redirected = true
    return response
}

async function fetch(url: string | Request, init: RequestInit = {}): Promise<ResponseImpl> {
    return doFetch(url, init, 0)
}

// ── Global declarations ──

declare global {
    type HeadersInit = [string, string][] | Record<string, string> | Headers
    type BodyInit = ReadableStream<Uint8Array> | string | ArrayBuffer | ArrayBufferView
    type RequestRedirect = 'error' | 'follow' | 'manual'
    type RequestCache = 'default' | 'force-cache' | 'no-cache' | 'no-store' | 'only-if-cached' | 'reload'
    type RequestCredentials = 'include' | 'omit' | 'same-origin'
    type RequestMode = 'cors' | 'navigate' | 'no-cors' | 'same-origin'
    type ResponseType = 'basic' | 'cors' | 'default' | 'error' | 'opaque' | 'opaqueredirect'

    interface AbortSignal {
        readonly aborted: boolean;
        readonly reason: unknown;
        onabort: ((event: Event) => void) | null;
        throwIfAborted(): void;
    }

    interface RequestInit {
        body?: BodyInit | null;
        cache?: RequestCache;
        credentials?: RequestCredentials;
        headers?: HeadersInit;
        integrity?: string;
        keepalive?: boolean;
        method?: string;
        mode?: RequestMode;
        redirect?: RequestRedirect;
        referrer?: string;
        referrerPolicy?: string;
        signal?: AbortSignal | null;
        window?: null;
        timeout?: number;
        maxRedirects?: number;
    }

    interface ResponseInit {
        status?: number;
        statusText?: string;
        headers?: HeadersInit;
    }

    interface Headers extends HeadersImpl {}
    var Headers: typeof HeadersImpl
    interface Response extends Omit<ResponseImpl, '_url' | '_redirected' | '_applyDecompressedBody'> {}
    interface ResponseConstructor {
        new(body?: BodyInit | null, init?: ResponseInit): Response
    }
    var Response: ResponseConstructor
    interface Request extends RequestImpl {}
    var Request: typeof RequestImpl
    var fetch: (url: string | Request, init?: RequestInit) => Promise<Response>;
}

// ── Register globals ──

globalThis.fetch = fetch
globalThis.Response = ResponseImpl
globalThis.Request = RequestImpl
globalThis.Headers = HeadersImpl
