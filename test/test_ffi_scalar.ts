// 标量指针助手（lib/ffi/scalar.ts）单测：I8..U64 的 alloc/encode/decode 运行时语义。
// 纯 JS 断言（不调 Windows API），但 import 链经 ctype.ts 依赖 'ffi'/'os' 原生模块，
// 故在 qwin 运行时内跑（test/run.ts 套件，win11/xp 两架构结果应一致）。
//
// 覆盖此前零直接断言的路径：
//   - I8/I16/U8/U16（仓内无槽位使用，无间接覆盖）
//   - I32（IsWow64Process 无调用点、SetFilePointer 传 NULL → 零覆盖）
//   - alloc 校验（n<1/非整数 throw，从未触发过）
//   - encode(v, buf) 重载（写既有缓冲 + 返回 buf 本体）
//   - i32 负值位模式 / u32 无符号 / i64·u64 bigint
import { Tester } from './test_helper.js'
import { I8, I16, I32, I64, U8, U16, U32, U64 } from '../lib/ffi/scalar.js'

function throws(fn: () => unknown): boolean {
    try { fn(); return false } catch { return true }
}

export const suite = {
    name: 'ffi-scalar',
    run: (t: Tester) => {
        t.section('alloc/encode/decode roundtrip: I8..U64')
        t.check('I8 roundtrip 127', 127, I8.decode(I8.encode(127)))
        t.check('I8 roundtrip -128', -128, I8.decode(I8.encode(-128)))
        t.check('U8 roundtrip 255', 255, U8.decode(U8.encode(255)))
        t.check('I16 roundtrip -32768', -32768, I16.decode(I16.encode(-32768)))
        t.check('U16 roundtrip 65535', 65535, U16.decode(U16.encode(65535)))
        t.check('I32 roundtrip -2147483648', -2147483648, I32.decode(I32.encode(-2147483648)))
        t.check('U32 roundtrip 4294967295', 4294967295, U32.decode(U32.encode(4294967295)))
        t.check('I64 roundtrip -1n', -1n, I64.decode(I64.encode(-1n)))
        t.check('U64 roundtrip 2^64-1', 2n ** 64n - 1n, U64.decode(U64.encode(2n ** 64n - 1n)))

        t.section('i32 negative bit pattern / u32 unsigned semantics')
        const i32b = I32.encode(-1)
        t.check('I32.encode(-1) underlying uint32 = 0xFFFFFFFF', 0xffffffff, new DataView(i32b).getUint32(0, true))
        t.check('I32.decode reads back -1 (not 4294967295)', -1, I32.decode(i32b))
        const u32b = U32.encode(0xffffffff)
        t.check('U32.encode(0xFFFFFFFF) underlying uint32 = 0xFFFFFFFF', 0xffffffff, new DataView(u32b).getUint32(0, true))
        t.check('U32.decode reads back 4294967295 (not -1)', 4294967295, U32.decode(u32b))

        t.section('alloc: size / validation / multi-element stride')
        t.check('I32.alloc() byteLength = 4', 4, I32.alloc().byteLength)
        t.check('I32.alloc(3) byteLength = 12', 12, I32.alloc(3).byteLength)
        t.check('U64.alloc(2) byteLength = 16', 16, U64.alloc(2).byteLength)
        t.checkTrue('I32.alloc(0) throws', throws(() => I32.alloc(0)))
        t.checkTrue('I32.alloc(-1) throws', throws(() => I32.alloc(-1)))
        t.checkTrue('I32.alloc(2.5) throws', throws(() => I32.alloc(2.5)))
        const arr = I32.alloc(3)
        const adv = new DataView(arr)
        adv.setInt32(0, 11, true)
        adv.setInt32(4, 22, true)
        adv.setInt32(8, -33, true)
        t.check('multi-element stride: [0]', 11, adv.getInt32(0, true))
        t.check('multi-element stride: [4]', 22, adv.getInt32(4, true))
        t.check('multi-element stride: [8]', -33, adv.getInt32(8, true))
        t.check('I32.decode reads first element of multi', 11, I32.decode(arr))

        t.section('encode(v, buf) overload: write into existing buffer')
        const buf = U32.alloc()
        const ret = U32.encode(7, buf)
        t.checkTrue('encode(v, buf) returns buf itself', ret === buf)
        t.check('encode(v, buf) wrote value into buf', 7, U32.decode(buf))
        t.check('decode accepts plain ArrayBuffer', 7, U32.decode(new Uint8Array([7, 0, 0, 0]).buffer))
    },
}
