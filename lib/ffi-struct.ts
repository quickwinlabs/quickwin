import * as os from 'os'
import { normKind, type Norm } from './ffi-bind.js'

// 声明式结构体定义：struct({ field: 'i32', p: 'ptr', ws: 'wstr[32]', child: SubStruct })
// layout 采用 MSVC 对齐语义：
//   i8/u8→1   i16/u16→2   i32/u32/f32→4   i64/u64/f64→8   ptr→arch 宽(4/8)
//   struct 对齐 = 最大字段对齐，总尺寸末尾补齐
// 字段类型：
//   标量 kind（含 ffi-bind 的 C typedef 别名：int/DWORD/LPARAM/HANDLE...）
//   定长数组 'u16[8]' / 'i32[4]' / 'wstr[32]'（wstr 读 string、写 string，自动截断+补 0）
//   嵌套 struct：字段值直接传子 struct 定义对象

type FieldKind = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'u64' | 'i64' | 'f32' | 'f64' | 'ptr' | 'wstr'

const PTR = os.arch === 'x64' ? 8 : 4

// kind → [align, size]
const AS: Record<FieldKind, [number, number]> = {
    u8: [1, 1], i8: [1, 1],
    u16: [2, 2], i16: [2, 2],
    u32: [4, 4], i32: [4, 4],
    u64: [8, 8], i64: [8, 8],
    f32: [4, 4], f64: [8, 8],
    ptr: [PTR, PTR],
    wstr: [2, 2], // 仅定长数组元素用（wchar）
}

type KnownScalar = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'u64' | 'i64' | 'f32' | 'f64' | 'ptr'

type ValOf<S extends string> = S extends `${infer B}[${number}]`
    ? (B extends 'wstr' ? string : Norm<B> extends KnownScalar ? number[] : never)
    : S extends KnownScalar ? number
    : Norm<S> extends KnownScalar ? number : never

export type StructShape<T extends Record<string, unknown> = Record<string, unknown>> = {
    readonly __fields: T
    readonly size: number
    readonly structAlign: number
}

type ShapeOf<T extends Record<string, unknown>> = {
    [K in keyof T]: T[K] extends string ? ValOf<T[K]> : T[K] extends StructShape ? ShapeOf<T[K]['__fields']> : never
}

export type StructDef<F extends Record<string, string | StructShape>> = StructShape<F> & {
    read(buf: ArrayBuffer, offset?: number): ShapeOf<F>
    write(v: ShapeOf<F>, buf?: ArrayBuffer, offset?: number): ArrayBuffer
    offsetOf(name: keyof F): number
}

type Field = {
    name: string
    base: FieldKind
    count: number
    offset: number
    child?: StructShape
}

function alignUp(v: number, a: number): number {
    return (v + a - 1) & ~(a - 1)
}

function parseField(f: string): { base: FieldKind; count: number } {
    const arr = /^(.+)\[(\d+)\]$/.exec(f)
    if (arr) {
        const b = normKind(arr[1]!)
        if (b === 'void') throw new Error(`ffi-struct: "void" cannot be an array base`)
        return { base: b as FieldKind, count: Number(arr[2]) }
    }
    const b = normKind(f)
    if (b === 'void' || b === 'wstr') throw new Error(`ffi-struct: invalid scalar field type "${f}"`)
    return { base: b as FieldKind, count: 1 }
}

function layout<F extends Record<string, string | StructShape>>(def: F): { fields: Field[]; size: number; structAlign: number } {
    const fields: Field[] = []
    let cursor = 0
    let maxAlign = 1
    for (const key of Object.keys(def) as (keyof F)[]) {
        const v = def[key]
        let a: number
        let w: number
        if (typeof v === 'string') {
            const { base, count } = parseField(v)
            const [align, elem] = AS[base]
            a = align
            w = count >= 1 ? elem * count : elem
            fields.push({ name: key as string, base, count, offset: 0 })
        } else {
            const child = v as StructShape
            a = child.structAlign
            w = child.size
            fields.push({ name: key as string, base: 'u8', count: 0, offset: 0, child })
        }
        const off = alignUp(cursor, a)
        const f = fields[fields.length - 1]!
        f.offset = off
        cursor = off + w
        if (a > maxAlign) maxAlign = a
    }
    return { fields, size: alignUp(cursor, maxAlign), structAlign: maxAlign }
}

const _layoutCache = new WeakMap<object, { fields: Field[]; size: number; structAlign: number }>()

function buildLayout<F extends Record<string, string | StructShape>>(def: F): { fields: Field[]; size: number; structAlign: number } {
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
        case 'wstr': return dv.getUint16(off, true)
    }
}

function readPtr(dv: DataView, off: number): number {
    if (PTR === 8) return Number(dv.getBigUint64(off, true))
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
        case 'wstr': dv.setUint16(off, val, true); break
    }
}

function writePtr(dv: DataView, off: number, val: number): void {
    if (PTR === 8) dv.setBigUint64(off, BigInt(Math.trunc(val)), true)
    else dv.setUint32(off, val >>> 0, true)
}

function readField(dv: DataView, base: number, f: Field): unknown {
    const off = base + f.offset
    if (f.child) return readInto(f.child, dv.buffer as ArrayBuffer, off)
    if (f.count > 1) {
        if (f.base === 'wstr') {
            const arr = new Uint16Array(dv.buffer, dv.byteOffset + off, f.count)
            let end = 0
            while (end < arr.length && arr[end] !== 0) end++
            let s = ''
            for (let i = 0; i < end; i++) s += String.fromCharCode(arr[i]!)
            return s
        }
        const out: number[] = []
        const step = AS[f.base]![1]
        for (let i = 0; i < f.count; i++) out.push(readScalar(dv, off + i * step, f.base))
        return out
    }
    return readScalar(dv, off, f.base)
}

function writeField(dv: DataView, base: number, f: Field, v: unknown): void {
    const off = base + f.offset
    if (f.child) { writeInto(f.child, v as Record<string, unknown>, dv.buffer as ArrayBuffer, off); return }
    if (f.count > 1) {
        if (f.base === 'wstr') {
            const s = String(v ?? '')
            const arr = new Uint16Array(dv.buffer, dv.byteOffset + off, f.count)
            for (let i = 0; i < arr.length; i++) arr[i] = 0
            const n = Math.min(s.length, f.count - 1)
            for (let i = 0; i < n; i++) arr[i] = s.charCodeAt(i)
            return
        }
        const step = AS[f.base]![1]
        const list = (v ?? []) as number[]
        for (let i = 0; i < f.count; i++) writeScalar(dv, off + i * step, f.base, list[i] ?? 0)
        return
    }
    writeScalar(dv, off, f.base, Number(v))
}

function doSize<F extends Record<string, string | StructShape>>(def: F): number {
    return buildLayout(def).size
}

function readInto<S>(child: StructShape, buf: ArrayBuffer, offset: number): S {
    const r = child as unknown as { read(b: ArrayBuffer, o: number): S }
    return r.read(buf, offset)
}

function doRead<F extends Record<string, string | StructShape>>(_def: F, fields: Field[], buf: ArrayBuffer, offset: number): ShapeOf<F> {
    const out: Record<string, unknown> = {}
    const dv = new DataView(buf)
    for (const f of fields) out[f.name] = readField(dv, offset, f)
    return out as ShapeOf<F>
}

function doWrite<F extends Record<string, string | StructShape>>(def: F, fields: Field[], v: ShapeOf<F>, buf?: ArrayBuffer, offset = 0): ArrayBuffer {
    buf = buf ?? new ArrayBuffer(doSize(def))
    const dv = new DataView(buf)
    for (const f of fields) writeField(dv, offset, f, (v as Record<string, unknown>)[f.name])
    return buf
}

function writeInto<W>(child: StructShape, v: Record<string, unknown>, buf: ArrayBuffer, offset: number): void {
    const w = child as unknown as { write(i: W, b: ArrayBuffer, o: number): unknown }
    w.write(v as W, buf, offset)
}

export function struct<const F extends Record<string, string | StructShape>>(def: F): StructDef<F> {
    const { fields, size, structAlign } = buildLayout(def)
    return {
        __fields: def,
        size,
        structAlign,
        read: (buf: ArrayBuffer, offset = 0) => doRead(def, fields, buf, offset),
        write: (v, buf?: ArrayBuffer, offset = 0) => doWrite(def, fields, v, buf, offset),
        offsetOf: (name: keyof F) => {
            for (const f of fields) if (f.name === name) return f.offset
            throw new Error(`ffi-struct: no field "${String(name)}"`)
        },
    }
}