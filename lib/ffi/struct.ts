import * as ffi from 'ffi';
import '../text-codec.js';
import {
    C_BasicType_No_Void,
    C_TypeJsTypeMap,
    isCPtrToken,
    NullablePtr,
    PTR_SIZE,
    readScalar,
    SizeAlign,
    writeScalar,
    type C_Array, type C_Bitfield,
    type C_Integer,
    type C_MemberType,
    type C_Number,
    type C_String,
    type C_Struct, type C_Union,
    type Encoding,
    type Member,
    type Ptr
} from './ctype.js';

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

type N =
    | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
    | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19
    | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29
    | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 | 39
    | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49
    | 50 | 51 | 52 | 53;

type ValOf<C extends C_MemberType> =
    C extends `<${infer T}>ptr` ? NullablePtr<T>
    : C extends C_Number ? C_TypeJsTypeMap[C]
    : C extends C_Bitfield ? (C extends { width: N } ? number : bigint)
    : C extends C_String ? string
    : C extends C_Array ? Tuple<ValOf<C['ctype']>, C['length']>
    : C extends C_Struct | C_Union ? ShapeOfC<C['member']>
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
    M extends { name?: undefined; type: infer T extends C_Struct | C_Union }
    ? ShapeOfC<T['member']>
    : M extends { name: infer N extends string; type: infer T extends C_MemberType }
    ? { [K in N]: ValOf<T> }
    : {}

// ============================================================
// 运行时类型
// ============================================================

// lower 后指针统一归一为内部 kind 'ptr'（用户面写 '<>ptr' 或 '<NAME>ptr'）。

// kind → size/align（不含指针：指针统一 PTR_SIZE，见 lower）。


// 运行时 Field：IR 的 lowered 视图（独立于 CType，不保留 Member/alignas）。
// computeStructLayout 在 lowering 时把子布局内嵌进 FieldType（struct/union→fields，
// array→elementType+elementSize，bitfield→bit 单元内偏移），运行期 read/write 零查表。
// offset 相对本层起点；位域成员的 offset 是其存储单元的基址（不是位域自己的地址）。
type FieldType =
    { tag: 'basic', kind: C_BasicType_No_Void }
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

export type StructDef<T extends C_Struct | C_Union, N extends string = never> = {
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

// CType → { size, align, FieldType }：聚合递归进 computeStructLayout；array 元素复用同一结果。
function lower(t: C_MemberType): { size: number, align: number, type: FieldType } {
    if (typeof t === 'string') {
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

export function computeArray(t: C_Array): { align: number, size: number } {
    const { size, align } = lower(t)
    return { align, size }
}

export function computeStructLayout(t: C_Struct | C_Union): Layout {
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
// 位域读写
// ============================================================
// 存储单元统一按无符号读（避免单元高位的符号位干扰提取），再用掩码取出位域。
// 有符号单元在提取后做符号扩展。写是读-改-写：只改本位域占的位，其余位保留。
// 64 位单元往返走 BigInt；读回时 width>53 返回 bigint、否则 number（见 readBitfield）。
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

function readBitfield(dv: DataView, off: number, t: BitfieldType): number | bigint {
    // TODO： width > 53 时返回 bigint
    const w = BigInt(t.width)
    const v = (readUnitRaw(dv, off, t.unit) >> BigInt(t.bit)) & ((1n << w) - 1n)
    if (t.unit[0] === 'i') {   // 有符号单元 → 符号扩展
        const sign = 1n << (w - 1n)
        if (v & sign) return Number(v - (1n << w))
    }
    if (t.width > 53) return v
    return Number(v)
}

function writeBitfield(dv: DataView, off: number, t: BitfieldType, val: number | bigint): void {
    // TODO: width > 53 时可写入 bigint | number
    const w = BigInt(t.width)
    const bit = BigInt(t.bit)
    const widthMask = (1n << w) - 1n
    const posMask = widthMask << bit
    const raw = readUnitRaw(dv, off, t.unit)
    const bits = (typeof val === 'bigint' ? val : BigInt(Math.trunc(val))) & widthMask
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
        // TODO: remove this any
        case 'basic': writeScalar(dv, off, { k: t.kind, v: val as any }); break
        // 直传（不 Number()）：writeBitfield 的 val 是 number | bigint，
        // 64 位单元走 bigint，先 Number() 会把 >2^53 的位域值截断。
        case 'bitfield': writeBitfield(dv, off, t, (val ?? 0) as number | bigint); break
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

function createStruct(t: C_Struct | C_Union): any {
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
