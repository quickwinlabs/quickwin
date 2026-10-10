import { Tester } from './test_helper.js'
import { bind } from '../lib/ffi/bind.js'
import { struct } from '../lib/ffi/struct.js'
import { NULL, ptrName, normToken, PtrArrayBuffer, type MaybePtr, type Ptr } from '../lib/ffi/ctype.js'

// 编译期断言工具（仅类型层，运行时无开销）
type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false
function expectType<T extends true>(_value?: T): void {}
// 从签名串推导参数元组 / 返回类型（纯类型层，不执行 bind）
type ParamsOf<S extends string> = Parameters<ReturnType<typeof bind<S, {}>>>
type RetOf<S extends string> = ReturnType<ReturnType<typeof bind<S, {}>>>

// 运行时 throw 捕获：返回错误文本（无异常 → 空串）
function throws(fn: () => unknown): string {
    try { fn(); return '' } catch (e) { return String(e) }
}

const POINT = struct('POINT', { x: 'i32', y: 'i32' })
const RECT = struct('RECT', { l: 'i32', t: 'i32', r: 'i32', b: 'i32' })

export const suite = {
    name: 'ffi-array',
    run: (t: Tester) => {
        t.section('array token lexicon (normToken / ptrName)')
        t.check('normToken keeps * on token', '<POINT*>ptr', normToken('<POINT*>ptr'))
        t.check('ptrName strips * (codec keyed by bare name)', 'POINT', ptrName('<POINT*>ptr'))
        t.checkTrue("'+' not in lexicon: generic Unknown token", throws(() => normToken('<POINT+>ptr')).includes('Unknown token'))
        t.checkTrue("'*'+'!' combo throws", throws(() => normToken('<POINT*>ptr!')).includes('forbidden'))
        t.checkTrue("'*'+'@' combo throws", throws(() => normToken('<POINT*>ptr@Foo')).includes("'@'"))
        t.checkTrue('bare <*>ptr rejected (regex)', throws(() => normToken('<*>ptr')).includes('Unknown token'))
        t.checkTrue('name charset tightened (non-identifier rejected)',
            throws(() => normToken('<1abc>ptr')).includes('Unknown token'))
        t.check('plain <X>ptr unchanged', '<X>ptr', normToken('<X>ptr'))
        t.check('!-form unchanged', '<X>ptr!', normToken('<X>ptr!'))

        t.section('type layer: * position derives array-of-element')
        // 无注册布局时元素形塌 never：位 = readonly never[] | MaybePtr<'X'>
        expectType<Equal<ParamsOf<'<X*>ptr -> i32'>[0], readonly never[] | MaybePtr<'X'>>>()
        // 禁用形塌 never（参数位 = 调用点全红）：
        expectType<Equal<ParamsOf<'<X*>ptr! -> i32'>[0], never>>()
        expectType<Equal<ParamsOf<'<X*>ptr@Foo -> i32'>[0], never>>()
        expectType<Equal<ParamsOf<'<*>ptr -> i32'>[0], never>>()
        // 返回位禁数组字形：塌 unknown（非法返回位的既有策略，逼显式收窄）
        expectType<Equal<RetOf<'i32 -> <X*>ptr'>, unknown>>()
        const PolylineT = bind('gdi32.dll', 'Polyline', '<HDC>ptr! <POINT*>ptr i32 -> i32', { POINT })
        // 注册布局后元素形 = 单对象 EncodeIn（DeepPartial 契合 —— struct() 的 const M 把
        // 字段推成只读属性，同构映射链保留 readonly）∪ number 直通：
        expectType<Equal<Parameters<typeof PolylineT>[1],
            readonly { readonly x?: number; readonly y?: number }[] | MaybePtr<'POINT'>>>()
        expectType<Equal<Parameters<typeof PolylineT>[0], Ptr<'HDC'>>>()
        // 类型专用块（只过 tsc、不执行 —— 单对象直传 * 位是编译错）
        const typeOnly: unknown = () => {
            // @ts-expect-error 单对象不是数组（元素位收 readonly EncodeIn[]，不收裸 POINT）
            PolylineT(0 as Ptr<'HDC'>, { x: 1, y: 2 }, 1)
            // @ts-expect-error NULL 之外的裸字符串不是指针词汇
            PolylineT(0 as Ptr<'HDC'>, 'nope', 1)
            // @ts-expect-error encodeArray 收非空元组：[] 字面量是编译错（运行时另有 throw 兜底）
            POINT.encodeArray([])
            // @ts-expect-error decodeArray 只收 PAB：裸 ArrayBuffer 不进（"裸 ArrayBuffer
            // 出不了 codec" 闭环 —— 无品牌可拦错布局、无 .ptr 可直通）
            POINT.decodeArray(new ArrayBuffer(16))
            // @ts-expect-error 品牌拦错布局解码（stride 推进下 RECT 缓冲 × POINT 步长 = 静默乱读）
            POINT.decodeArray(RECT.alloc())
        }
        t.checkTrue('type-only block wired', typeof typeOnly === 'function')

        t.section('StructDef.encodeArray: contiguous layout')
        const pab = POINT.encodeArray([{ x: 1, y: 2 }, { x: -3, y: 4 }])
        t.check('byteLength = n * size', 16, pab.byteLength)
        const pdv = new DataView(pab)
        t.check('[0].x', 1, pdv.getInt32(0, true))
        t.check('[0].y', 2, pdv.getInt32(4, true))
        t.check('[1].x', -3, pdv.getInt32(8, true))
        t.check('[1].y', 4, pdv.getInt32(12, true))
        t.checkTrue('PAB .ptr non-null', pab.ptr !== 0)
        // 类型层已把 [] 拦成编译错（见上方 typeOnly 块）——这里 cast 绕过类型，验证运行时
        // throw 兜底动态路径（as 或动态构建的数组），任何路径都不产出 PAB(0)。
        t.checkTrue('encodeArray([]) fail-loud (never produces PAB(0))',
            throws(() => POINT.encodeArray([] as never)).includes('non-empty'))
        t.checkTrue('encodeArray(non-array) fail-loud',
            throws(() => POINT.encodeArray(123 as never)).includes('non-empty'))

        t.section('callPacked dispatch: kernel32!IsBadReadPtr observes the pointer C gets')
        const isBad = bind('kernel32.dll', 'IsBadReadPtr', '<POINT*>ptr u64 -> i32', { POINT })
        t.check('3-point array: whole 24-byte region readable', 0, isBad([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }], 24n))
        // ★ 空数组 → NULL(0)：IsBadReadPtr(NULL,1)=TRUE。若走 PAB(0)（非 0 的 1 字节堆
        // 指针）会返回 FALSE —— 本断言同时实证"引擎把 [] 确定性编为 0"。
        t.check('empty array encodes as NULL', 1, isBad([], 1n))
        t.check('number passthrough: prebuilt PAB .ptr', 0, isBad(pab.ptr, 16n))
        t.check('number passthrough: NULL literal', 1, isBad(NULL, 1n))
        t.checkTrue('bare object rejected at runtime',
            throws(() => isBad({ x: 1, y: 2 } as never, 8n)).includes('expects an array'))
        t.checkTrue('null rejected with NULL hint',
            throws(() => isBad(null as never, 8n)).includes('NULL'))

        t.section('content fidelity: msvcrt!memcpy reads array source')
        const memcpy = bind('msvcrt.dll', 'memcpy', '<POINT*>ptr <POINT*>ptr u64 -> <>ptr', { POINT })
        const dst = POINT.alloc()
        memcpy(dst.ptr, [{ x: 7, y: -8 }], 8n)
        const back = POINT.decode(dst.ptr)
        t.check('copied x', 7, back.x)
        t.check('copied y', -8, back.y)

        t.section('StructDef.decodeArray: PAB read-back (count = byteLength / size)')
        // as const：encodeArray 收非空元组（动态数组变量需 as 收窄 —— 运行时另有 throw 兜底）
        const src2 = [{ x: 1, y: 2 }, { x: -3, y: 4 }] as const
        const rp = POINT.decodeArray(POINT.encodeArray(src2))
        t.check('round-trip: count derived from byteLength', 2, rp.length)
        t.check('round-trip: deep equal', JSON.stringify(src2), JSON.stringify(rp))
        // 出数组位通路：预分配缓冲 .ptr 直通 → C 覆写（memcpy 模拟）→ decodeArray 读回
        const out2 = POINT.encodeArray([{ x: 0, y: 0 }, { x: 0, y: 0 }])
        memcpy(out2.ptr, src2, 16n)
        t.check('C-written buffer: deep equal', JSON.stringify(src2), JSON.stringify(POINT.decodeArray(out2)))
        t.checkTrue('zero-byte PAB → [] (read side is vacuously safe)',
            POINT.decodeArray(new PtrArrayBuffer(0) as never).length === 0)
        t.checkTrue('non-multiple byteLength fail-loud',
            throws(() => POINT.decodeArray(new PtrArrayBuffer(6) as never)).includes('not a multiple'))
        // '!' 字段未填（全 0 槽）→ doDecode 既有 0 断言传播，同 decode(alloc()) 的"C 没填"语义
        const OutH = struct('OutH', { h: '<HANDLE>ptr!' })
        t.checkTrue("'!' unfilled field fails on read-back",
            throws(() => OutH.decodeArray(new PtrArrayBuffer(8) as never)).includes("'!'"))

        t.section('bind-time capability checks (fail before first call)')
        t.checkTrue('<WCHAR*>ptr: builtin lacks encodeArray',
            throws(() => bind('kernel32.dll', 'IsBadReadPtr', '<WCHAR*>ptr u64 -> i32')).includes('lacks encodeArray'))
        t.checkTrue('<NOPE*>ptr: unregistered layout',
            throws(() => bind('kernel32.dll', 'IsBadReadPtr', '<NOPE*>ptr u64 -> i32')).includes('no registered layout'))
        t.checkTrue('array token on return position rejected',
            throws(() => bind('msvcrt.dll', 'memcpy', '<POINT*>ptr u64 -> <POINT*>ptr', { POINT })).includes('argument positions'))
        t.checkTrue('<POINT+>ptr rejected at bind (not in lexicon)',
            throws(() => bind('kernel32.dll', 'IsBadReadPtr', '<POINT+>ptr u64 -> i32', { POINT })).includes('Unknown token'))
        t.checkTrue("'*'+'!' combo rejected at bind",
            throws(() => bind('kernel32.dll', 'IsBadReadPtr', '<POINT*>ptr! u64 -> i32', { POINT })).includes('forbidden'))
    }
}
