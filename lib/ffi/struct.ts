import '../text-codec.js'
import * as ffi from 'ffi'
import {
    PTR_SIZE, type StructPtr, type Ptr, type CPointer,
    type CInteger, type CFloat,
    type CType, type CString, type CArray,
    type CStruct, type CUnion, type Member, type Encoding,
} from './ctype.js'

// ============================================================
// 聚合定义（唯一 API：CType IR，member 数组即定义）：
//   struct([...member])                  — 匿名结构体
//   struct('RECT', [...member])          — 命名结构体（alloc().ptr 带 Ptr<'RECT'> 品牌）
//   union([...member])                   — 匿名联合体
//   union('U', [...member])              — 命名联合体（同样可用于 <U>ptr 布局）
// 可选 { pack } 压对齐上限。layout 采用 MSVC 对齐语义：
//   i8/u8→1  i16/u16→2  i32/u32/f32→4  i64/u64/f64→8  '<>ptr'/'<T>ptr'→arch 宽(4/8)
//   struct 对齐 = 最大字段对齐，总尺寸末尾补齐；pack 压上限、alignas 抬下限
// ============================================================

// ============================================================
// 类型推导 — CType IR
// ============================================================

// 指针成员：'<>ptr' → number（T='' 品牌退化）；'<NAME>ptr' → Ptr<NAME>（品牌 number）。
// 该品牌 number 可直接喂 bind 的 <NAME>ptr 形参（裸地址透传）。
type ValOf<C extends CType> =
    C extends CPointer<infer T> ? Ptr<T>
    : C extends CInteger | CFloat ? number
    : C extends CString ? string
    : C extends CArray ? Tuple<ValOf<C['ctype']>, C['length']>
    : C extends CStruct | CUnion ? ShapeOfC<C['member']>
    : never

type Tuple<T, N extends number, R extends T[] = []> =
    number extends N ? T[]
    : R['length'] extends N ? R
    : R['length'] extends 64 ? T[]
    : Tuple<T, N, [...R, T]>

type ShapeOfC<M extends readonly Member[]> = M extends readonly [
    infer H extends Member,
    ...infer T extends readonly Member[]
] ? (FieldShape<H> & ShapeOfC<T>) : {}

type FieldShape<M extends Member> =
    M extends { name?: undefined; type: infer T extends CStruct | CUnion }
    ? ShapeOfC<T['member']>
    : M extends { name: infer N extends string; type: infer T extends CType }
    ? { [K in N]: ValOf<T> }
    : {}

// ============================================================
// 运行时类型
// ============================================================

// lower 后指针统一归一为内部 kind 'ptr'（用户面写 '<>ptr' 裸地址或 '<NAME>ptr' 带名指针）。
type RuntimeKind = CInteger | CFloat | 'ptr'

// kind → size/align（不含指针：指针统一 PTR_SIZE，见 lower）。
const SizeAlign: Record<CInteger | CFloat, number> = {
    u8: 1, i8: 1,
    u16: 2, i16: 2,
    u32: 4, i32: 4,
    u64: 8, i64: 8,
    f32: 4, f64: 8,
}

// 运行时 Field：IR 的 lowered 视图（独立于 CType，不保留 Member/alignas）。
// computeStructLayout 在 lowering 时把子布局内嵌进 FieldType（struct/union→fields，
// array→elementType+elementSize），运行期 read/write 零查表；offset 相对本层起点。
type FieldType =
    { tag: 'basic', kind: RuntimeKind }
    | { tag: 'string', encoding: Encoding }
    | { tag: 'struct' | 'union', fields: Field[] }
    | { tag: 'array', elementType: FieldType, elementSize: number }
export type Field = {
    name: string
    offset: number
    size: number
    type: FieldType
}
export type Fields = Field[]

// StructDef — struct()/union() 返回
export type StructDef<T extends CStruct | CUnion, N extends string = never> = {
    readonly __struct: T
    readonly size: number
    readonly structAlign: number
    decode(buf: ArrayBuffer, offset?: number): ShapeOfC<T['member']>
    encode(v: ShapeOfC<T['member']>, buf?: ArrayBuffer, offset?: number): ArrayBuffer
    offsetOf(name: string): number
    alloc(): StructAlloc<ShapeOfC<T['member']>, N>
}

export type StructAlloc<S, N extends string = never> = {
    readonly buffer: ArrayBuffer
    readonly ptr: [N] extends [never] ? number : StructPtr<N>
    decode(offset?: number): S
}

// ============================================================
// Layout IR —— computeStructLayout/lower 把 CType AST IR lower 到此。
// 自包含：子布局在 lowering 时内嵌、offset 相对本层起点，运行期 read/write 不回查 AST IR。
// ============================================================

/** 向上对齐（a 必须是 2 的幂）。 */
function alignUp(v: number, a: number): number {
    return (v + a - 1) & ~(a - 1)
}

type Layout = {
    size: number,
    maxEffectiveAlign: number,
    fields: Fields,
}

// 用户面指针 CType：'<>ptr' / '<NAME>ptr'（'ptr' 已被拒绝，见 lower）。
const PTR_CTYPE_RE = /^<.*>ptr$/

// 用户面已拒绝裸 'ptr'，但运行时仍可能收到（手写 IR / 迁移残留）—— 统一在此报错。
// 用类型守卫绕开「FieldKind 已不含 'ptr'」的收窄报错。
function isBarePtr(t: string): t is 'ptr' {
    return t === 'ptr'
}

// CType → { size, align, FieldType }：聚合递归进 computeStructLayout。
// 每个子树每层只 lower 一次（array 元素复用同一结果），不再分别算 size 和 type。
function lower(t: CType): { size: number, align: number, type: FieldType } {
    if (typeof t === 'string') {
        if (isBarePtr(t))
            throw new Error(`ffi-struct: bare "ptr" rejected — use "<>ptr" for a raw address or "<NAME>ptr" for a typed pointer`)
        if (PTR_CTYPE_RE.test(t))
            return { size: PTR_SIZE, align: PTR_SIZE, type: { tag: 'basic', kind: 'ptr' } }
        const s = SizeAlign[t as CInteger | CFloat]
        if (s === undefined) throw new Error(`ffi-struct: unknown kind "${t}"`)
        return { size: s, align: s, type: { tag: 'basic', kind: t as CInteger | CFloat } }
    }
    if (t.tag === 'string') {
        if (!Number.isInteger(t.length) || t.length < 1)
            throw new Error(`ffi-struct: string length must be an integer >= 1, got ${t.length}`)
        const s = SizeAlign[t.unit]
        return { size: s * t.length, align: s, type: { tag: 'string', encoding: t.encoding } }
    }
    if (t.tag === 'array') {
        if (!Number.isInteger(t.length) || t.length < 1)
            throw new Error(`ffi-struct: array length must be an integer >= 1, got ${t.length}`)
        const el = lower(t.ctype)
        return {
            size: el.size * t.length,
            align: el.align,
            type: { tag: 'array', elementType: el.type, elementSize: el.size },
        }
    }
    // struct | union
    const l = computeStructLayout(t)
    return { size: l.size, align: l.maxEffectiveAlign, type: { tag: t.tag, fields: l.fields } }
}

export function computeArray(t: CArray): { align: number, size: number } {
    const { size, align } = lower(t)
    return { align, size }
}

export function computeStructLayout(t: CStruct | CUnion): Layout {
    const isStruct = t.tag === 'struct'
    const pack = t.pack ?? 8
    let maxEffectiveAlign = 1
    let maxMemberSize = 0
    const fields: Fields = []
    let cursor = 0

    for (const m of t.member) {
        const { size, align: natural, type } = lower(m.type)
        let align = natural
        if (pack > 0) align = Math.min(pack, align)
        if (m.alignas) align = Math.max(align, m.alignas)
        const offset = alignUp(cursor, align)

        if (m.name !== undefined) {
            fields.push({ name: m.name, offset, size, type })
        } else {
            // 匿名聚合：m.type 必为 struct/union，内嵌 fields 已 lower 好，offset 平移到本成员起点。
            for (const cf of (type as { fields: Fields }).fields)
                fields.push({ ...cf, offset: cf.offset + offset })
        }

        if (isStruct) cursor = offset + size
        maxEffectiveAlign = Math.max(maxEffectiveAlign, align)
        maxMemberSize = Math.max(maxMemberSize, size)
    }

    return {
        size: isStruct ? alignUp(cursor, maxEffectiveAlign) : alignUp(maxMemberSize, maxEffectiveAlign),
        maxEffectiveAlign,
        fields,
    }
}

// ============================================================
// 读取 / 写入
// ============================================================

function readScalar(dv: DataView, off: number, k: RuntimeKind): number {
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

function writeScalar(dv: DataView, off: number, k: RuntimeKind, val: number): void {
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

// 字符串读写统一走 TextEncoder/TextDecoder（polyfill 见 lib/text-codec.js）。
// 定长字段：写入把编码结果截断到 size，读取扫到 NUL 终止符为止。
const stringEncoders: Record<Encoding, TextEncoder> = {
    'utf-8': new TextEncoder('utf-8'),
    'utf-16le': new TextEncoder('utf-16le'),
}

const stringDecoders: Record<Encoding, TextDecoder> = {
    'utf-8': new TextDecoder('utf-8', { ignoreBOM: true }),
    'utf-16le': new TextDecoder('utf-16le', { ignoreBOM: true }),
}

function readString(dv: DataView, off: number, size: number, enc: Encoding): string {
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset + off, size)
    const unit = enc === 'utf-16le' ? 2 : 1
    let end = size
    for (let i = 0; i + unit <= size; i += unit) {
        if (bytes[i] === 0 && (unit === 1 || bytes[i + 1] === 0)) { end = i; break }
    }
    return stringDecoders[enc].decode(bytes.subarray(0, end))
}

function writeString(dv: DataView, off: number, size: number, enc: Encoding, v: unknown): void {
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset + off, size)
    bytes.fill(0)
    // 始终给 NUL 终止符留一个存储单元（宽度由 encoding 决定，见 readString）：
    // 末尾保持 0，payload 最多 size - unit 字节。这样 C 侧 strlen/wcslen 都不会越界。
    const unit = enc === 'utf-16le' ? 2 : 1
    const cap = size - unit
    if (cap <= 0) return
    const src = stringEncoders[enc].encode(String(v ?? ''))
    bytes.set(src.subarray(0, Math.min(src.length, cap)))
}

type ArrayFieldType = Extract<FieldType, { tag: 'array' }>

function readArray(dv: DataView, off: number, size: number, t: ArrayFieldType): unknown[] {
    const count = t.elementSize > 0 ? size / t.elementSize : 0
    const out: unknown[] = []
    for (let i = 0; i < count; i++)
        out.push(readElement(dv, off + i * t.elementSize, t.elementType, t.elementSize))
    return out
}

function writeArray(dv: DataView, off: number, size: number, t: ArrayFieldType, v: unknown): void {
    const count = t.elementSize > 0 ? size / t.elementSize : 0
    const list = (v ?? []) as unknown[]
    for (let i = 0; i < count; i++)
        writeElement(dv, off + i * t.elementSize, t.elementType, t.elementSize, list[i])
}

function readElement(dv: DataView, off: number, t: FieldType, size: number): unknown {
    switch (t.tag) {
        case 'basic': return readScalar(dv, off, t.kind)
        case 'string': return readString(dv, off, size, t.encoding)
        case 'struct':
        case 'union': return doDecode(dv, off, t.fields)
        case 'array': return readArray(dv, off, size, t)
    }
}

function writeElement(dv: DataView, off: number, t: FieldType, size: number, val: unknown): void {
    switch (t.tag) {
        case 'basic': writeScalar(dv, off, t.kind, Number(val ?? 0)); break
        case 'string': writeString(dv, off, size, t.encoding, val); break
        case 'struct':
        case 'union': doEncode(dv, off, t.fields, (val ?? {}) as Record<string, unknown>); break
        case 'array': writeArray(dv, off, size, t, val); break
    }
}

function doDecode(dv: DataView, base: number, fields: Fields): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const f of fields)
        out[f.name] = readElement(dv, base + f.offset, f.type, f.size)
    return out
}

function doEncode(dv: DataView, base: number, fields: Fields, v: Record<string, unknown>): void {
    for (const f of fields)
        writeElement(dv, base + f.offset, f.type, f.size, v[f.name])
}

// ============================================================
// 内部构造器
// ============================================================

function createStruct(t: CStruct | CUnion): any {
    const { fields, size, maxEffectiveAlign } = computeStructLayout(t)
    return {
        __struct: t,
        size,
        structAlign: maxEffectiveAlign,
        decode: (buf: ArrayBuffer, offset = 0) => doDecode(new DataView(buf), offset, fields),
        encode: (v: any, buf?: ArrayBuffer, offset = 0) => {
            const out = buf ?? new ArrayBuffer(size)
            doEncode(new DataView(out), offset, fields, v)
            return out
        },
        offsetOf: (name: string) => {
            for (const f of fields) if (f.name === name) return f.offset
            throw new Error(`ffi-struct: no field "${name}"`)
        },
        alloc: () => {
            const buffer = new ArrayBuffer(size)
            return {
                buffer,
                ptr: ffi.bufferPtr(buffer),
                decode: (offset = 0) => doDecode(new DataView(buffer), offset, fields),
            }
        },
    }
}

// ============================================================
// 公共 API
// ============================================================

/** 聚合对齐上限（pack 压 maxAlign，语义同 MSVC #pragma pack）。 */
export type AggOpts = { pack?: number }

/** member 数组定义结构体。给 name 则 alloc().ptr 带 Ptr<name> 品牌。 */
export function struct<const M extends readonly Member[]>(member: M, opts?: AggOpts): StructDef<{ tag: 'struct'; member: M; pack?: number }, never>
export function struct<const N extends string, const M extends readonly Member[]>(name: N, member: M, opts?: AggOpts): StructDef<{ tag: 'struct'; member: M; pack?: number }, N>
export function struct(a: string | readonly Member[], b?: readonly Member[] | AggOpts, c?: AggOpts): StructDef<any, any> {
    const member = (typeof a === 'string' ? b : a) as readonly Member[]
    const opts = (typeof a === 'string' ? c : b) as AggOpts | undefined
    return createStruct({ tag: 'struct', member, ...(opts?.pack !== undefined ? { pack: opts.pack } : {}) })
}

/** member 数组定义联合体；布局/读写与 struct 相同，仅成员偏移重叠。 */
export function union<const M extends readonly Member[]>(member: M, opts?: AggOpts): StructDef<{ tag: 'union'; member: M; pack?: number }, never>
export function union<const N extends string, const M extends readonly Member[]>(name: N, member: M, opts?: AggOpts): StructDef<{ tag: 'union'; member: M; pack?: number }, N>
export function union(a: string | readonly Member[], b?: readonly Member[] | AggOpts, c?: AggOpts): StructDef<any, any> {
    const member = (typeof a === 'string' ? b : a) as readonly Member[]
    const opts = (typeof a === 'string' ? c : b) as AggOpts | undefined
    return createStruct({ tag: 'union', member, ...(opts?.pack !== undefined ? { pack: opts.pack } : {}) })
}

/** 从 native 拥有的 `<STRUCT>ptr` 解码（ptr === null → null）。 */
export function structFromPtr<S>(
    def: { size: number; decode(buf: ArrayBuffer, offset?: number): S },
    ptr: number | null,
): S | null {
    if (ptr === null) return null
    const buf = new ArrayBuffer(def.size)
    const u8 = new Uint8Array(buf)
    for (let i = 0; i < u8.length; i++) u8[i] = ffi.readByte(ptr + i)
    return def.decode(buf)
}
