import '../lib/polyfill.js'
import * as std from 'std'
import { Tester } from './test_helper.js'

function assert(t: Tester, name: string, ok: boolean): void {
    if (ok) { t.ok++; std.printf('  PASS: %s\n', name) }
    else { t.fail++; std.printf('  FAIL: %s\n', name) }
}

export const suite = {
    name: 'polyfill',
    run: async (t: Tester) => {
        t.section('btoa/atob')
        const orig = "Hello\u0000World"
        const b64 = btoa(orig)
        const back = atob(b64)
        assert(t, 'btoa/atob roundtrip', back === orig)
        assert(t, 'btoa produces base64 chars', /^[A-Za-z0-9+/=]+$/.test(b64))

        const hash = new Uint8Array([0x2f, 0xd4, 0xe1, 0xc6, 0x7a, 0x2d, 0x28, 0xfc, 0xed, 0x84, 0x9e, 0xe1, 0xbb, 0x76, 0xe7, 0x39, 0x1b, 0x93, 0xeb, 0x12])
        assert(t, 'btoa(SHA-1 sample) matches known value', btoa(String.fromCharCode(...hash)) === "L9ThxnotKPzthJ7hu3bnORuT6xI=")

        t.section('crypto.getRandomValues')
        const buf = new Uint8Array(32)
        crypto.getRandomValues(buf)
        assert(t, 'length=32', buf.length === 32)
        assert(t, 'not all zeros', buf.some(b => b !== 0))

        t.section('crypto.subtle.digest SHA-1')
        const data = new TextEncoder().encode("Hello")
        const hashBuf = await crypto.subtle.digest("SHA-1", data)
        const hb = new Uint8Array(hashBuf)
        assert(t, 'output length=20', hb.length === 20)
        assert(t, 'SHA-1(\'Hello\') matches', hb[0] === 0xF7 && hb[1] === 0xFF && hb[19] === 0xF0)

        t.section('TextEncoder utf-8')
        const enc = new TextEncoder()
        assert(t, 'default encoding', enc.encoding === 'utf-8')
        const encoded = enc.encode("Hello")
        assert(t, 'encode length', encoded.length === 5)
        assert(t, 'encode bytes', encoded[0] === 0x48 && encoded[4] === 0x6F)
        assert(t, 'encoding property', enc.encoding === 'utf-8')

        const enc2 = new TextEncoder('utf-8')
        assert(t, 'utf-8 label', enc2.encoding === 'utf-8')

        const enc3 = new TextEncoder('utf8')
        assert(t, 'utf8 alias', enc3.encoding === 'utf-8')

        let threw = false
        try { new TextEncoder('gbk' as any) } catch (e) { threw = e instanceof RangeError }
        assert(t, 'unsupported label throws RangeError', threw)

        t.section('TextEncoder utf-16le')
        const enc16le = new TextEncoder('utf-16le')
        assert(t, 'encoding property', enc16le.encoding === 'utf-16le')

        const hello16le = enc16le.encode('AB')
        assert(t, 'length = 4', hello16le.length === 4)
        assert(t, 'A = 0x41 0x00', hello16le[0] === 0x41 && hello16le[1] === 0x00)
        assert(t, 'B = 0x42 0x00', hello16le[2] === 0x42 && hello16le[3] === 0x00)

        const null16le = enc16le.encode('\0')
        assert(t, 'null char = 0x00 0x00', null16le.length === 2 && null16le[0] === 0 && null16le[1] === 0)

        const chinese16le = enc16le.encode('\u4e2d') // 中 = U+4E2D
        assert(t, '中 = 0x2D 0x4E', chinese16le[0] === 0x2D && chinese16le[1] === 0x4E)

        t.section('TextEncoder utf-16be')
        const enc16be = new TextEncoder('utf-16be')
        assert(t, 'encoding property', enc16be.encoding === 'utf-16be')

        const hello16be = enc16be.encode('AB')
        assert(t, 'length = 4', hello16be.length === 4)
        assert(t, 'A = 0x00 0x41', hello16be[0] === 0x00 && hello16be[1] === 0x41)
        assert(t, 'B = 0x00 0x42', hello16be[2] === 0x00 && hello16be[3] === 0x42)

        t.section('TextDecoder utf-8')
        const dec = new TextDecoder()
        assert(t, 'default encoding', dec.encoding === 'utf-8')
        assert(t, 'default fatal', dec.fatal === false)
        assert(t, 'default ignoreBOM', dec.ignoreBOM === false)
        assert(t, 'decode utf-8 bytes', dec.decode(encoded) === 'Hello')
        assert(t, 'decode empty', dec.decode() === '')
        assert(t, 'decode null', dec.decode(null) === '')

        const decFatal = new TextDecoder('utf-8', { fatal: true })
        assert(t, 'fatal encoding', decFatal.encoding === 'utf-8')
        assert(t, 'fatal true', decFatal.fatal === true)

        let threw2 = false
        try { decFatal.decode(new Uint8Array([0xFF])) } catch (e) { threw2 = e instanceof TypeError }
        assert(t, 'fatal decode throws TypeError', threw2)

        const nonFatal = new TextDecoder()
        const replaced = nonFatal.decode(new Uint8Array([0xFF]))
        assert(t, 'non-fatal replaces with U+FFFD', replaced === '\uFFFD')

        t.section('TextDecoder utf-16le')
        const dec16le = new TextDecoder('utf-16le')
        assert(t, 'encoding = utf-16le', dec16le.encoding === 'utf-16le')

        const ab = new Uint8Array([0x41, 0x00, 0x42, 0x00])
        assert(t, 'AB from utf-16le', dec16le.decode(ab) === 'AB')

        const chn = new Uint8Array([0x2D, 0x4E])
        assert(t, '中 from utf-16le', dec16le.decode(chn) === '\u4e2d')

        const withBom = new Uint8Array([0xFF, 0xFE, 0x41, 0x00])
        assert(t, 'BOM stripped by default', dec16le.decode(withBom) === 'A')

        const dec16leNoBom = new TextDecoder('utf-16le', { ignoreBOM: true })
        assert(t, 'ignoreBOM keeps BOM', dec16leNoBom.decode(withBom) === '\uFEFFA')

        t.section('TextDecoder utf-16be')
        const dec16be = new TextDecoder('utf-16be')
        const be = new Uint8Array([0x00, 0x41, 0x00, 0x42])
        assert(t, 'AB from utf-16be', dec16be.decode(be) === 'AB')

        const chnBe = new Uint8Array([0x4E, 0x2D])
        assert(t, '中 from utf-16be', dec16be.decode(chnBe) === '\u4e2d')

        t.section('TextDecoder roundtrip')
        const texts = ['Hello', 'Hello 世界', '\u4e2d\u6587', 'A\0B', '\uD83D\uDE00'] // emoji
        for (const txt of texts) {
            const enc8 = new TextEncoder()
            const bytes = enc8.encode(txt)
            const dec8 = new TextDecoder()
            assert(t, `utf-8 roundtrip: ${txt}`, dec8.decode(bytes) === txt)

            const enc16le = new TextEncoder('utf-16le')
            const bytes16 = enc16le.encode(txt)
            const dec16le = new TextDecoder('utf-16le')
            assert(t, `utf-16le roundtrip: ${txt}`, dec16le.decode(bytes16) === txt)

            const enc16be = new TextEncoder('utf-16be')
            const bytes16be = enc16be.encode(txt)
            const dec16be = new TextDecoder('utf-16be')
            assert(t, `utf-16be roundtrip: ${txt}`, dec16be.decode(bytes16be) === txt)
        }

        t.section('SHA-1 + btoa (WebSocket accept key)')
        const MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
        const testKey = 'dGhlIHNhbXBsZSBub25jZQ=='
        const concat = testKey + MAGIC_GUID
        const acceptBuf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(concat))
        const acceptBytes = new Uint8Array(acceptBuf)
        const acceptB64 = btoa(String.fromCharCode(...acceptBytes))
        assert(t, 'RFC 6455 accept key matches', acceptB64 === "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")

        let rejected = false
        try {
            await crypto.subtle.digest("SHA-256" as any, new Uint8Array(1))
        } catch {
            rejected = true
        }
        assert(t, 'unsupported algorithm rejected', rejected)
    }
}
