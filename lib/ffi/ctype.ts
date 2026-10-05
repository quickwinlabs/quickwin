import * as os from 'os'

// ============================================================
// AST IR —— struct/bind 的类型描述树。标量直接写 kind 字符串（如 'i32'）；
// 指针写 '<>ptr'（裸地址）或 '<NAME>ptr'（带名），复合类型才是带 tag 的对象。
// 只描述「C 声明怎么写」（unit/length/encoding 等意图）；内存布局与读写视图由
// struct.ts 的 computeStructLayout/lower 单独 lower 成 layout IR。
//
// 叶子模块：刻意不依赖 win/std/text-codec，可被 struct 直接引用，
// 避免「只用 struct」的调用方被动加载整个 bind 运行时。
// 四段按依赖序：§1 kind 词汇表 → §2 指针布局与品牌 → §3 C 别名与 token 归一 → §4 CType IR。
// ============================================================

// ============================================================
// §1 kind 词汇表 —— C_BASIC_TYPE 是唯一手写清单，下列集合全从它派生
//   C_BasicType(12)  bind 签名 token / lower 后 IR 共用
//   C_Number(10)    结构体字段的数字档
//   C_Integer(8)    C_Number 去浮点 —— 位域存储单元只能是整数档
//   Token(11+指针)  C_ALIAS / Norm / JsTypeOfToken 的操作面（见 §3）
// 排除项：'void' 无大小；裸 'ptr' 用户面禁写（须写 '<>ptr'），内部保留 ——
// 唯一随架构变宽的标量档。lower 后所有指针归一为 kind 'ptr'，名字被擦掉。
// ============================================================
const C_BASIC_TYPE = [
    'void', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32',
    'u64', 'i64', 'f32', 'f64', 'ptr',
] as const

export type C_BasicType = (typeof C_BASIC_TYPE)[number]
export type C_BasicType_No_Void = Exclude<C_BasicType, 'void'>

export type C_BasicType_Token = Exclude<C_BasicType, 'ptr'> | `<${string}>ptr`
export type C_BasicType_Token_No_Void = Exclude<C_BasicType_Token, 'void'>

const PTR_TOKEN_RE = /^<([^<>\s]*)>ptr$/

export function isCPtrToken(t: string): t is `<${string}>ptr` { return PTR_TOKEN_RE.test(t) }
export function ptrName<const N extends string>(t: `<${N}>ptr`): N {
    const m = PTR_TOKEN_RE.exec(t)
    return (m?.[1] || "") as N
}
/**
 * @description `<${string}>ptr` -> 'ptr'
 */
export const cTokenToType = <const T extends string>(t: T): Exclude<T, `<${string}>ptr`> | 'ptr' => {
    if (isCPtrToken(t)) return 'ptr'
    else return t as Exclude<T, `<${string}>ptr`>
}

// C 的数字类型档：可作结构体字段 / bind 签名 token。排除项理由见 §1。
export type C_Number = Exclude<C_BasicType, 'void' | 'ptr'>

// 整数档：位域存储单元的合法类型（C 位域只能用整型）。
export type C_Integer = Exclude<C_Number, 'f32' | 'f64'>

export type Encoding = 'utf-8' | 'utf-16le'

export type C_String = {
    tag: 'string',
    unit: 'u8' | 'u16',   // 槽宽与对齐
    length: number,   // 槽数
    encoding: Encoding
}
export type C_Array = {
    tag: 'array',
    ctype: C_Type,
    length: number
}
export type C_Bitfield = {
    tag: 'bitfield',
    unit: C_Integer,
    width: number
}

export type C_MemberType = C_Type | C_Bitfield

export type Member =
    | { name: string; type: C_MemberType; alignas?: number }
    | { name?: undefined; type: C_Struct | C_Union; alignas?: number }

export type C_Struct = { tag: 'struct'; member: readonly Member[], pack?: number }
export type C_Union = { tag: 'union'; member: readonly Member[], pack?: number }

export type C_Type = C_Number | `<${string}>ptr` | C_String | C_Array | C_Struct | C_Union


export const PTR_SIZE = os.arch === 'x64' ? 8 : 4

export const SizeAlign: Record<C_Number, number> = {
    u8: 1, i8: 1,
    u16: 2, i16: 2,
    u32: 4, i32: 4,
    u64: 8, i64: 8,
    f32: 4, f64: 8,
}

declare const ptrBrand: unique symbol
export type Ptr<T extends string> =
    T extends '' ? number : number & { readonly [ptrBrand]: T }

export type NullablePtr<T extends string> = Ptr<T> | null

const C_ALIAS = {
    void: 'void', u8: 'u8', i8: 'i8', u16: 'u16', i16: 'i16', u32: 'u32', i32: 'i32',
    u64: 'u64', i64: 'i64', f32: 'f32', f64: 'f64',
    int: 'i32', long: 'i32', short: 'i16', char: 'i8', float: 'f32', double: 'f64',
    DWORD: 'u32', UINT: 'u32', ULONG: 'u32', LONG: 'i32', BOOL: 'i32', HRESULT: 'i32',
    SHORT: 'i16', USHORT: 'u16', BYTE: 'u8', WCHAR: 'u16',
    LONG_PTR: '<>ptr', ULONG_PTR: '<>ptr', INT_PTR: '<>ptr', UINT_PTR: '<>ptr', DWORD_PTR: '<>ptr',
    SIZE_T: '<>ptr', WPARAM: '<>ptr', LPARAM: '<>ptr',
    HANDLE: '<>ptr', HWND: '<>ptr', HDC: '<>ptr', HMODULE: '<>ptr', HFONT: '<>ptr', HBRUSH: '<>ptr',
    HICON: '<>ptr', HBITMAP: '<>ptr', LPVOID: '<>ptr', LPCVOID: '<>ptr',
    LPCWSTR: '<WCHAR>ptr', PCWSTR: '<WCHAR>ptr', LPWSTR: '<WCHAR>ptr',
} as const satisfies Record<string, C_BasicType_Token>

export type C_ALIAS_MAP = typeof C_ALIAS

export type C_TypeJsTypeMap = {
    u8: number; i8: number; u16: number; i16: number
    u32: number; i32: number; i64: bigint, u64: bigint
    f32: number; f64: number, ptr: number
}

export type TokenArgJsTypeMap = C_TypeJsTypeMap
export type TokenReturnJsTypeMap = C_TypeJsTypeMap & { void: void }

// token 的类型层归一（运行时对应 normToken）。约束刻意保持 string 而非 Token：
// 非法 token（如 'i3z'）要塌成 never 而不是报 TS2344 —— `& keyof` 把交集约成 never，
// 索引出 never 让调用点拿到 never。收紧到 Token 会把「拼错 token」从 never 变成硬错误。
type Norm<K extends string> = K extends `<${string}>ptr` ? K : C_ALIAS_MAP[K & keyof C_ALIAS_MAP]

// token → JS 类型。M = kind→JS 映射（实参表 / 返回表）；L = 布局名→JS 形；
// D = 落不到任何映射时的默认（实参传 never，使 'void' 等非法档报 never）。
export type JsTypeOfToken<K extends string, M, L, D> =
    Norm<K> extends infer S ?
    S extends `<${infer N}>ptr` ? NullablePtr<N> | L[N & keyof L] :
    M[S & keyof M] extends never ? D
    : M[S & keyof M]
    : never

// token 归一：C/Windows typedef 别名 → 规范形式（'HANDLE' → '<>ptr' 等）；非别名原样返回。

export function normToken(t: string): C_BasicType_Token {
    if (isCPtrToken(t)) return t
    const isKey = (k: string): k is keyof C_ALIAS_MAP => k in C_ALIAS;
    if (isKey(t)) {
        return C_ALIAS[t]
    }
    throw new Error("Unknown token: " + t)
}

/** 构造位域成员类型：unit 决定单元宽与签别（整数档），width 是位宽（1..单元位宽）。 */
export function bit<const W extends number>(unit: C_Integer, width: W) {
    return { tag: 'bitfield', unit, width } as const
}

export function readScalar(dv: DataView, off: number, k: C_BasicType_No_Void): number | bigint | null {
    switch (k) {
        case 'u8': return dv.getUint8(off)
        case 'i8': return dv.getInt8(off)
        case 'u16': return dv.getUint16(off, true)
        case 'i16': return dv.getInt16(off, true)
        case 'u32': return dv.getUint32(off, true)
        case 'i32': return dv.getInt32(off, true)
        case 'u64': return dv.getBigUint64(off, true)
        case 'i64': return dv.getBigInt64(off, true)
        case 'f32': return dv.getFloat32(off, true)
        case 'f64': return dv.getFloat64(off, true)
        case 'ptr': {
            const p = PTR_SIZE === 8 ? Number(dv.getBigUint64(off, true)) : dv.getUint32(off, true)
            // 0 归一为 null：类型层（ValOf / JsTypeOfToken）把指针一律声明为
            // NullablePtr，若此处返回裸 0，`p === null` 就永不成立 —— 类型允许、
            // 运行时永远走不到的分支比类型错误更隐蔽。
            return p === 0 ? null : p
        }
    }
}

type Entry =
    { [K in C_BasicType_No_Void]: { k: K; v: C_TypeJsTypeMap[K] } }[C_BasicType_No_Void];

/** 内存写：按 sizeof 精确写，供 struct 字段编码用。小整数只占自己的字节，
 *  否则 `{a:u8,b:u8}` 这类紧凑布局会被 setUint32 越界覆盖相邻字段。 */
export function writeScalar(dv: DataView, off: number, { k, v }: Entry): void {
    switch (k) {
        case 'u8': dv.setUint8(off, Number(v)); break
        case 'i8': dv.setInt8(off, Number(v)); break
        case 'u16': dv.setUint16(off, Number(v), true); break
        case 'i16': dv.setInt16(off, Number(v), true); break
        case 'u32': dv.setUint32(off, (v) >>> 0, true); break
        case 'i32': dv.setUint32(off, (v) >>> 0, true); break
        case 'u64': dv.setBigUint64(off, v, true); break
        case 'i64': dv.setBigInt64(off, v, true); break
        case 'f32': dv.setFloat32(off, (v), true); break
        case 'f64': dv.setFloat64(off, (v), true); break
        case 'ptr': {
            if (PTR_SIZE === 8) dv.setBigUint64(off, BigInt(v), true)
            else dv.setUint32(off, v >>> 0, true)
            break
        }
    }
}

/** 槽写：供 bind 的参数槽/返回槽用。小整数扩展到 4 字节 —— 可变参数按 int 提升读，
 *  `i8 = -1` 必须给 `0xFFFFFFFF` 而非 `0x000000FF`。u32/i32/u64/i64/f32/f64/ptr
 *  槽宽 == sizeof，直接委托 writeScalar。 */
export function writeSlot(dv: DataView, off: number, e: Entry): void {
    const { k, v } = e
    if (k === 'u8' || k === 'i8' || k === 'u16' || k === 'i16') {
        dv.setUint32(off, Number(v) >>> 0, true)
        return
    }
    writeScalar(dv, off, e)
}