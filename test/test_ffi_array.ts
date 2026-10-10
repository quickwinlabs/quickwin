import { Tester } from './test_helper.js'
import { bind } from '../lib/ffi/bind.js'
import { struct, structArray } from '../lib/ffi/struct.js'
import { NULL, normToken, PtrArrayBuffer, type MaybePtr, type Ptr } from '../lib/ffi/ctype.js'

// 编译期断言工具（仅类型层，运行时无开销）
type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false
function expectType<T extends true>(_value?: T): void {}

// 运行时 throw 捕获：返回错误文本（无异常 → 空串）
function throws(fn: () => unknown): string {
    try { fn(); return '' } catch (e) { return String(e) }
}

const POINT = struct('POINT', { x: 'i32', y: 'i32' })
const RECT = struct('RECT', { l: 'i32', t: 'i32', r: 'i32', b: 'i32' })
// 数组编解码对：encode 注册进 encoders 表后 <POINT>ptr 位收元素数组；
// decode 是出参数组读回（双态：buffer 自算/显式 count、裸地址 count 必填）
const POINTArr = structArray(POINT)

export const suite = {
    name: 'ffi-array',
    run: (t: Tester) => {
        t.section("normToken: '*' is an ordinary out-of-lexicon char (same as '+')")
        t.checkTrue("'<X*>ptr' rejected", throws(() => normToken('<POINT*>ptr')).includes('Unknown token'))
        t.checkTrue("'*'+'!' rejected", throws(() => normToken('<POINT*>ptr!')).includes('Unknown token'))
        t.checkTrue("'*'+'@' rejected", throws(() => normToken('<POINT*>ptr@Foo')).includes('Unknown token'))
        t.checkTrue('bare <*>ptr rejected', throws(() => normToken('<*>ptr')).includes('Unknown token'))
        t.checkTrue("'+' not in lexicon: generic Unknown token", throws(() => normToken('<POINT+>ptr')).includes('Unknown token'))
        t.checkTrue('name charset tightened (non-identifier rejected)',
            throws(() => normToken('<1abc>ptr')).includes('Unknown token'))
        t.check('plain <X>ptr unchanged', '<X>ptr', normToken('<X>ptr'))
        t.check('!-form unchanged', '<X>ptr!', normToken('<X>ptr!'))
        t.check('@-suffix stripped (enum annotation is type-layer only)', '<X>ptr', normToken('<X>ptr@Foo'))

        t.section('type layer: registered encoder derives the array value domain')
        // 注册数组 encoder 后：<POINT>ptr 位 = 非空元素数组（值域由 encoder 推导）∪ number 直通
        const PolylineT = bind('gdi32.dll', 'Polyline', '<HDC>ptr! <POINT>ptr i32 -> i32', { POINT: POINTArr })
        expectType<Equal<Parameters<typeof PolylineT>[1],
            readonly { readonly x?: number | undefined; readonly y?: number | undefined }[] | MaybePtr<'POINT'>>>()
        expectType<Equal<Parameters<typeof PolylineT>[0], Ptr<'HDC'>>>()
        // 类型专用块（只过 tsc、不执行）
        const typeOnly: unknown = () => {
            // @ts-expect-error 单对象不是元素数组（encoder 值域收数组，不收裸 POINT）
            PolylineT(0 as Ptr<'HDC'>, { x: 1, y: 2 }, 1)
            // @ts-expect-error 品牌拦错布局直传（RECT PAB 不是 POINT 位的值域——传 .ptr 走 number 直通）
            PolylineT(0 as Ptr<'HDC'>, RECT.alloc(), 1)
            // @ts-expect-error decode 的裸地址形 count 必填（地址无长度信息）
            POINTArr.decode(POINT.alloc().ptr)
        }
        t.checkTrue('type-only block wired', typeof typeOnly === 'function')

        t.section('structArray.encode: contiguous branded materialization')
        const pab = POINTArr.encode([{ x: 1, y: 2 }, { x: -3, y: 4 }])
        t.check('byteLength = n * size', 16, pab.byteLength)
        const pdv = new DataView(pab)
        t.check('[0].x', 1, pdv.getInt32(0, true))
        t.check('[0].y', 2, pdv.getInt32(4, true))
        t.check('[1].x', -3, pdv.getInt32(8, true))
        t.check('[1].y', 4, pdv.getInt32(12, true))
        t.checkTrue('PAB .ptr non-null (branded)', pab.ptr !== 0)
        // fail-loud：值域刻意收普通数组（直传变量），空/非数组/单对象全靠运行时
        // throw —— 任何路径都不产出 PAB(0)（其 .ptr 是"非 0 的 1 字节堆指针"，会骗过
        // C 的 NULL 防御）。
        t.checkTrue('[] fail-loud (never produces PAB(0))',
            throws(() => POINTArr.encode([])).includes('non-empty'))
        t.checkTrue('non-array fail-loud',
            throws(() => POINTArr.encode(123 as never)).includes('non-empty'))

        t.section('structArray.decode: self-evident / explicit count / address form')
        // 自算形态：纯元素序列 buffer（alloc）byteLength/size 整除自证
        t.check('self-computed n = byteLength/size', 3, POINTArr.decode(POINT.alloc(3)).length)
        const rt = POINTArr.decode(POINTArr.encode([{ x: 1, y: -2 }, { x: 3, y: 4 }]))
        t.check('roundtrip [0].x', 1, rt[0]!.x)
        t.check('roundtrip [1].y', 4, rt[1]!.y)
        // 混合缓冲（byteLength 非整数倍，如 EnumPrinters 的结构 + 尾部字符串）自算 fail-loud
        t.checkTrue('non-multiple byteLength fail-loud',
            throws(() => POINTArr.decode(new PtrArrayBuffer(7))).includes('multiple'))
        // 显式 count 越界防线：count*size 超 byteLength → 拦死（写错 count 的越界读入口）
        t.checkTrue('count beyond byteLength fail-loud',
            throws(() => POINTArr.decode(new PtrArrayBuffer(12), 2)).includes('exceeds'))
        t.checkTrue('negative count fail-loud',
            throws(() => POINTArr.decode(new PtrArrayBuffer(16), -1)).includes('non-negative'))
        t.check('count = 0 → []', 0, POINTArr.decode(POINT.alloc(), 0).length)
        // 裸地址形（C 返回的 T* / 预建缓冲 .ptr）：count 必填，逐字节拷读
        const addrBack = POINTArr.decode(pab.ptr, 2)
        t.check('address form count', 2, addrBack.length)
        t.check('address form [0].x', 1, addrBack[0]!.x)
        t.checkTrue('address without count throws at runtime (dynamic path)',
            throws(() => (POINTArr.decode as unknown as (p: number) => unknown[])(pab.ptr)).includes('count'))

        t.section('StructDef.alloc(n): n-slot zero-filled (default 1)')
        t.check('alloc() default = 1 slot', POINT.size, POINT.alloc().byteLength)
        t.check('alloc(3) = 3 slots', POINT.size * 3, POINT.alloc(3).byteLength)
        t.checkTrue('alloc slots zero-filled', new Int32Array(POINT.alloc(2))[3] === 0)
        t.checkTrue('alloc(0) fail-loud (PAB(0) never escapes)',
            throws(() => POINT.alloc(0)).includes('n >= 1'))
        t.checkTrue('alloc(-1) fail-loud', throws(() => POINT.alloc(-1)).includes('n >= 1'))
        t.checkTrue('alloc(1.5) fail-loud', throws(() => POINT.alloc(1.5)).includes('n >= 1'))

        t.section('StructDef.encode(v, buf, offset): positioned write primitive')
        const big = POINT.alloc(2)
        POINT.encode({ x: 7, y: -8 }, big, POINT.size)   // 写入第 2 槽
        const bdv = new DataView(big)
        t.check('slot 0 stays zero', 0, bdv.getInt32(0, true))
        t.check('slot 1.x written at offset', 7, bdv.getInt32(POINT.size, true))
        t.check('slot 1.y written at offset', -8, bdv.getInt32(POINT.size + 4, true))
        t.checkTrue('offset form returns the buf itself', POINT.encode({ x: 1, y: 2 }, big, 0) === big)

        t.section('registered encoder dispatch: kernel32!IsBadReadPtr observes the pointer C gets')
        const isBad = bind('kernel32.dll', 'IsBadReadPtr', '<POINT>ptr u64 -> i32', { POINT: POINTArr })
        t.check('3-point array: whole 24-byte region readable', 0, isBad([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }], 24n))
        t.check('number passthrough: prebuilt PAB .ptr', 0, isBad(pab.ptr, 16n))
        t.check('number passthrough: NULL literal', 1, isBad(NULL, 1n))
        t.checkTrue('bare object rejected at encoder',
            throws(() => isBad({ x: 1, y: 2 } as never, 8n)).includes('non-empty'))
        t.checkTrue('[] rejected at encoder (NULL stays explicit)',
            throws(() => isBad([], 8n)).includes('non-empty'))
        t.checkTrue('null rejected with NULL hint',
            throws(() => isBad(null as never, 8n)).includes('NULL'))

        t.section('content fidelity: msvcrt!memcpy reads encoder array source')
        const memcpy = bind('msvcrt.dll', 'memcpy', '<POINT>ptr <POINT>ptr u64 -> <>ptr', { POINT: POINTArr })
        const dst = POINT.alloc()
        memcpy(dst.ptr, [{ x: 7, y: -8 }], 8n)
        const back = POINT.decode(dst.ptr)
        t.check('copied x', 7, back.x)
        t.check('copied y', -8, back.y)

        t.section("decode(alloc()): '!' unfilled field fails (C did not fill)")
        const OutH = struct('OutH', { h: '<HANDLE>ptr!' })
        t.checkTrue("'!' 0 slot throws on decode",
            throws(() => OutH.decode(OutH.alloc())).includes("'!'"))

        t.section('bind-time lexicon checks (fail at module load)')
        t.checkTrue('<POINT+>ptr rejected at bind (not in lexicon)',
            throws(() => bind('kernel32.dll', 'IsBadReadPtr', '<POINT+>ptr u64 -> i32', { POINT: POINTArr })).includes('Unknown token'))
        t.checkTrue('<POINT*>ptr rejected at bind (out-of-lexicon)',
            throws(() => bind('kernel32.dll', 'IsBadReadPtr', '<POINT*>ptr u64 -> i32', { POINT: POINTArr })).includes('Unknown token'))
    }
}
