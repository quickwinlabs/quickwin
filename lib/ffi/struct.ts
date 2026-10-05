import '../text-codec.js'
import * as ffi from 'ffi'
import {
    PTR_SIZE, type Ptr, type Kind, type C_Number, type C_Integer,
    type CString, type CArray, type CBitfield,
    type CMemberType,
    type CStruct, type CUnion, type Member, type Encoding,
    isCPtrToken,
    isCInteger,
} from './ctype.js'

// ============================================================
// 聚合定义：唯一 API 是 CType IR（member 数组即定义），签名与 pack 见末尾 struct()/union()。
// layout 采用 MSVC 对齐语义：
//   i8/u8→1  i16/u16→2  i32/u32/f32→4  i64/u64/f64→8  '<>ptr'/'<T>ptr'→arch 宽(4/8)
//   struct 对齐 = 最大字段对齐，总尺寸末尾补齐；pack 压上限、alignas 抬下限
//   位域布局规则见下方 computeStructLayout 的状态机注释（mingw 实测 DCB/COMSTAT）。
// ============================================================

// ============================================================
// 类型推导 — CType IR
// ============================================================

// 指针成员：'<>ptr' → number（T='' 品牌退化）；'<NAME>ptr' → Ptr<NAME>（品牌 number）。
// 该品牌 number 可直接喂 bind 的 <NAME>ptr 形参（裸地址透传）。
type ValOf<C extends CMemberType> =
    C extends `<${infer T}>ptr` ? Ptr<T>
    : C extends C_Number ? number
    : C extends CBitfield ? number
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
    : M extends { name: infer N extends string; type: infer T extends CMemberType }
    ? { [K in N]: ValOf<T> }
    : {}

// ============================================================
// 运行时类型
// ============================================================

// lower 后指针统一归一为内部 kind 'ptr'（用户面写 '<>ptr' 或 '<NAME>ptr'）。
type RuntimeKind = Exclude<Kind, 'void' | 'u64n' | 'i64n'>

// kind → size/align（不含指针：指针统一 PTR_SIZE，见 lower）。
const SizeAlign: Record<C_Number, number> = {
    u8: 1, i8: 1,
    u16: 2, i16: 2,
    u32: 4, i32: 4,
    u64: 8, i64: 8,
    f32: 4, f64: 8,
}

// 运行时 Field：IR 的 lowered 视图（独立于 CType，不保留 Member/alignas）。
// computeStructLayout 在 lowering 时把子布局内嵌进 FieldType（struct/union→fields，
// array→elementType+elementSize，bitfield→bit 单元内偏移），运行期 read/write 零查表。
// offset 相对本层起点；位域成员的 offset 是其存储单元的基址（不是位域自己的地址）。
type FieldType =
    { tag: 'basic', kind: RuntimeKind }
    | { tag: 'bitfield', unit: C_Integer, bit: number, width: number }
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
    readonly ptr: [N] extends [never] ? number : Ptr<N>
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

// 用户面已拒绝裸 'ptr'，运行时仍可能收到（手写 IR）—— 用类型守卫绕开收窄报错，统一在此抛。
function isBarePtr(t: string): t is 'ptr' {
    return t === 'ptr'
}

// CType → { size, align, FieldType }：聚合递归进 computeStructLayout；array 元素复用同一结果。
function lower(t: CMemberType): { size: number, align: number, type: FieldType } {
    if (typeof t === 'string') {
        if (isBarePtr(t))
            throw new Error(`ffi-struct: bare "ptr" rejected — use "<>ptr" for a raw address or "<NAME>ptr" for a typed pointer`)
        if (isCPtrToken(t))
            return { size: PTR_SIZE, align: PTR_SIZE, type: { tag: 'basic', kind: 'ptr' } }
        const s = SizeAlign[t]
        if (s === undefined) throw new Error(`ffi-struct: unknown kind "${t}"`)
        return { size: s, align: s, type: { tag: 'basic', kind: t } }
    }
    if (t.tag === 'string') {
        if (!Number.isInteger(t.length) || t.length < 1)
            throw new Error(`ffi-struct: string length must be an integer >= 1, got ${t.length}`)
        const s = SizeAlign[t.unit]
        return { size: s * t.length, align: s, type: { tag: 'string', encoding: t.encoding } }
    }
    if (t.tag === 'bitfield') {
        // 手写 IR 可能绕过 C_Integer 约束，运行时把关。
        if (!isCInteger(t.unit))
            throw new Error(`ffi-struct: bitfield unit "${t.unit}" must be an integer kind`)
        const s = SizeAlign[t.unit]
        const cap = s * 8
        if (!Number.isInteger(t.width) || t.width < 1)
            throw new Error(`ffi-struct: bitfield width must be an integer >= 1, got ${t.width}`)
        if (t.width > cap)
            throw new Error(`ffi-struct: bitfield width ${t.width} exceeds unit width ${cap}`)
        // bit 是单元内偏移，由 computeStructLayout 的位域状态机填写；这里占位 0。
        return { size: s, align: s, type: { tag: 'bitfield', unit: t.unit, bit: 0, width: t.width } }
    }
    if (t.tag === 'array') {
        if (!Number.isInteger(t.length) || t.length < 1)
            throw new Error(`ffi-struct: array length must be an integer >= 1, got ${t.length}`)
        const el = lower(t.ctype)
        if (el.type.tag === 'bitfield')
            throw new Error('ffi-struct: bitfields cannot be array elements')
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

    // 位域组状态：unitBase 是当前存储单元的字节基址（-1 = 不在位域组内），
    // unitBits 是单元内已用位数，unitSize 是单元宽（字节）。
    // MSVC 规则（mingw 交叉实测 DCB/COMSTAT 验证）：
    //   - 连续同宽位域共单元，LSB→MSB（签别不参与分组）
    //   - 放不下的位域开新单元，单元剩余位废弃
    //   - 非位域成员打断位域组，游标跳到完整单元边界（不是按字节截断）
    // 联合体位域同样按 struct 方式打包（实测 u.a=1 后 u.b==0，各占自己的位，不别名）。
    let unitBase = -1
    let unitBits = 0
    let unitSize = 0

    // 落定当前位域组：游标 = 单元起点 + 已用字节数，向上取整到单元宽。
    const flushUnit = () => {
        if (unitBase < 0) return
        cursor = alignUp(unitBase + Math.ceil(unitBits / 8), unitSize)
        unitBase = -1
    }

    for (const m of t.member) {
        const { size, align: natural, type } = lower(m.type)
        let align = natural
        if (pack > 0) align = Math.min(pack, align)
        if (m.alignas) align = Math.max(align, m.alignas)

        if (type.tag === 'bitfield') {
            if (m.name === undefined)
                throw new Error('ffi-struct: bitfield members must be named')
            const width = type.width

            // 新单元：无活动单元 / 单元宽不同 / 放不下。
            if (unitBase < 0 || size !== unitSize || unitBits + width > unitSize * 8) {
                // 单元宽变化或溢出时先把旧单元落定，新单元从落定点对齐。
                if (unitBase >= 0) flushUnit()
                const offset = alignUp(cursor, align)
                unitBase = offset
                unitBits = 0
                unitSize = size
            }

            fields.push({
                name: m.name,
                offset: unitBase,   // 单元基址（不是位域自己的地址）
                size,
                type: { ...type, bit: unitBits },
            })
            unitBits += width

            maxEffectiveAlign = Math.max(maxEffectiveAlign, align)
            maxMemberSize = Math.max(maxMemberSize, size)
            continue
        }

        flushUnit()
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

    flushUnit()

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

// ============================================================
// 位域读写
// ============================================================
// 存储单元统一按无符号读（避免单元高位的符号位干扰提取），再用掩码取出位域。
// 有符号单元在提取后做符号扩展。写是读-改-写：只改本位域占的位，其余位保留。
// 64 位单元走 BigInt，超出 2^53 的位域值有精度损失（与 u64/i64 一致）。
type BitfieldType = Extract<FieldType, { tag: 'bitfield' }>

function readUnitRaw(dv: DataView, off: number, unit: C_Integer): bigint {
    const s = SizeAlign[unit]
    if (s === 1) return BigInt(dv.getUint8(off))
    if (s === 2) return BigInt(dv.getUint16(off, true))
    if (s === 4) return BigInt(dv.getUint32(off, true))
    return dv.getBigUint64(off, true)
}

function writeUnitRaw(dv: DataView, off: number, unit: C_Integer, v: bigint): void {
    const s = SizeAlign[unit]
    if (s === 1) { dv.setUint8(off, Number(v & 0xffn)); return }
    if (s === 2) { dv.setUint16(off, Number(v & 0xffffn), true); return }
    if (s === 4) { dv.setUint32(off, Number(v & 0xffffffffn), true); return }
    dv.setBigUint64(off, v & 0xffffffffffffffffn, true)
}

function readBitfield(dv: DataView, off: number, t: BitfieldType): number {
    const w = BigInt(t.width)
    const v = (readUnitRaw(dv, off, t.unit) >> BigInt(t.bit)) & ((1n << w) - 1n)
    if (t.unit[0] === 'i') {   // 有符号单元 → 符号扩展
        const sign = 1n << (w - 1n)
        if (v & sign) return Number(v - (1n << w))
    }
    return Number(v)
}

function writeBitfield(dv: DataView, off: number, t: BitfieldType, val: number): void {
    const w = BigInt(t.width)
    const bit = BigInt(t.bit)
    const widthMask = (1n << w) - 1n
    const posMask = widthMask << bit
    const raw = readUnitRaw(dv, off, t.unit)
    const bits = BigInt(Math.trunc(val)) & widthMask
    writeUnitRaw(dv, off, t.unit, (raw & ~posMask) | (bits << bit))
}

// 字符串读写统一走 TextEncoder/TextDecoder（polyfill 见 lib/text-codec.js）。
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
        case 'bitfield': return readBitfield(dv, off, t)
        case 'string': return readString(dv, off, size, t.encoding)
        case 'struct':
        case 'union': return doDecode(dv, off, t.fields)
        case 'array': return readArray(dv, off, size, t)
    }
}

function writeElement(dv: DataView, off: number, t: FieldType, size: number, val: unknown): void {
    switch (t.tag) {
        case 'basic': writeScalar(dv, off, t.kind, Number(val ?? 0)); break
        case 'bitfield': writeBitfield(dv, off, t, Number(val ?? 0)); break
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
