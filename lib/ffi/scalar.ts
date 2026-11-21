// 标量指针助手：为「指向单个整数/浮点」的 C 出参/入参槽提供与 struct 同构的
// alloc/decode 词汇，类型安全靠品牌（`I32.alloc().ptr` 是 `Ptr<'i32'>`，只能喂
// `<i32>ptr` 形参；`RECT.alloc().ptr` 喂 `<i32>ptr` 编译失败）。
//
// 刻意不做内置 codec：`builtinCodecs` 保持 `{ WCHAR, BYTE }`，`.ptr` 走 mkPtrWriter
// 的 number 快路径（buffer 只靠调用方 `const` 保活，禁止内联 `.alloc().ptr`）。
// 调用方一律 `const r = I32.alloc()` 后传 `r.ptr`，读回用 `I32.decode(r)`。
//
// 只导出 8 个整数助手（当前仓内浮点标量指针槽为 0；将来出现 `f32`/`f64` 槽时补
// `F32`/`F64`，工厂已支持——C_Integer 约束只限整数导出，浮点走 C_Number 面）。
//
// 与 StructDef.alloc 对齐：`alloc(n?)` 按 sizeof(T) 步长分配 n 个元素（默认 1），
// n < 1 / 非整数 fail-loud（PAB(0) 的 .ptr 是"非 0 的 1 字节堆指针"，会骗过 C 的
// NULL 防御；空位语义由调用方显式传 NULL）。
import { PtrArrayBuffer, readScalar, writeScalar, SizeAlign, type C_Integer } from './ctype.js'

export type ScalarValue<T extends C_Integer> = T extends 'u64' | 'i64' ? bigint : number

export interface Scalar<T extends C_Integer> {
    readonly size: number
    /** n（默认 1）= 按 sizeof(T) 步长连续分配 n 个元素的零填充缓冲，品牌 .ptr 直接
     *  喂 <T>ptr 位。n < 1 / 非整数 throw（同 struct.alloc）。 */
    alloc(n?: number): PtrArrayBuffer<T>
    /** 分配 1 元素 + 写初值（[in]/[inout] 带初值位，如 GetComputerName 的 pcchBuffer=260）；
     *  与 StructDef.encode 同构。 */
    encode(v: ScalarValue<T>): PtrArrayBuffer<T>
    /** 写进调用方既有缓冲起点（0 偏移；顶层不收 offset），返回 buf 本身（同 struct）。 */
    encode(v: ScalarValue<T>, buf: PtrArrayBuffer<''>): PtrArrayBuffer<''>
    /** 从缓冲起点读回第一个元素（u64/i64 → bigint；数组读回按需将来加 count 形态，
     *  与 structArray.decode(buf, count) 对齐——22 个现有槽全是单元素）。 */
    decode(buf: PtrArrayBuffer<T> | ArrayBuffer): ScalarValue<T>
}

function makeScalar<T extends C_Integer>(k: T): Scalar<T> {
    const size = SizeAlign[k]!
    return {
        size,
        alloc: (n) => {
            if (n !== undefined && (!Number.isInteger(n) || n < 1))
                throw new Error(`ffi-scalar: alloc(n) requires an integer n >= 1 ` +
                    `(PAB(0) never escapes — pass NULL for an empty pointer position)`)
            return new PtrArrayBuffer<T>(size * (n ?? 1))
        },
        // 返回类型统一 PtrArrayBuffer<T>（可赋给 PtrArrayBuffer<''>）：单方法签名才能
        // 同时满足两条重载的返回（encode(v)→PAB<T>、encode(v, buf)→PAB<''>，见接口）。
        encode: (v: ScalarValue<T>, buf?: PtrArrayBuffer<''>): PtrArrayBuffer<T> => {
            const b = buf ?? new PtrArrayBuffer<T>(size)
            writeScalar(new DataView(b), 0, { k, v } as Parameters<typeof writeScalar>[2])
            return b as PtrArrayBuffer<T>
        },
        decode: (buf) => readScalar(new DataView(buf), 0, k) as ScalarValue<T>,
    }
}

// 品牌小写 = 规范 token（`<i32>ptr` 的品牌与标量 token 一一对应）；导出名大写 = JS
// 标识符习惯（对齐 WCHAR / BYTE）。将来若给返回位注册 decode，builtinCodecs 的键
// 直接用 'i32'（小写），无需大小写映射。
// /* @__PURE__ */ 标记 esbuild 据此摇掉未引用的助手（同 structs.ts 的 struct 惯例；
// makeScalar 内 new PtrArrayBuffer 有潜在副作用，不标则未用的 7 个调用会被保留）。
export const I8  = /* @__PURE__ */ makeScalar('i8')
export const I16 = /* @__PURE__ */ makeScalar('i16')
export const I32 = /* @__PURE__ */ makeScalar('i32')
export const I64 = /* @__PURE__ */ makeScalar('i64')
export const U8  = /* @__PURE__ */ makeScalar('u8')
export const U16 = /* @__PURE__ */ makeScalar('u16')
export const U32 = /* @__PURE__ */ makeScalar('u32')
export const U64 = /* @__PURE__ */ makeScalar('u64')
