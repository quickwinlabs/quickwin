import '../lib/polyfill.js'
import * as sock from 'sock'
import * as wolfssl from 'wolfssl'
import * as os from 'os'
import * as brotli from 'brotli'

const setTimeout = os.setTimeout
const clearTimeout = os.clearTimeout

interface RequestOptions {
    method?: string
    headers?: { [key: string]: string }
    body?: string
    timeout?: number
    redirect?: 'follow' | 'manual' | 'error'
    maxRedirects?: number
}

function _concat(parts: Uint8Array[]): Uint8Array {
    if (parts.length === 0) return new Uint8Array(0)
    let totalLen = 0
    for (const p of parts) totalLen += p.length
    const result = new Uint8Array(totalLen)
    let offset = 0
    for (const p of parts) { result.set(p, offset); offset += p.length }
    return result
}

function _hasChunkedEnd(data: Uint8Array): boolean {
    for (let i = data.length - 7; i >= 0; i--) {
        if (data[i] === 0x0D && data[i+1] === 0x0A && data[i+2] === 0x30 && data[i+3] === 0x0D && data[i+4] === 0x0A && data[i+5] === 0x0D && data[i+6] === 0x0A) return true
    }
    return false
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
            const b = data[i]
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

// ── ReadableStream implementation ──

type ReadResult =
    | { done: true; value?: undefined }
    | { done: false; value: Uint8Array }

type PendingRead = { resolve: (result: ReadResult) => void, reject: (err: Error) => void }

class _QuickReadableStream {
    _chunks: Uint8Array[] = []
    _state: 'readable' | 'closed' | 'errored' = 'readable'
    _pendingRead: PendingRead | null = null
    _locked: boolean = false
    _sock: number | null
    _ssl: number | null
    _isHTTPS: boolean
    _cleanup: (() => void) | null
    _contentLength: number
    _receivedBytes: number = 0

    constructor(sock: number, ssl: number | null, isHTTPS: boolean, cleanup: () => void, contentLength: number = 0) {
        this._sock = sock
        this._ssl = ssl
        this._isHTTPS = isHTTPS
        this._cleanup = cleanup
        this._contentLength = contentLength
    }

    get locked(): boolean { return this._locked }

    getReader(): _QuickReader {
        if (this._locked) throw new TypeError('ReadableStream is locked')
        this._locked = true
        return new _QuickReader(this)
    }

    cancel(reason?: any): void {
        if (this._state !== 'readable') return
        this._state = 'closed'
        this._locked = false
        if (this._cleanup) {
            this._cleanup()
            this._cleanup = null
        }
        if (this._pendingRead) {
            const pr = this._pendingRead
            this._pendingRead = null
            pr.resolve({ done: true })
        }
    }

    // ── Internal methods called by socket handler ──

    _pushChunk(chunk: Uint8Array): void {
        if (this._state !== 'readable') return
        this._receivedBytes += chunk.length
        if (this._pendingRead) {
            const pr = this._pendingRead
            this._pendingRead = null
            pr.resolve({ done: false, value: chunk })
        } else {
            this._chunks.push(chunk)
        }
        // Auto-close if Content-Length is satisfied
        if (this._contentLength > 0 && this._receivedBytes >= this._contentLength) {
            this._close()
        }
    }

    _close(): void {
        if (this._state !== 'readable') return
        this._state = 'closed'
        if (this._cleanup) {
            this._cleanup()
            this._cleanup = null
        }
        if (this._pendingRead) {
            const pr = this._pendingRead
            this._pendingRead = null
            pr.resolve({ done: true })
        }
    }

    _error(err: Error): void {
        if (this._state !== 'readable') return
        this._state = 'errored'
        if (this._pendingRead) {
            const pr = this._pendingRead
            this._pendingRead = null
            pr.reject(err)
        }
    }

    _tryRead(): Promise<ReadResult> | null {
        if (this._chunks.length > 0) {
            const chunk = this._chunks.shift()!
            return Promise.resolve({ done: false, value: chunk })
        }
        if (this._state === 'closed') return Promise.resolve({ done: true })
        if (this._state === 'errored') return Promise.reject(new Error('Stream errored'))
        return null
    }
}

class _PreloadedStream {
    _buffer: Uint8Array
    _offset: number = 0
    _state: 'readable' | 'closed' = 'readable'
    _pendingRead: PendingRead | null = null
    _locked: boolean = false

    constructor(buffer: ArrayBuffer) {
        this._buffer = new Uint8Array(buffer)
    }

    get locked(): boolean { return this._locked }

    getReader() {
        if (this._locked) throw new TypeError('ReadableStream is locked')
        this._locked = true
        const stream = this
        return {
            read(): Promise<ReadResult> {
                if (stream._offset < stream._buffer.length) {
                    const chunk = stream._buffer.slice(stream._offset, stream._offset + 8192)
                    stream._offset += chunk.length
                    return Promise.resolve({ done: false, value: chunk })
                }
                return Promise.resolve({ done: true })
            },
            cancel(reason?: any): void {
                stream._state = 'closed'
                stream._locked = false
            },
            releaseLock(): void {
                // no-op
            }
        }
    }

    cancel(reason?: any): void {
        this._state = 'closed'
        this._locked = false
    }

    _tryRead(): Promise<ReadResult> | null {
        if (this._offset < this._buffer.length) {
            const chunk = this._buffer.slice(this._offset, this._offset + 8192)
            this._offset += chunk.length
            return Promise.resolve({ done: false, value: chunk })
        }
        if (this._state === 'closed') return Promise.resolve({ done: true })
        return null
    }
}

class _QuickReader {
    _stream: _QuickReadableStream | null

    constructor(stream: _QuickReadableStream) {
        this._stream = stream
    }

    read(): Promise<ReadResult> {
        if (!this._stream) throw new TypeError('Reader released')
        const result = this._stream._tryRead()
        if (result) return result
        return new Promise((resolve, reject) => {
            if (!this._stream) { reject(new TypeError('Reader released')); return }
            this._stream._pendingRead = { resolve, reject }
        })
    }

    cancel(reason?: any): void {
        if (this._stream) {
            this._stream.cancel(reason)
            this._stream = null
        }
    }

    releaseLock(): void {
        this._stream = null
    }
}

// ── Headers ──

class FetchHeaders {
    private _headers: { [key: string]: string } = {}

    constructor(init?: { [key: string]: string } | FetchHeaders) {
        if (init) {
            if (init instanceof FetchHeaders) {
                this._headers = { ...init._headers }
            } else if (typeof init === 'object') {
                for (const key in init) {
                    this._headers[key.toLowerCase()] = init[key]
                }
            }
        }
    }

    append(name: string, value: string): void {
        const key = name.toLowerCase()
        if (this._headers[key]) {
            this._headers[key] += ', ' + value
        } else {
            this._headers[key] = value
        }
    }

    delete(name: string): void {
        delete this._headers[name.toLowerCase()]
    }

    get(name: string): string | null {
        return this._headers[name.toLowerCase()] || null
    }

    has(name: string): boolean {
        return name.toLowerCase() in this._headers
    }

    set(name: string, value: string): void {
        this._headers[name.toLowerCase()] = value
    }

    forEach(callback: (value: string, name: string, headers: FetchHeaders) => void): void {
        for (const key in this._headers) {
            callback(this._headers[key], key, this)
        }
    }

    entries(): IterableIterator<[string, string]> {
        const entries: [string, string][] = []
        for (const key in this._headers) {
            entries.push([key, this._headers[key]])
        }
        return entries[Symbol.iterator]() as IterableIterator<[string, string]>
    }

    keys(): IterableIterator<string> {
        return Object.keys(this._headers)[Symbol.iterator]() as IterableIterator<string>
    }

    values(): IterableIterator<string> {
        const values: string[] = []
        for (const key in this._headers) {
            values.push(this._headers[key])
        }
        return values[Symbol.iterator]() as IterableIterator<string>
    }

    [Symbol.iterator](): IterableIterator<[string, string]> {
        return this.entries()
    }
}

// ── Request ──

class FetchRequest {
    readonly url: string
    readonly method: string
    readonly headers: FetchHeaders
    readonly body: string | null
    readonly redirect: 'follow' | 'manual' | 'error'
    readonly timeout: number
    readonly maxRedirects: number

    constructor(input: string | FetchRequest, init: RequestInit = {}) {
        if (input instanceof FetchRequest) {
            this.url = input.url
            this.method = init.method || input.method
            this.headers = new FetchHeaders(init.headers || input.headers)
            this.body = init.body !== undefined ? init.body : input.body
            this.redirect = init.redirect || input.redirect
            this.timeout = init.timeout || input.timeout
            this.maxRedirects = init.maxRedirects || input.maxRedirects
        } else {
            this.url = input
            this.method = init.method || 'GET'
            this.headers = new FetchHeaders(init.headers)
            this.body = init.body || null
            this.redirect = init.redirect || 'follow'
            this.timeout = init.timeout || 30000
            this.maxRedirects = init.maxRedirects || 5
        }
    }
}

// ── Response ──

class FetchResponse {
    readonly status: number
    readonly statusText: string
    readonly headers: FetchHeaders
    readonly ok: boolean
    redirected: boolean
    type: string
    url: string
    body: _QuickReadableStream
    private _bodyConsumed: boolean = false
    _preloadedBody: ArrayBuffer | null = null

    get bodyUsed(): boolean {
        return this._bodyConsumed || this.body.locked
    }

    constructor(status: number, statusText: string, headers: FetchHeaders, bodyStream: _QuickReadableStream) {
        this.status = status
        this.statusText = statusText
        this.headers = headers
        this.ok = status >= 200 && status < 300
        this.redirected = false
        this.type = 'basic'
        this.url = ''
        this.body = bodyStream
    }

    async text(): Promise<string> {
        if (this._preloadedBody) {
            if (this._bodyConsumed) throw new TypeError('Body already used')
            this._bodyConsumed = true
            return new TextDecoder('utf-8').decode(this._preloadedBody)
        }
        if (this.bodyUsed) throw new TypeError('Body already used')
        this._bodyConsumed = true
        const reader = this.body.getReader()
        const chunks: Uint8Array[] = []
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
        }
        return new TextDecoder('utf-8').decode(_concat(chunks))
    }

    async json(): Promise<any> {
        const text = await this.text()
        return JSON.parse(text)
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        if (this._preloadedBody) {
            if (this._bodyConsumed) throw new TypeError('Body already used')
            this._bodyConsumed = true
            return this._preloadedBody
        }
        if (this.bodyUsed) throw new TypeError('Body already used')
        this._bodyConsumed = true
        const reader = this.body.getReader()
        const chunks: Uint8Array[] = []
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
        }
        const combined = _concat(chunks)
        return combined.buffer as ArrayBuffer
    }
}

// ── HTTP Response Parser ──

interface ParsedResponse {
    status: number
    statusText: string
    headers: FetchHeaders
}

function parseHeaders(data: string): ParsedResponse | null {
    const headerEnd = data.indexOf('\r\n\r\n')
    if (headerEnd < 0) return null

    const headerPart = data.slice(0, headerEnd)
    const lines = headerPart.split('\r\n')
    const statusLine = lines[0]
    const match = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)\s+(.*)$/)
    if (!match) throw new Error('Invalid HTTP response: ' + statusLine)

    const status = parseInt(match[1], 10)
    const statusText = match[2]

    const headers = new FetchHeaders()
    for (let i = 1; i < lines.length; i++) {
        const colonIndex = lines[i].indexOf(':')
        if (colonIndex > 0) {
            const name = lines[i].slice(0, colonIndex).trim()
            const value = lines[i].slice(colonIndex + 1).trim()
            headers.append(name, value)
        }
    }

    return { status, statusText, headers }
}

// ── State machine constants ──

const ST_CONNECTING = 0
const ST_HANDSHAKE = 1
const ST_SEND = 2
const ST_RECV_HEADERS = 3
const ST_RECV_BODY = 4
const ST_DONE = 5

// ── Main fetch request ──

function fetchRequest(parsedUrl: { protocol: string; hostname: string; port: string; pathname: string; search?: string }, options: RequestOptions): Promise<FetchResponse> {
    return new Promise((resolve, reject) => {
        const method = options.method || 'GET'
        const headers = new FetchHeaders(options.headers)
        const body = options.body || null
        const timeout = options.timeout || 30000
        const isHTTPS = parsedUrl.protocol === 'https:'

        const defaultPort = isHTTPS ? 443 : 80
        const hostHeader = parsedUrl.port && parsedUrl.port !== String(defaultPort)
            ? parsedUrl.hostname + ':' + parsedUrl.port
            : parsedUrl.hostname
        if (!headers.has('host')) headers.set('Host', hostHeader)
        if (!headers.has('user-agent')) headers.set('User-Agent', 'QuickJS/1.0')
        if (!headers.has('connection')) headers.set('Connection', 'close')
        if (!headers.has('accept-encoding')) headers.set('Accept-Encoding', 'br')
        const bodyBytes = body ? new TextEncoder().encode(body) : null
        if (body && !headers.has('content-length')) headers.set('Content-Length', String(bodyBytes!.length))

        let request = method + ' ' + parsedUrl.pathname + (parsedUrl.search || '') + ' HTTP/1.1\r\n'
        headers.forEach((value: string, name: string) => {
            request += name + ': ' + value + '\r\n'
        })
        request += '\r\n'

        const requestBytes = new TextEncoder().encode(request)
        const httpRequest = _concat(
            bodyBytes ? [requestBytes, bodyBytes] : [requestBytes]
        ).buffer as ArrayBuffer

        let s: number | null = null
        let ssl: number | null = null
        let ctx: number | null = null
        let state = ST_CONNECTING
        let resolved = false
        let timerId: number | undefined
        let stream: _QuickReadableStream | null = null
        let headerRaw: Uint8Array = new Uint8Array(0)
        let isChunked = false
        let chunkedParts: Uint8Array[] = []

        const cleanupSocket = (): void => {
            state = ST_DONE
            if (ssl) { wolfssl.wolfSSL_free(ssl); ssl = null }
            if (ctx) { wolfssl.wolfSSL_CTX_free(ctx); ctx = null }
            if (s) { sock.closesocket(s); s = null }
        }

        const cleanup = (): void => {
            if (timerId) { clearTimeout(timerId); timerId = undefined }
        }

        const doResolve = (response: FetchResponse): void => {
            if (!resolved) { resolved = true; cleanup(); resolve(response) }
        }

        const doReject = (error: Error): void => {
            if (!resolved) { resolved = true; cleanup(); cleanupSocket(); reject(error) }
        }

        const streamCleanup = (): void => {
            cleanup()
            cleanupSocket()
        }

        timerId = setTimeout(() => {
            doReject(new Error('Request timeout'))
        }, timeout)

        s = sock.socket()
        if (!s || s === 0) { doReject(new Error('Failed to create socket')); return }
        const fd: number = s

        sock.set_on_event(fd, (event: { lNetworkEvents: number; iErrorCode: number[] }) => {
            if (state === ST_DONE) return

            if (event.lNetworkEvents & sock.FdEvent.FD_CONNECT) {
                const err = event.iErrorCode[0]
                if (err !== 0) { doReject(new Error('Connection failed: ' + err)); return }

                if (isHTTPS) {
                    const method = wolfssl.wolfTLSv1_2_client_method()
                    ctx = wolfssl.wolfSSL_CTX_new(method)
                    if (!ctx) { doReject(new Error('SSL_CTX_new failed')); return }
                    wolfssl.wolfSSL_CTX_set_verify(ctx, wolfssl.VerifyMode.SSL_VERIFY_NONE)
                    ssl = wolfssl.wolfSSL_new(ctx)
                    if (!ssl) { doReject(new Error('SSL_new failed')); return }
                    wolfssl.wolfSSL_set_fd(ssl, sock.get_fd(fd))
                    const sniHost = headers.get('host') || parsedUrl.hostname
                    if (sniHost) wolfssl.wolfSSL_UseSNI(ssl, wolfssl.SniType.WOLFSSL_SNI_HOST_NAME, sniHost)
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
                        if (!s && !ssl) break
                        let data: ArrayBuffer | null
                        if (isHTTPS && ssl) {
                            data = wolfssl.wolfSSL_read(ssl, 8192)
                        } else if (s) {
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
                            const contentLength = isChunked ? 0 : parseInt(
                                parsed.headers.get('content-length') || '0', 10
                            )
                            stream = new _QuickReadableStream(fd, ssl, isHTTPS, streamCleanup, contentLength)
                            if (trailingBodyBytes.length > 0) {
                                if (isChunked) {
                                    chunkedParts = [trailingBodyBytes]
                                    if (_hasChunkedEnd(trailingBodyBytes)) {
                                        const decoded = decodeChunked(trailingBodyBytes)
                                        stream._pushChunk(decoded)
                                        stream._close()
                                        state = ST_DONE
                                    }
                                } else {
                                    stream._pushChunk(trailingBodyBytes)
                                }
                            }

                            const response = new FetchResponse(
                                parsed.status, parsed.statusText, parsed.headers, stream
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
                        if (!s && !ssl) break
                        let data: ArrayBuffer | null
                        if (isHTTPS && ssl) {
                            data = wolfssl.wolfSSL_read(ssl, 8192)
                        } else if (s) {
                            data = sock.recv(s, 8192)
                        } else { break }
                        if (!data || data.byteLength === 0) break
                        if (isChunked) {
                            chunkedParts.push(new Uint8Array(data))
                            const combined = _concat(chunkedParts)
                            if (_hasChunkedEnd(combined)) {
                                const decoded = decodeChunked(combined)
                                stream._pushChunk(decoded)
                                stream._close()
                                stream = null
                                state = ST_DONE
                                break
                            }
                        } else {
                            stream._pushChunk(new Uint8Array(data))
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
                        if (!s && !ssl) break
                        let data: ArrayBuffer | null
                        if (isHTTPS && ssl) {
                            data = wolfssl.wolfSSL_read(ssl, 8192)
                        } else if (s) {
                            data = sock.recv(s, 8192)
                        } else { break }
                        if (!data || data.byteLength === 0) break
                        remainingParts.push(new Uint8Array(data))
                    }
                    if (isChunked) {
                        chunkedParts.push(...remainingParts)
                        const decoded = decodeChunked(_concat(chunkedParts))
                        stream._pushChunk(decoded)
                    } else if (remainingParts.length > 0) {
                        stream._pushChunk(_concat(remainingParts))
                    }
                    stream._close()
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

function headersToObj(headers: FetchHeaders): { [key: string]: string } {
    const obj: { [key: string]: string } = {}
    headers.forEach((value: string, name: string) => { obj[name] = value })
    return obj
}

function parseMaxAge(cc: string): number {
    const m = cc.match(/max-age=(\d+)/)
    return m ? parseInt(m[1], 10) : 0
}

async function fetch(url: string | Request, init: RequestInit = {}): Promise<FetchResponse> {
    // Normalize: if first arg is a Request, unwrap it
    let currentUrl: string
    let options: RequestOptions
    if (url instanceof FetchRequest) {
        const req = url
        currentUrl = req.url
        options = {
            method: init.method || req.method,
            headers: init.headers || headersToObj(req.headers),
            body: init.body !== undefined ? init.body : req.body || undefined,
            timeout: init.timeout || req.timeout,
            redirect: init.redirect || req.redirect,
            maxRedirects: init.maxRedirects || req.maxRedirects,
        }
    } else {
        currentUrl = url as string
        options = init as RequestOptions
    }

    const redirectMode = options.redirect || 'follow'
    const maxRedirects = redirectMode === 'follow' ? (options.maxRedirects || 5) : 0
    let redirectCount = 0
    const method = options.method || 'GET'
    const cache = typeof __httpCache__ !== 'undefined' ? __httpCache__ : null

    // ── Cache lookup (GET only) ──
    let cachedMeta: any = null
    let conditionalHeaders: { [key: string]: string } = {}

    if (cache && method === 'GET') {
        const metaStr = cache.readMeta(currentUrl)
        if (metaStr) {
            cachedMeta = JSON.parse(metaStr)
            const age = Math.floor(Date.now() / 1000) - cachedMeta.storedAt
            if (cachedMeta.maxAge > 0 && age < cachedMeta.maxAge) {
                const body = cache.readBody(currentUrl)
                if (body) {
                    const resp = new FetchResponse(
                        cachedMeta.status, cachedMeta.statusText,
                        new FetchHeaders(cachedMeta.headers || {}),
                        new _PreloadedStream(body) as any
                    )
                    resp.url = currentUrl
                    resp._preloadedBody = body
                    return resp
                }
            }
            if (cachedMeta.etag) conditionalHeaders['If-None-Match'] = cachedMeta.etag
            if (cachedMeta.lastModified) conditionalHeaders['If-Modified-Since'] = cachedMeta.lastModified
        }
    }

    while (true) {
        const mergedOptions: RequestOptions = { ...options }
        const mergedHeaders = { ...(options.headers || {}) }
        for (const key in conditionalHeaders) {
            mergedHeaders[key] = conditionalHeaders[key]
        }
        if (Object.keys(mergedHeaders).length > 0) mergedOptions.headers = mergedHeaders

        const parsedUrl = new URL(currentUrl)
        const response = await fetchRequest(parsedUrl, mergedOptions)

        response.url = currentUrl

        // ── Handle brotli Content-Encoding ──
        const contentEncoding = response.headers.get('content-encoding') || ''
        if (contentEncoding.includes('br')) {
            const compressedBody = await response.arrayBuffer()
            const decompressedBody = brotli.decompress(compressedBody)
            const newHeaders = new FetchHeaders()
            response.headers.forEach((v: string, k: string) => {
                if (k !== 'content-encoding') newHeaders.set(k, v)
            })
            newHeaders.set('content-length', String(decompressedBody.byteLength))
            const stream = new _PreloadedStream(decompressedBody) as any
            ;(response as any)._preloadedBody = decompressedBody
            ;(response as any)._bodyConsumed = false
            ;(response as any).body = stream
            ;(response as any).headers = newHeaders
        }

        // ── Handle 304 Not Modified ──
        if (response.status === 304 && cachedMeta && cache) {
            const body = cache.readBody(currentUrl)
            if (body) {
                cachedMeta.storedAt = Math.floor(Date.now() / 1000)
                response.headers.forEach((value: string, name: string) => {
                    cachedMeta.headers[name] = value
                })
                cache.writeMeta(currentUrl, JSON.stringify(cachedMeta))
                const resp = new FetchResponse(
                    cachedMeta.status, cachedMeta.statusText,
                    new FetchHeaders(cachedMeta.headers),
                    new _PreloadedStream(body) as any
                )
                resp.url = currentUrl
                resp._preloadedBody = body
                return resp
            }
        }

        // ── Cache 200 GET responses ──
        if (cache && method === 'GET' && response.status === 200 && !cachedMeta) {
            const body = await response.arrayBuffer()
            const cc = response.headers.get('cache-control') || ''
            const maxAge = parseMaxAge(cc)
            if (maxAge > 0) {
                cache.writeCache(currentUrl, maxAge, body)
                const meta = JSON.stringify({
                    storedAt: Math.floor(Date.now() / 1000),
                    maxAge,
                    status: response.status,
                    statusText: response.statusText,
                    headers: headersToObj(response.headers),
                    etag: response.headers.get('etag') || undefined,
                    lastModified: response.headers.get('last-modified') || undefined,
                })
                cache.writeMeta(currentUrl, meta)
            }
            const resp = new FetchResponse(
                response.status, response.statusText,
                response.headers, new _PreloadedStream(body) as any
            )
            resp.url = currentUrl
            resp._preloadedBody = body
            return resp
        }

        // ── Redirect handling ──
        const isRedirect = response.status === 301 || response.status === 302 ||
                          response.status === 303 || response.status === 307 || response.status === 308

        if (isRedirect) {
            if (redirectMode === 'error') {
                response.body.cancel('redirect')
                throw new Error('Redirect not allowed for: ' + currentUrl)
            }
            if (redirectMode === 'manual') {
                response.redirected = true
                return response
            }
            if (maxRedirects > 0 && redirectCount < maxRedirects) {
                const location = response.headers.get('location')
                if (!location) throw new Error('Redirect response missing Location header')

                response.body.cancel('redirect')
                currentUrl = new URL(location, currentUrl).href

                redirectCount++
                response.redirected = true

                if (response.status === 303) {
                    options.method = 'GET'
                    delete options.body
                }
            } else {
                if (redirectCount > 0) response.redirected = true
                return response
            }
        } else {
            if (redirectCount > 0) response.redirected = true
            return response
        }
    }
}

// ── Global declarations ──
// These are available to files that import './lib/fetch.js'

declare global {
    interface Headers {
        append(name: string, value: string): void;
        delete(name: string): void;
        get(name: string): string | null;
        has(name: string): boolean;
        set(name: string, value: string): void;
        forEach(callback: (value: string, name: string, parent: Headers) => void): void;
        entries(): IterableIterator<[string, string]>;
        keys(): IterableIterator<string>;
        values(): IterableIterator<string>;
        [Symbol.iterator](): IterableIterator<[string, string]>;
    }
    var Headers: typeof FetchHeaders;

    interface Response {
        readonly status: number;
        readonly statusText: string;
        readonly headers: Headers;
        readonly ok: boolean;
        readonly redirected: boolean;
        readonly type: string;
        readonly url: string;
        readonly body: ReadableStream;
        readonly bodyUsed: boolean;
        text(): Promise<string>;
        json(): Promise<any>;
        arrayBuffer(): Promise<ArrayBuffer>;
    }
    var Response: typeof FetchResponse;

    interface Request {
        readonly url: string;
        readonly method: string;
        readonly headers: Headers;
        readonly body: string | null;
        readonly redirect: 'follow' | 'manual' | 'error';
    }
    var Request: typeof FetchRequest;

    var fetch: (url: string | Request, init?: RequestInit) => Promise<Response>;
}

// ── Register globals ──

globalThis.fetch = fetch
globalThis.Response = FetchResponse
globalThis.Request = FetchRequest
globalThis.Headers = FetchHeaders
