import '../lib/polyfill.js'
import * as std from 'std'
import { Tester } from './test_helper.js'

export const suite = {
    name: 'polyfill',
    run: async (t: Tester) => {
        function assert(name: string, ok: boolean): void {
            if (ok) { t.ok++; std.printf('  PASS: %s\n', name) }
            else { t.fail++; std.printf('  FAIL: %s\n', name) }
        }

        t.section('btoa/atob')
        const orig = "Hello\u0000World"
        const b64 = btoa(orig)
        const back = atob(b64)
        assert('btoa/atob roundtrip', back === orig)
        assert('btoa produces base64 chars', /^[A-Za-z0-9+/=]+$/.test(b64))

        const hash = new Uint8Array([0x2f, 0xd4, 0xe1, 0xc6, 0x7a, 0x2d, 0x28, 0xfc, 0xed, 0x84, 0x9e, 0xe1, 0xbb, 0x76, 0xe7, 0x39, 0x1b, 0x93, 0xeb, 0x12])
        assert('btoa(SHA-1 sample) matches known value', btoa(String.fromCharCode(...hash)) === "L9ThxnotKPzthJ7hu3bnORuT6xI=")

        t.section('crypto.getRandomValues')
        const buf = new Uint8Array(32)
        crypto.getRandomValues(buf)
        assert('length=32', buf.length === 32)
        assert('not all zeros', buf.some(b => b !== 0))

        t.section('crypto.subtle.digest SHA-1')
        const data = new TextEncoder().encode("Hello")
        const hashBuf = await crypto.subtle.digest("SHA-1", data)
        const hb = new Uint8Array(hashBuf)
        assert('output length=20', hb.length === 20)
        assert('SHA-1(\'Hello\') matches', hb[0] === 0xF7 && hb[1] === 0xFF && hb[19] === 0xF0)

        t.section('TextEncoder')
        const enc = new TextEncoder()
        const encoded = enc.encode("Hello")
        assert('encode length', encoded.length === 5)
        assert('encode bytes', encoded[0] === 0x48 && encoded[4] === 0x6F)
        assert('encoding property', enc.encoding === 'utf-8')

        t.section('SHA-1 + btoa (WebSocket accept key)')
        const MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
        const testKey = 'dGhlIHNhbXBsZSBub25jZQ=='
        const concat = testKey + MAGIC_GUID
        const acceptBuf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(concat))
        const acceptBytes = new Uint8Array(acceptBuf)
        const acceptB64 = btoa(String.fromCharCode(...acceptBytes))
        assert('RFC 6455 accept key matches', acceptB64 === "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")

        let rejected = false
        try {
            await crypto.subtle.digest("SHA-256" as any, new Uint8Array(1))
        } catch {
            rejected = true
        }
        assert('unsupported algorithm rejected', rejected)
    }
}
