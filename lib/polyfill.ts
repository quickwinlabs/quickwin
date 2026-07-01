import * as os from 'os'
import './url.js'
import './text-codec.js'

declare global {
    interface Console {
        error: (...args: any) => void
    }

    var window: typeof globalThis

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
}

// 1. window — triggers Emscripten browser path
if (typeof globalThis.window === 'undefined')
    globalThis.window = globalThis

// 2. setTimeout polyfill — bridge to os.setTimeout
if (typeof globalThis.setTimeout === 'undefined') {
    globalThis.setTimeout = (fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
        return os.setTimeout(() => fn(...args), ms)
    }
}

// 3. console.error polyfill — QuickJS only has console.log
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
