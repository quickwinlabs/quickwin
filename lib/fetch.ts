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

function str2ab(str: string): ArrayBuffer {
    const buf = new ArrayBuffer(str.length)
    const view = new Uint8Array(buf)
    for (let i = 0; i < str.length; i++) view[i] = str.charCodeAt(i)
    return buf
}

function decodeChunked(raw: ArrayBuffer): ArrayBuffer {
    const str = ab2str(raw)
    const chunks: string[] = []
    let pos = 0
    while (pos < str.length) {
        const crlf = str.indexOf('\r\n', pos)
        if (crlf < 0) break
        const sizeHex = str.slice(pos, crlf)
        if (sizeHex === '') break
        const size = parseInt(sizeHex, 16)
        if (isNaN(size) || size === 0) {
            pos = crlf + 2
            const trailerEnd = str.indexOf('\r\n\r\n', pos)
            if (trailerEnd >= 0) pos = trailerEnd + 4
            break
        }
        const dataStart = crlf + 2
        if (dataStart + size > str.length) break
        chunks.push(str.slice(dataStart, dataStart + size))
        pos = dataStart + size + 2
    }
    return str2ab(chunks.join(''))
}

function ab2str(buf: ArrayBuffer): string {
    const view = new Uint8Array(buf)
    let str = ''
    for (let i = 0; i < view.length; i++) str += String.fromCharCode(view[i])
    return str
}

function getArrayBuffer(view: Uint8Array): ArrayBuffer {
    if (view.buffer instanceof ArrayBuffer) return view.buffer
    const copy = new ArrayBuffer(view.byteLength)
    new Uint8Array(copy).set(view)
    return copy
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

    _pushChunk(buf: ArrayBuffer): void {
        if (this._state !== 'readable') return
        const chunk = new Uint8Array(buf)
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
            return ab2str(this._preloadedBody)
        }
        if (this.bodyUsed) throw new TypeError('Body already used')
        this._bodyConsumed = true
        const reader = this.body.getReader()
        let result = ''
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            for (let i = 0; i < value.length; i++) result += String.fromCharCode(value[i])
        }
        return result
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
        let totalLength = 0
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
            totalLength += value.length
        }
        const result = new Uint8Array(totalLength)
        let offset = 0
        for (const chunk of chunks) {
            result.set(chunk, offset)
            offset += chunk.length
        }
        return getArrayBuffer(result)
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

function fetchRequest(parsedUrl: { protocol: string; hostname: string; port: string; pathname: string }, options: RequestOptions): Promise<FetchResponse> {
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
        if (body && !headers.has('content-length')) headers.set('Content-Length', String(body.length))

        let request = method + ' ' + parsedUrl.pathname + ' HTTP/1.1\r\n'
        headers.forEach((value: string, name: string) => {
            request += name + ': ' + value + '\r\n'
        })
        request += '\r\n'
        if (body) request += body

        let s: number | null = null
        let ssl: number | null = null
        let ctx: number | null = null
        let state = ST_CONNECTING
        let resolved = false
        let timerId: number | undefined
        let stream: _QuickReadableStream | null = null
        let headerBuffer = ''
        let isChunked = false
        let chunkedBuf = ''

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
                    wolfssl.wolfSSL_CTX_set_verify(ctx, wolfssl.VerifyMode.SSL_VERIFY_NONE)
                    ssl = wolfssl.wolfSSL_new(ctx)
                    if (!ssl) { doReject(new Error('SSL_new failed')); return }
                    wolfssl.wolfSSL_set_fd(ssl, sock.get_fd(fd))
                    const sniHost = headers.get('host') || parsedUrl.hostname
                    if (sniHost) wolfssl.wolfSSL_UseSNI(ssl, wolfssl.SniType.WOLFSSL_SNI_HOST_NAME, sniHost)
                    state = ST_HANDSHAKE
                } else {
                    sock.send(fd, str2ab(request))
                    state = ST_RECV_HEADERS
                }
            }

            if ((event.lNetworkEvents & sock.FdEvent.FD_READ) || (event.lNetworkEvents & sock.FdEvent.FD_WRITE)) {
                if (state === ST_HANDSHAKE) {
                    if (!ssl) { doReject(new Error('TLS not initialized')); return }
                    const ret = wolfssl.wolfSSL_connect(ssl)
                    if (ret === wolfssl.ReturnCode.SSL_SUCCESS) {
                        wolfssl.wolfSSL_write(ssl, str2ab(request))
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
                        headerBuffer += ab2str(data)
                        const headerEnd = headerBuffer.indexOf('\r\n\r\n')
                        if (headerEnd >= 0) {
                            const parsed = parseHeaders(headerBuffer)
                            if (!parsed) { doReject(new Error('Failed to parse HTTP headers')); return }

                            const trailingBody = headerBuffer.slice(headerEnd + 4)

                            isChunked = (parsed.headers.get('transfer-encoding') || '').toLowerCase().includes('chunked')
                            const contentLength = isChunked ? 0 : parseInt(
                                parsed.headers.get('content-length') || '0', 10
                            )
                            stream = new _QuickReadableStream(fd, ssl, isHTTPS, streamCleanup, contentLength)
                            if (trailingBody.length > 0) {
                                if (isChunked) {
                                    chunkedBuf = trailingBody
                                } else {
                                    stream._pushChunk(str2ab(trailingBody))
                                }
                            }

                            const response = new FetchResponse(
                                parsed.status, parsed.statusText, parsed.headers, stream
                            )
                            state = ST_RECV_BODY
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
                            chunkedBuf += ab2str(data)
                            if (chunkedBuf.indexOf('\r\n0\r\n\r\n') >= 0) {
                                stream._pushChunk(decodeChunked(str2ab(chunkedBuf)))
                                stream._close()
                                stream = null
                                state = ST_DONE
                                break
                            }
                        } else {
                            stream._pushChunk(data)
                        }
                    }
                }
            }

            if (event.lNetworkEvents & sock.FdEvent.FD_CLOSE) {
                if (state === ST_DONE) return
                if (state === ST_RECV_HEADERS) {
                    doReject(new Error('Connection closed before response'))
                } else if (state === ST_RECV_BODY && stream) {
                    let remainingBuf = ''
                    while (true) {
                        if (!s && !ssl) break
                        let data: ArrayBuffer | null
                        if (isHTTPS && ssl) {
                            data = wolfssl.wolfSSL_read(ssl, 8192)
                        } else if (s) {
                            data = sock.recv(s, 8192)
                        } else { break }
                        if (!data || data.byteLength === 0) break
                        remainingBuf += ab2str(data)
                    }
                    if (isChunked) {
                        chunkedBuf += remainingBuf
                        stream._pushChunk(decodeChunked(str2ab(chunkedBuf)))
                    } else if (remainingBuf) {
                        stream._pushChunk(str2ab(remainingBuf))
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

async function fetch(url: string, options: RequestOptions = {}): Promise<FetchResponse> {
    const redirectMode = options.redirect || 'follow'
    const maxRedirects = redirectMode === 'follow' ? (options.maxRedirects || 5) : 0
    let currentUrl = url
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

    var fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

// ── Register globals ──

globalThis.fetch = fetch
globalThis.Response = FetchResponse
globalThis.Headers = FetchHeaders
