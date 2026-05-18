import * as brotli from 'brotli'
import { Tester } from './test_helper.js'

function abToString(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf)
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return s
}

// pre-compressed with brotli CLI: "hello brotli! this is a test of decompression"
const COMPRESSED_HEX = 'a16001c0ef4cb07142bdbbe12588185985d055995ca6b1bdb52083f4028dc6e59c8660a24efa701549c30701'

function hexToArrayBuffer(hex: string): ArrayBuffer {
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < hex.length; i += 2)
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
    return bytes.buffer as ArrayBuffer
}

export const suite = {
    name: 'brotli',
    run: (t: Tester) => {
        t.section('decompress function exists')
        t.checkTrue('decompress is function', typeof brotli.decompress === 'function')

        t.section('decompress known string')
        const compressed = hexToArrayBuffer(COMPRESSED_HEX)
        const decompressed = brotli.decompress(compressed)
        t.checkTrue('returns ArrayBuffer', decompressed instanceof ArrayBuffer)
        const result = abToString(decompressed)
        t.check('roundtrip', 'hello brotli! this is a test of decompression', result)

        t.section('invalid data throws')
        let threw = false
        try {
            brotli.decompress(new ArrayBuffer(10))
        } catch (e) {
            threw = true
        }
        t.checkTrue('throws on invalid brotli data', threw)

        t.section('non-ArrayBuffer throws')
        let threw2 = false
        try {
            ;(brotli as any).decompress('not a buffer')
        } catch (e) {
            threw2 = true
        }
        t.checkTrue('throws on non-ArrayBuffer', threw2)
    }
}
