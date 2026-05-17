import * as zstd from 'zstd'
import { Tester } from './test_helper.js'

function abToString(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf)
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return s
}

export const suite = {
    name: 'zstd',
    run: (t: Tester) => {
        t.section('compress and decompress string')
        const original = 'hello zstd! this is a test of compression'
        const compressed = zstd.compress(original)
        t.checkTrue('compress returns ArrayBuffer', compressed instanceof ArrayBuffer)

        const decompressed = zstd.decompress(compressed)
        t.checkTrue('decompress returns ArrayBuffer', decompressed instanceof ArrayBuffer)

        const result = abToString(decompressed)
        t.check('roundtrip', original, result)

        t.section('compress with different levels')
        const comp1 = zstd.compress(original, 1)
        const comp19 = zstd.compress(original, 19)
        t.checkTrue('level 19 smaller than level 1', comp19.byteLength <= comp1.byteLength)

        t.section('longer text compresses well')
        const longText = 'hello world '.repeat(1000)
        const compLong = zstd.compress(longText)
        t.checkTrue('long text compresses', compLong.byteLength < longText.length)

        const deLong = zstd.decompress(compLong)
        t.checkTrue('long roundtrip match', abToString(deLong) === longText)

        t.section('empty string')
        const empty = zstd.compress('')
        const emptyDe = zstd.decompress(empty)
        t.check('empty roundtrip', '', abToString(emptyDe))

        t.section('binary data roundtrip')
        const bin = new ArrayBuffer(256)
        const view = new Uint8Array(bin)
        for (let i = 0; i < 256; i++) view[i] = i
        const compBin = zstd.compress(bin)
        t.checkTrue('binary compress', compBin instanceof ArrayBuffer)
        const deBin = zstd.decompress(compBin)
        t.check('binary size', bin.byteLength, deBin.byteLength)
        const deView = new Uint8Array(deBin)
        let match = true
        for (let i = 0; i < 256; i++) { if (view[i] !== deView[i]) { match = false; break } }
        t.checkTrue('binary content matches', match)
    }
}
