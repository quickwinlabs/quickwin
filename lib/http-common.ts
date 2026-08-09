import './polyfill.js'
import './stream.js'

// ── Byte helpers ──

export function _concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    if (parts.length === 0) return new Uint8Array(0)
    let totalLen = 0
    for (const p of parts) totalLen += p.length
    const result = new Uint8Array(totalLen)
    let offset = 0
    for (const p of parts) { result.set(p, offset); offset += p.length }
    return result
}

export function _toReadableStream(body: BodyInit): ReadableStream<Uint8Array> {
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

export async function _readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
    }
    return _concat(chunks)
}

export function _hasChunkedEnd(data: Uint8Array): boolean {
    if (data.length < 7) return false
    let i = data.length - 7
    return data[i] === 0x0D && data[i+1] === 0x0A && data[i+2] === 0x30 && data[i+3] === 0x0D && data[i+4] === 0x0A && data[i+5] === 0x0D && data[i+6] === 0x0A
}

export function decodeChunked(data: Uint8Array): Uint8Array {
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

export class HeadersImpl {
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

export class RequestImpl {
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

    async json<T = unknown>(): Promise<T> {
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

export class ResponseImpl {
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

    async json<T = unknown>(): Promise<T> {
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
}

// ── Register globals ──

globalThis.Headers = HeadersImpl
globalThis.Request = RequestImpl
globalThis.Response = ResponseImpl
