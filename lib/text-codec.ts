export {} // make this a module so declare global works

declare global {
    interface TextDecoder<T extends _Label | undefined = _Label | undefined> extends TextDecoderImpl<T> {}
    var TextDecoder: typeof TextDecoderImpl

    interface TextEncoder<T extends _Label | undefined = _Label | undefined> extends TextEncoderImpl<T> {}
    var TextEncoder: typeof TextEncoderImpl
}

const _labelMap = {
    'utf-8': 'utf-8',
    'utf8': 'utf-8',
    'unicode-1-1-utf-8': 'utf-8',
    'utf-16': 'utf-16le',
    'utf-16le': 'utf-16le',
    'utf-16be': 'utf-16be',
} as const

type _Label = keyof typeof _labelMap
type _Encoding = typeof _labelMap[_Label]
type _Result<T> = T extends _Label ? typeof _labelMap[T] : 'utf-8'

function _normalizeLabel<T extends _Label | undefined>(label: T): _Result<T> {
    if (!label) return 'utf-8' as _Result<T>
    const result = _labelMap[label.trim().toLowerCase() as _Label]
    if (result) return result as _Result<T>
    throw new RangeError(`The encoding label "${label}" is not supported`)
}

function _decodeUTF8(buf: Uint8Array, fatal: boolean): string {
    let out = ''
    for (let i = 0; i < buf.length; ) {
        const b = buf[i++]!
        if (b < 0x80) { out += String.fromCharCode(b); continue }
        if (b < 0xC0) { out += fatal ? (() => { throw new TypeError('unexpected continuation byte') })() : '\uFFFD'; continue }
        let c: number, min: number
        if (b < 0xE0) {
            if (i >= buf.length) { out += fatal ? (() => { throw new TypeError('incomplete utf-8') })() : '\uFFFD'; break }
            const b2 = buf[i++]!
            if ((b2 & 0xC0) !== 0x80) { out += '\uFFFD'; continue }
            c = ((b & 0x1F) << 6) | (b2 & 0x3F)
            min = 0x80
        } else if (b < 0xF0) {
            if (i + 1 >= buf.length) { out += fatal ? (() => { throw new TypeError('incomplete utf-8') })() : '\uFFFD'; break }
            const b2 = buf[i++]!; const b3 = buf[i++]!
            if (((b2 & 0xC0) !== 0x80) || ((b3 & 0xC0) !== 0x80)) { out += '\uFFFD'; continue }
            c = ((b & 0x0F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F)
            min = 0x800
        } else if (b < 0xF8) {
            if (i + 2 >= buf.length) { out += fatal ? (() => { throw new TypeError('incomplete utf-8') })() : '\uFFFD'; break }
            const b2 = buf[i++]!; const b3 = buf[i++]!; const b4 = buf[i++]!
            if (((b2 & 0xC0) !== 0x80) || ((b3 & 0xC0) !== 0x80) || ((b4 & 0xC0) !== 0x80)) { out += '\uFFFD'; continue }
            c = ((b & 0x07) << 18) | ((b2 & 0x3F) << 12) | ((b3 & 0x3F) << 6) | (b4 & 0x3F)
            min = 0x10000
        } else { out += fatal ? (() => { throw new TypeError('invalid utf-8 start') })() : '\uFFFD'; continue }
        if (c < min || (c >= 0xD800 && c <= 0xDFFF) || c > 0x10FFFF) {
            out += fatal ? (() => { throw new TypeError('invalid utf-8 codepoint') })() : '\uFFFD'; continue
        }
        if (c <= 0xFFFF) out += String.fromCharCode(c)
        else { c -= 0x10000; out += String.fromCharCode(0xD800 | (c >> 10), 0xDC00 | (c & 0x3FF)) }
    }
    return out
}

function _decodeUTF16(buf: Uint8Array, le: boolean, fatal: boolean): string {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    let out = ''
    for (let i = 0; i + 1 < buf.length; i += 2) {
        let c = dv.getUint16(i, le)
        if (c >= 0xD800 && c <= 0xDBFF) {
            i += 2
            if (i + 1 >= buf.length) {
                out += fatal ? (() => { throw new TypeError('truncated surrogate pair') })() : '\uFFFD'; break
            }
            const c2 = dv.getUint16(i, le)
            if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
                out += String.fromCharCode(c, c2)
            } else {
                out += fatal ? (() => { throw new TypeError('invalid surrogate pair') })() : '\uFFFD'
                i -= 2
            }
        } else if (c >= 0xDC00 && c <= 0xDFFF) {
            out += fatal ? (() => { throw new TypeError('unexpected trailing surrogate') })() : '\uFFFD'
        } else {
            out += String.fromCharCode(c)
        }
    }
    return out
}

class TextDecoderImpl<T extends _Label | undefined = _Label | undefined> {
    _encoding: _Encoding
    _fatal: boolean
    _ignoreBOM: boolean

    constructor(label?: T, options?: { fatal?: boolean, ignoreBOM?: boolean }) {
        this._encoding = _normalizeLabel(label)
        this._fatal = options?.fatal ?? false
        this._ignoreBOM = options?.ignoreBOM ?? false
    }

    get encoding(): _Result<T> { return this._encoding as _Result<T> }
    get fatal(): boolean { return this._fatal }
    get ignoreBOM(): boolean { return this._ignoreBOM }

    decode(buffer?: ArrayBufferView | ArrayBuffer | null): string {
        if (!buffer) return ''
        const arr = buffer instanceof Uint8Array ? buffer
            : buffer instanceof ArrayBuffer ? new Uint8Array(buffer)
            : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)

        if (this._encoding === 'utf-8') {
            return _decodeUTF8(arr, this._fatal)
        }

        const le = this._encoding === 'utf-16le'
        let offset = 0

        if (arr.length >= 2 && !this._ignoreBOM) {
            const bomLo = le ? arr[0]! : arr[1]!
            const bomHi = le ? arr[1]! : arr[0]!
            const bom = (bomHi << 8) | bomLo
            if (bom === 0xFEFF || bom === 0xFFFE) {
                offset = 2
            }
        }

        return _decodeUTF16(arr.slice(offset), le, this._fatal)
    }
}

class TextEncoderImpl<T extends _Label | undefined = _Label | undefined> {
    _encoding: _Encoding

    constructor(label?: T) {
        this._encoding = _normalizeLabel(label)
    }

    get encoding(): _Result<T> { return this._encoding as _Result<T> }

    encode(input?: string): Uint8Array<ArrayBuffer> {
        if (!input) return new Uint8Array(0)

        if (this._encoding === 'utf-8') {
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

        const le = this._encoding === 'utf-16le'
        const buf = new ArrayBuffer(input.length * 2)
        const dv = new DataView(buf)
        for (let i = 0; i < input.length; i++) dv.setUint16(i * 2, input.charCodeAt(i), le)
        return new Uint8Array(buf)
    }
}

if (typeof globalThis.TextDecoder === 'undefined') {
    globalThis.TextDecoder = TextDecoderImpl
}

if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = TextEncoderImpl
}
