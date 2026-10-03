import * as ffi from 'ffi'
import { normKind, isPointerLayout, PTR_SIZE, type Kind, type Norm, type StructPtr } from './kind.js'

// 声明式结构体定义：
//   struct({ field: 'i32', arr: 'i32[4]', name: arrayOf('u16', 32, 'utf16'), child: SubStruct })
// layout 采用 MSVC 对齐语义：
//   i8/u8→1   i16/u16→2   i32/u32/f32→4   i64/u64/f64→8   ptr→arch 宽(4/8)
//   struct 对齐 = 最大字段对齐，总尺寸末尾补齐
// 字段类型：
//   标量 kind（含 ffi-bind 的 C typedef 别名：int/DWORD/LPARAM/HANDLE...）
//   标量定长数组：'i32[4]' / 'u16[8]'（也可 arrayOf('i32', 4)）→ 元组 [number, number, number, number]
//   arrayOf(元素, N, encoding?)：定长数组。元素为标量 token 或子 struct：
//     arrayOf('u16', 32, 'utf16')  → string（宽字符；写按 N-1 截断+补 0，读取止于 NUL）
//     arrayOf('u8', 32, 'latin1')  → string（单字节 0..255，同样 NUL 终止/截断）
//     arrayOf(PT, 8)               → 元组 [ShapeOf<PT>, ...]（struct 数组，不接受 encoding）
//   嵌套 struct：字段值直接传子 struct 定义对象（内联 by value）

// 结构体字段可用的标量 kind（bind 的 Kind 去掉非字段类型 void/u64n/i64n）。
type FieldKind = Exclude<Kind, 'void' | 'u64n' | 'i64n'>

// kind → [align, size]
const AS: Record<FieldKind, [number, number]> = {
    u8: [1, 1], i8: [1, 1],
    u16: [2, 2], i16: [2, 2],
    u32: [4, 4], i32: [4, 4],
    u64: [8, 8], i64: [8, 8],
    f32: [4, 4], f64: [8, 8],
    ptr: [PTR_SIZE, PTR_SIZE],
}

type KnownScalar = FieldKind

// 字符串数组的解释方式：存储元素类型（u8/u16...）+ encoding 共同决定 NUL 终止的 string。
//   utf16  宽字符（元素宽 2）
//   latin1 单字节 0..255 ↔ U+0000..00FF（元素宽 1；不是 Windows ANSI codepage）
export type Encoding = 'utf16' | 'latin1'

// 定长数组的类型：N 为字面量时展开为元组（最多 64 个元素），否则退化为普通数组。
// 元组可在编译期校验长度；配合 noUncheckedIndexedAccess 时按字面量下标取值不再带 | undefined。
type Tuple<T, N extends number, R extends T[] = []> =
    number extends N ? T[]
    : R['length'] extends N ? R
    : R['length'] extends 64 ? T[]
    : Tuple<T, N, [...R, T]>

type ValOf<S extends string> = S extends `${infer B}[${infer C extends number}]`
    ? (Norm<B> extends KnownScalar ? Tuple<number, C> : never)
    : S extends KnownScalar ? number
    : Norm<S> extends KnownScalar ? number : never

export type StructShape<T extends Record<string, unknown> = Record<string, unknown>> = {
    readonly __fields: T
    readonly size: number
    readonly structAlign: number
}

// arrayOf 描述符：定长数组字段。元素为标量 token 或子 struct；encoding 仅对标量元素有效。
export type StructArray<
    E extends string | StructShape = string | StructShape,
    N extends number = number,
    Enc extends Encoding | undefined = undefined,
> = {
    readonly __element: E
    readonly __count: N
    readonly __encoding: Enc
    readonly __structArray: true
}

/** 构造数值/struct 定长数组：arrayOf('i32', 4) / arrayOf(POINT, 8)。 */
export function arrayOf<const E extends string | StructShape, const N extends number>(element: E, count: N): StructArray<E, N>
/** 构造字符串定长数组：arrayOf('u16', 32, 'utf16') / arrayOf('char', 32, 'latin1')。 */
export function arrayOf<const E extends string, const N extends number, const Enc extends Encoding>(element: E, count: N, encoding: Enc): StructArray<E, N, Enc>
export function arrayOf(element: string | StructShape, count: number, encoding?: Encoding): StructArray {
    if (!Number.isInteger(count) || count < 1)
        throw new Error(`ffi-struct: arrayOf count must be an integer >= 1, got ${count}`)
    if (encoding !== undefined && encoding !== 'utf16' && encoding !== 'latin1')
        throw new Error(`ffi-struct: unknown encoding "${String(encoding)}"`)
    return { __element: element, __count: count, __encoding: encoding, __structArray: true } as StructArray
}

type StructField = string | StructShape | StructArray<string | StructShape, number, Encoding | undefined>
type Def = Record<string, StructField>

type ShapeOf<T extends Record<string, unknown>> = {
    [K in keyof T]:
        T[K] extends string ? ValOf<T[K]>
        : T[K] extends StructArray<infer E, infer N, infer Enc>
            ? Enc extends Encoding ? string
              : E extends string ? Tuple<ValOf<E>, N>
              : E extends StructShape ? Tuple<ShapeOf<E['__fields']>, N>
              : never
        : T[K] extends StructShape ? ShapeOf<T[K]['__fields']>
        : never
}

// alloc() 返回的 out 句柄：持有 buffer（存活即保证 ptr 有效），decode() 从本 buffer 解码。
// 命名 struct（struct('RECT', {...})）→ ptr: StructPtr<N>，可直接喂给 `<N>ptr` 形参；
// 未命名（struct({...})）→ ptr: number（品牌不可得，只能自己转型或改用命名）。
export type StructAlloc<F extends Def, N extends string = never> = {
    readonly buffer: ArrayBuffer
    readonly ptr: [N] extends [never] ? number : StructPtr<N>
    decode(offset?: number): ShapeOf<F>
}

// encode = JS 形 → 二进制内存（LE/MSVC 布局），可写进调用者给的 buf+offset；
// decode = 二进制内存 → JS 形。命名避开 File/stream 的 read/write。
export type StructDef<F extends Def, N extends string = never> = StructShape<F> & {
    decode(buf: ArrayBuffer, offset?: number): ShapeOf<F>
    encode(v: ShapeOf<F>, buf?: ArrayBuffer, offset?: number): ArrayBuffer
    offsetOf(name: keyof F): number
    /** 分配零初始化 out buffer，返回 { buffer, ptr, decode } 句柄 */
    alloc(): StructAlloc<F, N>
}

type Field = {
    name: string
    offset: number
    isArray: boolean
    count: number          // 元素个数（非数组 = 1）
    kind: FieldKind        // 标量元素 kind（struct 字段以 'u8' 占位）
    encoding?: Encoding    // 字符串数组的解释方式
    child?: StructShape
}

function alignUp(v: number, a: number): number {
    return (v + a - 1) & ~(a - 1)
}

// 单个标量 token → kind（含 C typedef 别名）。指针布局 / void / u64n 等不可作字段。
function scalarKind(token: string): FieldKind {
    if (isPointerLayout(token)) throw new Error(`ffi-struct: invalid scalar field type "${token}"`)
    let b: string
    try { b = normKind(token) } catch { throw new Error(`ffi-struct: invalid scalar field type "${token}"`) }
    if (b === 'void' || !(b in AS)) throw new Error(`ffi-struct: invalid scalar field type "${token}"`)
    return b as FieldKind
}

function isStructArray(v: unknown): v is StructArray {
    return typeof v === 'object' && v !== null && (v as { __structArray?: unknown }).__structArray === true
}

function layout(def: Def): { fields: Field[]; size: number; structAlign: number } {
    const fields: Field[] = []
    let cursor = 0
    let maxAlign = 1
    for (const key of Object.keys(def)) {
        const v = def[key] as StructField
        let a: number
        let w: number
        let f: Field
        if (typeof v === 'string') {
            // 'i32[4]' 标量数组糖（仅数值；字符串数组须用 arrayOf(..., encoding)）
            const m = /^(.+)\[(\d+)\]$/.exec(v)
            if (m) {
                const count = Number(m[2])
                if (count < 1) throw new Error(`ffi-struct: array count must be >= 1 in "${v}"`)
                const kind = scalarKind(m[1]!)
                a = AS[kind][0]
                w = AS[kind][1] * count
                f = { name: key, offset: 0, isArray: true, count, kind }
            } else {
                const kind = scalarKind(v)
                a = AS[kind][0]
                w = AS[kind][1]
                f = { name: key, offset: 0, isArray: false, count: 1, kind }
            }
        } else if (isStructArray(v)) {
            const count = v.__count
            const el = v.__element
            const enc = v.__encoding
            if (typeof el === 'string') {
                const kind = scalarKind(el)
                const width = AS[kind][1]
                if (enc === 'utf16' && width !== 2)
                    throw new Error(`ffi-struct: encoding "utf16" requires a 2-byte element in "${key}"`)
                if (enc === 'latin1' && width !== 1)
                    throw new Error(`ffi-struct: encoding "latin1" requires a 1-byte element in "${key}"`)
                a = AS[kind][0]
                w = width * count
                f = { name: key, offset: 0, isArray: true, count, kind, encoding: enc }
            } else {
                if (enc !== undefined) throw new Error(`ffi-struct: encoding is not valid for struct array "${key}"`)
                a = el.structAlign
                w = el.size * count
                f = { name: key, offset: 0, isArray: true, count, kind: 'u8', child: el }
            }
        } else {
            const child = v as StructShape
            a = child.structAlign
            w = child.size
            f = { name: key, offset: 0, isArray: false, count: 1, kind: 'u8', child }
        }
        f.offset = alignUp(cursor, a)
        cursor = f.offset + w
        if (a > maxAlign) maxAlign = a
        fields.push(f)
    }
    return { fields, size: alignUp(cursor, maxAlign), structAlign: maxAlign }
}

const _layoutCache = new WeakMap<object, { fields: Field[]; size: number; structAlign: number }>()

function buildLayout(def: Def): { fields: Field[]; size: number; structAlign: number } {
    let hit = _layoutCache.get(def)
    if (hit) return hit
    hit = layout(def)
    _layoutCache.set(def, hit)
    return hit
}

function readScalar(dv: DataView, off: number, k: FieldKind): number {
    switch (k) {
        case 'u8': return dv.getUint8(off)
        case 'i8': return dv.getInt8(off)
        case 'u16': return dv.getUint16(off, true)
        case 'i16': return dv.getInt16(off, true)
        case 'u32': return dv.getUint32(off, true)
        case 'i32': return dv.getInt32(off, true)
        case 'u64': return Number(dv.getBigUint64(off, true))
        case 'i64': return Number(dv.getBigInt64(off, true))
        case 'f32': return dv.getFloat32(off, true)
        case 'f64': return dv.getFloat64(off, true)
        case 'ptr': return readPtr(dv, off)
    }
}

function readPtr(dv: DataView, off: number): number {
    if (PTR_SIZE === 8) return Number(dv.getBigUint64(off, true))
    return dv.getUint32(off, true)
}

function writeScalar(dv: DataView, off: number, k: FieldKind, val: number): void {
    switch (k) {
        case 'u8': dv.setUint8(off, val); break
        case 'i8': dv.setInt8(off, val); break
        case 'u16': dv.setUint16(off, val, true); break
        case 'i16': dv.setInt16(off, val, true); break
        case 'u32': dv.setUint32(off, val >>> 0, true); break
        case 'i32': dv.setInt32(off, val | 0, true); break
        case 'u64': dv.setBigUint64(off, BigInt(Math.trunc(val)), true); break
        case 'i64': dv.setBigInt64(off, BigInt(Math.trunc(val)), true); break
        case 'f32': dv.setFloat32(off, val, true); break
        case 'f64': dv.setFloat64(off, val, true); break
        case 'ptr': writePtr(dv, off, val); break
    }
}

function writePtr(dv: DataView, off: number, val: number): void {
    if (PTR_SIZE === 8) dv.setBigUint64(off, BigInt(Math.trunc(val)), true)
    else dv.setUint32(off, val >>> 0, true)
}

// 字符串数组：读取止于首个 NUL，写入按 N-1 截断并补 0（至少保留一个结尾 NUL）。
// utf16 按 2 字节码元、latin1 按单字节；符号元素（char/SHORT）在读时按掩码归一到无符号。
function readString(dv: DataView, off: number, count: number, kind: FieldKind, enc: Encoding): string {
    const step = enc === 'utf16' ? 2 : 1
    const mask = enc === 'utf16' ? 0xFFFF : 0xFF
    let s = ''
    for (let i = 0; i < count; i++) {
        const u = readScalar(dv, off + i * step, kind) & mask
        if (u === 0) break
        s += String.fromCharCode(u)
    }
    return s
}

function writeString(dv: DataView, off: number, count: number, kind: FieldKind, enc: Encoding, v: unknown): void {
    const step = enc === 'utf16' ? 2 : 1
    for (let i = 0; i < count; i++) writeScalar(dv, off + i * step, kind, 0)
    const s = String(v ?? '')
    const n = Math.min(s.length, count - 1)
    for (let i = 0; i < n; i++) writeScalar(dv, off + i * step, kind, s.charCodeAt(i))
}

function readField(dv: DataView, base: number, f: Field): unknown {
    const off = base + f.offset
    if (f.encoding) return readString(dv, off, f.count, f.kind, f.encoding)
    if (f.child) {
        if (!f.isArray) return decodeInto(f.child, dv.buffer as ArrayBuffer, off)
        const out: unknown[] = []
        for (let i = 0; i < f.count; i++)
            out.push(decodeInto(f.child, dv.buffer as ArrayBuffer, off + i * f.child.size))
        return out
    }
    if (f.isArray) {
        const out: number[] = []
        const step = AS[f.kind]![1]
        for (let i = 0; i < f.count; i++) out.push(readScalar(dv, off + i * step, f.kind))
        return out
    }
    return readScalar(dv, off, f.kind)
}

function writeField(dv: DataView, base: number, f: Field, v: unknown): void {
    const off = base + f.offset
    if (f.encoding) { writeString(dv, off, f.count, f.kind, f.encoding, v); return }
    if (f.child) {
        if (!f.isArray) { encodeInto(f.child, v as Record<string, unknown>, dv.buffer as ArrayBuffer, off); return }
        const list = (v ?? []) as Record<string, unknown>[]
        for (let i = 0; i < f.count; i++)
            encodeInto(f.child, list[i] ?? {}, dv.buffer as ArrayBuffer, off + i * f.child.size)
        return
    }
    if (f.isArray) {
        const step = AS[f.kind]![1]
        const list = (v ?? []) as number[]
        for (let i = 0; i < f.count; i++) writeScalar(dv, off + i * step, f.kind, list[i] ?? 0)
        return
    }
    writeScalar(dv, off, f.kind, Number(v))
}

function doSize(def: Def): number {
    return buildLayout(def).size
}

function decodeInto<S>(child: StructShape, buf: ArrayBuffer, offset: number): S {
    const r = child as unknown as { decode(b: ArrayBuffer, o: number): S }
    return r.decode(buf, offset)
}

function doDecode<F extends Def>(_def: F, fields: Field[], buf: ArrayBuffer, offset: number): ShapeOf<F> {
    const out: Record<string, unknown> = {}
    const dv = new DataView(buf)
    for (const f of fields) out[f.name] = readField(dv, offset, f)
    return out as ShapeOf<F>
}

function doEncode<F extends Def>(def: F, fields: Field[], v: ShapeOf<F>, buf?: ArrayBuffer, offset = 0): ArrayBuffer {
    buf = buf ?? new ArrayBuffer(doSize(def))
    const dv = new DataView(buf)
    for (const f of fields) writeField(dv, offset, f, (v as Record<string, unknown>)[f.name])
    return buf
}

function encodeInto<W>(child: StructShape, v: Record<string, unknown>, buf: ArrayBuffer, offset: number): void {
    const w = child as unknown as { encode(i: W, b: ArrayBuffer, o: number): unknown }
    w.encode(v as W, buf, offset)
}

// 命名式：struct('RECT', {...}) → StructDef<F, 'RECT'>，其 alloc().ptr 为 StructPtr<'RECT'>，
// 可直接作为 `<RECT>ptr` 实参（前提：签名 token 与命名一致，否则编译期报错）。
export function struct<const N extends string, const F extends Def>(name: N, def: F): StructDef<F, N>
// 匿名式：struct({...}) → StructDef<F>（N=never），alloc().ptr 退化为 number。
export function struct<const F extends Def>(def: F): StructDef<F>
export function struct(a: string | Def, b?: Def): StructDef<any, any> {
    const def = (typeof a === 'string' ? b : a) as Def
    const { fields, size, structAlign } = buildLayout(def)
    return {
        __fields: def,
        size,
        structAlign,
        decode: (buf: ArrayBuffer, offset = 0) => doDecode(def, fields, buf, offset),
        encode: (v: any, buf?: ArrayBuffer, offset = 0) => doEncode(def, fields, v, buf, offset),
        offsetOf: (name: string) => {
            for (const f of fields) if (f.name === name) return f.offset
            throw new Error(`ffi-struct: no field "${name}"`)
        },
        alloc: () => {
            const buffer = new ArrayBuffer(size)
            return {
                buffer,
                ptr: ffi.bufferPtr(buffer),
                decode: (offset = 0) => doDecode(def, fields, buffer, offset),
            }
        },
    } as StructDef<any, any>
}

// 从 native 拥有的 `<STRUCT>ptr` 解码：按 size 逐字节拷到新 buffer 再 decode（ptr === null → null）。
// 与 alloc() 相反方向：alloc 是 JS 提供 out buffer，structFromPtr 是读 native 返回的指针。
export function structFromPtr<F extends Def, N extends string>(
    def: StructDef<F, N>,
    ptr: number | null,
): ShapeOf<F> | null {
    if (ptr === null) return null
    const buf = new ArrayBuffer(def.size)
    const u8 = new Uint8Array(buf)
    for (let i = 0; i < u8.length; i++) u8[i] = ffi.readByte(ptr + i)
    return def.decode(buf)
}
