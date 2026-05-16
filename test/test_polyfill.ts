import '../lib/polyfill.js'
import * as std from 'std'

let pass = 0, fail = 0
function check(ok: boolean, msg: string) {
    if (ok) { pass++; std.printf("  PASS: %s\n", msg) }
    else { fail++; std.printf("  FAIL: %s\n", msg) }
}

function section(name: string) {
    std.printf("\n=== %s ===\n", name)
}

async function main() {
    // btoa / atob
    section("btoa/atob")
    const orig = "Hello\u0000World"
    const b64 = btoa(orig)
    const back = atob(b64)
    check(back === orig, "btoa/atob roundtrip")
    check(/^[A-Za-z0-9+/=]+$/.test(b64), "btoa produces base64 chars")

    // btoa with known SHA-1 output
    const hash = new Uint8Array([0x2f, 0xd4, 0xe1, 0xc6, 0x7a, 0x2d, 0x28, 0xfc, 0xed, 0x84, 0x9e, 0xe1, 0xbb, 0x76, 0xe7, 0x39, 0x1b, 0x93, 0xeb, 0x12])
    const b64hash = btoa(String.fromCharCode(...hash))
    check(b64hash === "L9ThxnotKPzthJ7hu3bnORuT6xI=", "btoa(SHA-1 sample) matches known value")

    // crypto.getRandomValues
    section("crypto.getRandomValues")
    const buf = new Uint8Array(32)
    crypto.getRandomValues(buf)
    check(buf.length === 32, "length=32")
    check(buf.some(b => b !== 0), "not all zeros")

    // crypto.subtle.digest SHA-1
    section("crypto.subtle.digest SHA-1")
    const data = new TextEncoder().encode("Hello")
    const hashBuf = await crypto.subtle.digest("SHA-1", data)
    const hb = new Uint8Array(hashBuf)
    check(hb.length === 20, "output length=20")
    // SHA-1("Hello") = F7FF9E8B7BB2E09B70935A5D785E0CC5D4D0ABF0
    check(hb[0] === 0xF7 && hb[1] === 0xFF && hb[19] === 0xF0, "SHA-1('Hello') matches")

    // TextEncoder
    section("TextEncoder")
    const enc = new TextEncoder()
    const encoded = enc.encode("Hello")
    check(encoded.length === 5, "encode length")
    check(encoded[0] === 0x48 && encoded[4] === 0x6F, "encode bytes")
    check(enc.encoding === 'utf-8', "encoding property")

    // SHA-1 with string matching WebSocket usage
    section("SHA-1 + btoa (WebSocket accept key)")
    const MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
    const testKey = 'dGhlIHNhbXBsZSBub25jZQ=='
    const concat = testKey + MAGIC_GUID
    const acceptBuf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(concat))
    const acceptBytes = new Uint8Array(acceptBuf)
    const acceptB64 = btoa(String.fromCharCode(...acceptBytes))
    check(acceptB64 === "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", "RFC 6455 accept key matches")

    // Unsupported algorithm rejection
    let rejected = false
    try {
        await crypto.subtle.digest("SHA-256" as any, new Uint8Array(1))
    } catch {
        rejected = true
    }
    check(rejected, "unsupported algorithm rejected")

    std.printf("\n%d/%d passed, %d failed\n", pass, pass + fail, fail)
    if (fail > 0) std.exit(1)
}

main()
