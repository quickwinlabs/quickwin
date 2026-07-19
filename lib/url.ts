export {} // make this a module so declare global works

declare global {
    interface URLSearchParams extends URLSearchParamsImpl {}
    var URLSearchParams: typeof URLSearchParamsImpl
    interface URL extends URLImpl {}
    var URL: typeof URLImpl
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
    if (sm) { r.scheme = sm[1]!.toLowerCase(); url = sm[2]! }
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
            if (this._list[i]![0] === key) { if (!f) { this._list[i]![1] = value; f = true } else { this._list.splice(i, 1); i-- } }
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
    globalThis.URLSearchParams = URLSearchParamsImpl
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
            s += this._hostname.includes(':') ? '[' + this._hostname + ']' : this._hostname
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
    globalThis.URL = URLImpl
}
