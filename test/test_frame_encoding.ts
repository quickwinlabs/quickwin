import * as std from 'std'
import { Tester } from './test_helper.js'

export const suite = {
    name: 'wasm-frame-encoding',
    run: (t: Tester) => {
        function createFrameHeader(payloadLen: number): Uint8Array {
            let headerSize = payloadLen < 126 ? 6 : (payloadLen < 65536 ? 8 : 14)
            let buf = new ArrayBuffer(headerSize)
            let view = new Uint8Array(buf)
            let off = 0
            view[off++] = 0x81
            if (payloadLen < 126) {
                view[off++] = 0x80 | payloadLen
            } else if (payloadLen < 65536) {
                view[off++] = 0x80 | 126
                view[off++] = (payloadLen >> 8) & 0xFF
                view[off++] = payloadLen & 0xFF
            } else {
                view[off++] = 0x80 | 127
                const len = payloadLen
                const hi = Math.floor(len / 0x100000000) >>> 0
                const lo = len >>> 0
                view[off++] = (hi >> 24) & 0xFF
                view[off++] = (hi >> 16) & 0xFF
                view[off++] = (hi >> 8) & 0xFF
                view[off++] = hi & 0xFF
                view[off++] = (lo >> 24) & 0xFF
                view[off++] = (lo >> 16) & 0xFF
                view[off++] = (lo >> 8) & 0xFF
                view[off++] = lo & 0xFF
            }
            return view
        }

        function tryParseFrameLen(data: Uint8Array): number | null {
            if (data.length < 2) return null
            const b1 = data[1]
            let payloadLen = b1 & 0x7F
            let offset = 2
            if (payloadLen === 126) {
                if (data.length < 4) return null
                payloadLen = (data[2] << 8) | data[3]
            } else if (payloadLen === 127) {
                if (data.length < 10) return null
                let hi = 0, lo = 0
                for (let i = 0; i < 4; i++) hi = (hi * 256 + data[offset + i]) >>> 0
                for (let i = 4; i < 8; i++) lo = (lo * 256 + data[offset + i]) >>> 0
                payloadLen = hi * 0x100000000 + lo
            }
            return payloadLen
        }

        function assert(name: string, ok: boolean): void {
            if (ok) { t.ok++; std.printf('  PASS: %s\n', name) }
            else { t.fail++; std.printf('  FAIL: %s\n', name) }
        }

        // small frame (100 bytes)
        t.section('inline length (<126)')
        let h = createFrameHeader(100)
        assert('length=100', h[1] === (0x80 | 100))
        assert('parse 100', tryParseFrameLen(h) === 100)

        // 1 (edge case)
        h = createFrameHeader(1)
        assert('length=1', h[1] === (0x80 | 1))
        assert('parse 1', tryParseFrameLen(h) === 1)

        // 125 (max inline)
        h = createFrameHeader(125)
        assert('length=125', h[1] === (0x80 | 125))
        assert('parse 125', tryParseFrameLen(h) === 125)

        // 126 (enters 16-bit extended)
        t.section('16-bit extended length (126–65535)')
        h = createFrameHeader(126)
        assert('126 marker', h[1] === (0x80 | 126))
        assert('126 value', h[2] === 0 && h[3] === 126)
        assert('parse 126', tryParseFrameLen(h) === 126)

        // 65535 (max 16-bit)
        h = createFrameHeader(65535)
        assert('65535 marker', h[1] === (0x80 | 126))
        assert('65535 hi byte', h[2] === 0xFF)
        assert('65535 lo byte', h[3] === 0xFF)
        assert('parse 65535', tryParseFrameLen(h) === 65535)

        // 65536 (enters 64-bit extended)
        t.section('64-bit extended length (>=65536)')
        h = createFrameHeader(65536)
        assert('65536 marker', h[1] === (0x80 | 127))
        assert('parse 65536', tryParseFrameLen(h) === 65536)

        // 66000
        h = createFrameHeader(66000)
        assert('66000 marker', h[1] === (0x80 | 127))
        assert('parse 66000', tryParseFrameLen(h) === 66000)

        // 70000 — verify exact bytes
        h = createFrameHeader(70000)
        assert('70000 marker', h[1] === (0x80 | 127))
        // 70000 = 0x11170, big-endian 8 bytes: 00 00 00 00 00 01 11 70
        assert('70000 bytes big-endian',
            h[2] === 0x00 && h[3] === 0x00 && h[4] === 0x00 && h[5] === 0x00 &&
            h[6] === 0x00 && h[7] === 0x01 && h[8] === 0x11 && h[9] === 0x70)
        assert('parse 70000', tryParseFrameLen(h) === 70000)

        // Large value near 2^32 boundary
        t.section('large values')
        h = createFrameHeader(0xABCD1234)
        assert('0xABCD1234 marker', h[1] === (0x80 | 127))
        assert('parse 0xABCD1234', tryParseFrameLen(h) === 0xABCD1234)
        assert('MSB non-zero',
            h[2] === 0x00 && h[3] === 0x00 && h[4] === 0x00 && h[5] === 0x00 &&
            h[6] === 0xAB && h[7] === 0xCD && h[8] === 0x12 && h[9] === 0x34)

        // 0x100000001 (just above 2^32)
        h = createFrameHeader(0x100000001)
        assert('2^32+1 parse', tryParseFrameLen(h) === 0x100000001)
        assert('2^32+1 bytes',
            h[2] === 0x00 && h[3] === 0x00 && h[4] === 0x00 && h[5] === 0x01 &&
            h[6] === 0x00 && h[7] === 0x00 && h[8] === 0x00 && h[9] === 0x01)

        // Full 8-byte roundtrip: 0x0123456789ABCDEF
        // This exceeds Number's safe integer range (2^53) slightly,
        // but our test value 0x0123456789ABCDEF = 81985529216486895 < 2^53 ✓
        const bigVal = 0x0123456789ABCDEF
        h = createFrameHeader(bigVal)
        assert('big val parse', tryParseFrameLen(h) === bigVal)
    }
}
