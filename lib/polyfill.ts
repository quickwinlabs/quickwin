import * as os from 'os'

declare global {
    interface Console {
        error: (...args: any) => void
    }

    var window: typeof globalThis

    interface TextDecoder {
        encoding: string
        decode(buffer?: ArrayBuffer | Uint8Array): string
    }
    var TextDecoder: { new(): TextDecoder }

    interface TextEncoder {
        encoding: string
        encode(input?: string): Uint8Array
    }
    var TextEncoder: { new(): TextEncoder }

    function setTimeout(fn: (...args: any[]) => void, ms: number, ...args: any[]): number

    function btoa(data: string): string
    function atob(data: string): string

    interface SubtleCrypto {
        digest(algorithm: 'SHA-1', data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer>
    }

    interface Crypto {
        getRandomValues<T extends ArrayBufferView>(array: T): T
        subtle: SubtleCrypto
    }

    var crypto: Crypto

    interface URLSearchParams {
        append(key: string, value: string): void
        delete(key: string): void
        get(key: string): string | null
        getAll(key: string): string[]
        has(key: string): boolean
        set(key: string, value: string): void
        sort(): void
        forEach(fn: (value: string, key: string) => void): void
        keys(): IterableIterator<string>
        values(): IterableIterator<string>
        entries(): IterableIterator<[string, string]>
        toString(): string
        readonly size: number
        [Symbol.iterator](): IterableIterator<[string, string]>
    }

    var URLSearchParams: {
        new(init?: string | [string, string][] | Record<string, string>): URLSearchParams
        prototype: URLSearchParams
    }

    interface URL {
        href: string
        protocol: string
        hostname: string
        port: string
        pathname: string
        search: string
        hash: string
        host: string
        origin: string
        username: string
        password: string
        searchParams: URLSearchParams
        toString(): string
        toJSON(): string
    }

    var URL: {
        new(url: string, base?: string): URL
        prototype: URL
    }
}

// 1. window — triggers Emscripten browser path
if (typeof globalThis.window === 'undefined')
    globalThis.window = globalThis

// 2. TextDecoder polyfill
if (typeof globalThis.TextDecoder === 'undefined') {
    globalThis.TextDecoder = class TextDecoder {
        encoding: string = 'utf-8'
        decode(buffer?: ArrayBuffer | Uint8Array): string {
            if (!buffer) return ''
            const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
            let out = ''
            for (let i = 0; i < bytes.length; ) {
                const b = bytes[i++]
                if (b < 0x80) { out += String.fromCharCode(b); continue }
                let c: number
                if (b < 0xE0) { c = b & 0x1F; c = (c << 6) | (bytes[i++] & 0x3F) }
                else if (b < 0xF0) { c = b & 0x0F; c = (c << 6) | (bytes[i++] & 0x3F); c = (c << 6) | (bytes[i++] & 0x3F) }
                else { c = b & 0x07; c = (c << 6) | (bytes[i++] & 0x3F); c = (c << 6) | (bytes[i++] & 0x3F); c = (c << 6) | (bytes[i++] & 0x3F) }
                if (c <= 0xFFFF) out += String.fromCharCode(c)
                else { c -= 0x10000; out += String.fromCharCode(0xD800 | (c >> 10), 0xDC00 | (c & 0x3FF)) }
            }
            return out
        }
    }
}

// 3. setTimeout polyfill — bridge to os.setTimeout
if (typeof globalThis.setTimeout === 'undefined') {
    globalThis.setTimeout = (fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
        return os.setTimeout(() => fn(...args), ms)
    }
}

// 4. TextEncoder polyfill
if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = class TextEncoder {
        encoding: string = 'utf-8'
        encode(input?: string): Uint8Array {
            if (!input) return new Uint8Array(0)
            const bytes: number[] = []
            for (let i = 0; i < input.length; i++) {
                let c = input.charCodeAt(i)
                if (c < 0x80) { bytes.push(c) }
                else if (c < 0x800) { bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)) }
                else if (c < 0xD800 || c >= 0xE000) { bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)) }
                else { i++; const c2 = input.charCodeAt(i); c = 0x10000 + ((c & 0x3FF) << 10) | (c2 & 0x3FF); bytes.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)) }
            }
            return new Uint8Array(bytes)
        }
    }
}

// 5. console.error polyfill — QuickJS only has console.log
if (typeof console.error === 'undefined') {
    console.error = (...args: unknown[]) => { console.log(...args) }
}


// ── SHA-1 ──

function sha1Bytes(bytes: number[]): Uint8Array {
    const len = bytes.length
    const ml = len * 8

    bytes.push(0x80)
    while (bytes.length % 64 !== 56) { bytes.push(0) }
    bytes.push(0)
    bytes.push(0)
    bytes.push(0)
    bytes.push(0)
    bytes.push((ml >>> 24) & 0xFF)
    bytes.push((ml >>> 16) & 0xFF)
    bytes.push((ml >>> 8) & 0xFF)
    bytes.push(ml & 0xFF)

    let h0 = 0x67452301, h1 = 0xEFCDAB89
    let h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0
    const rotl = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0

    for (let i = 0; i < bytes.length; i += 64) {
        const w: number[] = []
        for (let t = 0; t < 16; t++) {
            w[t] = (bytes[i + 4 * t] << 24) | (bytes[i + 4 * t + 1] << 16) |
                   (bytes[i + 4 * t + 2] << 8) | bytes[i + 4 * t + 3]
        }
        for (let t = 16; t < 80; t++) {
            w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1)
        }

        let a = h0, b = h1, c = h2, d = h3, e = h4
        for (let t = 0; t < 80; t++) {
            let f: number, k: number
            if (t < 20)       { f = (b & c) | (~b & d); k = 0x5A827999 }
            else if (t < 40)  { f = b ^ c ^ d;         k = 0x6ED9EBA1 }
            else if (t < 60)  { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC }
            else              { f = b ^ c ^ d;         k = 0xCA62C1D6 }
            const temp = (rotl(a, 5) + f + e + k + w[t]) >>> 0
            e = d; d = c; c = rotl(b, 30); b = a; a = temp
        }
        h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0
        h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0
    }

    const result = new Uint8Array(20)
    const w32 = (off: number, v: number) => {
        result[off] = (v >>> 24) & 0xFF; result[off + 1] = (v >>> 16) & 0xFF
        result[off + 2] = (v >>> 8) & 0xFF; result[off + 3] = v & 0xFF
    }
    w32(0, h0); w32(4, h1); w32(8, h2); w32(12, h3); w32(16, h4)
    return result
}

// ── Base64 ──

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function b64Encode(data: Uint8Array): string {
    let r = ''
    for (let i = 0; i < data.length; i += 3) {
        const b0 = data[i], b1 = i + 1 < data.length ? data[i + 1] : 0, b2 = i + 2 < data.length ? data[i + 2] : 0
        r += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)]
        r += i + 1 < data.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '='
        r += i + 2 < data.length ? B64[b2 & 63] : '='
    }
    return r
}

function b64Decode(str: string): Uint8Array {
    str = str.replace(/[^A-Za-z0-9+/=]/g, '')
    const bytes: number[] = []
    for (let i = 0; i < str.length; i += 4) {
        const c0 = B64.indexOf(str[i]), c1 = B64.indexOf(str[i + 1])
        const c2 = B64.indexOf(str[i + 2]), c3 = B64.indexOf(str[i + 3])
        bytes.push((c0 << 2) | (c1 >> 4))
        if (c2 >= 0) bytes.push(((c1 & 15) << 4) | (c2 >> 2))
        if (c3 >= 0) bytes.push(((c2 & 3) << 6) | c3)
    }
    return new Uint8Array(bytes)
}

// ── btoa / atob ──

if (typeof globalThis.btoa === 'undefined') {
    globalThis.btoa = (data: string): string => {
        const bytes = new Uint8Array(data.length)
        for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xFF
        return b64Encode(bytes)
    }
}

if (typeof globalThis.atob === 'undefined') {
    globalThis.atob = (data: string): string => {
        const bytes = b64Decode(data)
        let r = ''
        for (let i = 0; i < bytes.length; i++) r += String.fromCharCode(bytes[i])
        return r
    }
}

function _encode(s: string): string { return encodeURIComponent(s) }
function _decode(s: string): string {
    try { return decodeURIComponent(s.replace(/\+/g, ' ')) }
    catch { return s }
}

function _normalizePath(path: string): string {
    if (!path) return '/'
    const parts = path.split('/')
    const out: string[] = []
    let hasRoot = path[0] === '/'
    if (hasRoot) out.push('')
    for (const p of parts) {
        if (p === '' || p === '.') continue
        if (p === '..') {
            const last = out[out.length - 1]
            if (last !== undefined && last !== '') out.pop()
        } else {
            out.push(p)
        }
    }
    if (path.endsWith('/') && out[out.length - 1] !== '') out.push('')
    const result = out.join('/')
    if (hasRoot && !result.startsWith('/')) return '/' + result
    return result || '/'
}

function _parseURL(url: string): { scheme: string; user: string; pass: string; host: string; port: string; path: string; query: string; fragment: string } {
    const r = { scheme: '', user: '', pass: '', host: '', port: '', path: '/', query: '', fragment: '' }
    const fi = url.indexOf('#')
    if (fi >= 0) { r.fragment = url.slice(fi + 1); url = url.slice(0, fi) }
    const qi = url.indexOf('?')
    if (qi >= 0) { r.query = url.slice(qi + 1); url = url.slice(0, qi) }
    const sm = url.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):(.*)$/)
    if (sm) { r.scheme = sm[1].toLowerCase(); url = sm[2] }
    if (url.startsWith('//')) {
        url = url.slice(2)
        const si = url.indexOf('/')
        let auth: string
        if (si < 0) { auth = url; url = '' } else { auth = url.slice(0, si); url = url.slice(si) }
        const ai = auth.lastIndexOf('@')
        if (ai >= 0) {
            const ui = auth.slice(0, ai); auth = auth.slice(ai + 1)
            const ci = ui.indexOf(':')
            if (ci >= 0) { r.user = _decode(ui.slice(0, ci)); r.pass = _decode(ui.slice(ci + 1)) }
            else r.user = _decode(ui)
        }
        if (auth.startsWith('[')) {
            const cb = auth.indexOf(']')
            r.host = auth.slice(1, cb).toLowerCase()
            const pp = auth.slice(cb + 1)
            if (pp.startsWith(':')) r.port = pp.slice(1)
        } else {
            const ci = auth.lastIndexOf(':')
            if (ci >= 0 && ci === auth.lastIndexOf(':')) { r.host = auth.slice(0, ci).toLowerCase(); r.port = auth.slice(ci + 1) }
            else r.host = auth.toLowerCase()
        }
    }
    r.path = url
    if (r.host && !r.path.startsWith('/')) r.path = '/' + r.path
    return r
}

class URLSearchParamsImpl {
    private _list: [string, string][] = []

    constructor(init?: string | [string, string][] | Record<string, string>) {
        if (typeof init === 'string') {
            const s = init.startsWith('?') ? init.slice(1) : init
            if (!s) return
            for (const p of s.split('&')) {
                const eq = p.indexOf('=')
                if (eq < 0) { this._list.push([_decode(p), '']); continue }
                this._list.push([_decode(p.slice(0, eq)), _decode(p.slice(eq + 1))])
            }
        } else if (init) {
            if (Array.isArray(init)) for (const [k, v] of init) this._list.push([String(k), String(v)])
            else for (const k of Object.keys(init)) this._list.push([k, String(init[k])])
        }
    }

    append(key: string, value: string): void { this._list.push([key, value]) }
    delete(key: string): void { this._list = this._list.filter(([k]) => k !== key) }
    get(key: string): string | null { for (const [k, v] of this._list) if (k === key) return v; return null }
    getAll(key: string): string[] { return this._list.filter(([k]) => k === key).map(([, v]) => v) }
    has(key: string): boolean { return this._list.some(([k]) => k === key) }
    set(key: string, value: string): void {
        let f = false
        for (let i = 0; i < this._list.length; i++) {
            if (this._list[i][0] === key) { if (!f) { this._list[i][1] = value; f = true } else { this._list.splice(i, 1); i-- } }
        }
        if (!f) this._list.push([key, value])
    }
    sort(): void { this._list.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) }
    forEach(fn: (v: string, k: string) => void): void { for (const [k, v] of this._list) fn(v, k) }

    *keys(): IterableIterator<string> { for (const [k] of this._list) yield k }
    *values(): IterableIterator<string> { for (const [, v] of this._list) yield v }
    *entries(): IterableIterator<[string, string]> { for (const item of this._list) yield [item[0], item[1]] }
    *[Symbol.iterator](): IterableIterator<[string, string]> { for (const item of this._list) yield item }

    toString(): string { return this._list.map(([k, v]) => _encode(k) + '=' + _encode(v)).join('&') }
    get size(): number { return this._list.length }
}

if (typeof globalThis.URLSearchParams === 'undefined') {
    globalThis.URLSearchParams = URLSearchParamsImpl as any
}

class URLImpl {
    private _scheme = ''
    private _username = ''
    private _password = ''
    private _hostname = ''
    private _port = ''
    private _pathname = '/'
    private _query = ''
    private _fragment = ''
    private _searchParams: URLSearchParams = new URLSearchParamsImpl()

    constructor(url: string, base?: string) {
        let p = _parseURL(url)
        if (p.scheme) { this._apply(p); return }
        if (base === undefined) throw new TypeError('Invalid URL')

        const b = new URLImpl(base)
        if (p.host) { p.scheme = b._scheme; this._apply(p); return }
        if (!p.path && !p.query) {
            this._apply({
                scheme: b._scheme, user: b._username, pass: b._password,
                host: b._hostname, port: b._port,
                path: b._pathname, query: b._query, fragment: p.fragment || ''
            }); return
        }
        p.scheme = b._scheme; if (!p.user) p.user = b._username; if (!p.pass) p.pass = b._password
        if (!p.host) p.host = b._hostname; if (!p.port) p.port = b._port; if (!p.fragment) p.fragment = ''
        if (p.path && !p.path.startsWith('/')) {
            const bd = b._pathname.substring(0, b._pathname.lastIndexOf('/') + 1)
            p.path = _normalizePath(bd + p.path)
        } else if (!p.path) { p.path = b._pathname; if (!p.query) p.query = b._query }
        this._apply(p)
    }

    private _apply(p: { scheme: string; user: string; pass: string; host: string; port: string; path: string; query: string; fragment: string }): void {
        this._scheme = p.scheme; this._username = p.user; this._password = p.pass
        this._hostname = p.host; this._port = p.port
        this._pathname = _normalizePath(p.path || '/')
        this._query = p.query; this._fragment = p.fragment
        this._searchParams = new URLSearchParamsImpl(this._query)
    }

    get href(): string { return this.toString() }
    get protocol(): string { return this._scheme + ':' }
    get hostname(): string { return this._hostname }
    get port(): string { return this._port }
    get pathname(): string { return this._pathname }
    get search(): string { return this._query ? '?' + this._query : '' }
    get hash(): string { return this._fragment ? '#' + this._fragment : '' }
    get host(): string {
        const h = this._hostname
        const ipv6 = h.includes(':')
        return (ipv6 ? '[' + h + ']' : h) + (this._port ? ':' + this._port : '')
    }
    get origin(): string {
        const h = this._hostname
        const ipv6 = h.includes(':')
        return this._scheme + '://' + (ipv6 ? '[' + h + ']' : h) + (this._port ? ':' + this._port : '')
    }
    get username(): string { return this._username }
    get password(): string { return this._password }
    get searchParams(): URLSearchParams { return this._searchParams }

    toString(): string {
        let s = this._scheme + ':'
        const special = ['http', 'https', 'ws', 'wss', 'ftp', 'file']
        if (this._hostname || (special.includes(this._scheme) && this._pathname.startsWith('/'))) {
            s += '//'
            if (this._username) { s += _encode(this._username); if (this._password) s += ':' + _encode(this._password); s += '@' }
            s += this._hostname
            if (this._port) s += ':' + this._port
        }
        s += this._pathname
        if (this._query) s += '?' + this._query
        if (this._fragment) s += '#' + this._fragment
        return s
    }

    toJSON(): string { return this.toString() }
}

if (typeof globalThis.URL === 'undefined') {
    globalThis.URL = URLImpl as any
}

if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = {
        getRandomValues: <T extends ArrayBufferView>(array: T): T => {
            const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
            for (let i = 0; i < view.length; i++) view[i] = (Math.random() * 256) | 0
            return array
        },
        subtle: {
            digest: (algorithm: string, data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer> => {
                if (algorithm.toUpperCase() !== 'SHA-1')
                    return Promise.reject(new Error('Digest: ' + algorithm + ' not supported'))
                const bytes = data instanceof Uint8Array ? Array.from(data) : Array.from(new Uint8Array(data))
                const hash = sha1Bytes(bytes)
                return Promise.resolve(hash.buffer as ArrayBuffer)
            }
        }
    }
}
