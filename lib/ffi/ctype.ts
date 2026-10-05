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
// §1 kind 词汇表 —— KINDS 是唯一手写清单，下列集合全从它派生
//   Kind(14)        bind 签名 token / lower 后 IR 共用
//   C_Number(10)    结构体字段的数字档
//   C_Integer(8)    C_Number 去浮点 —— 位域存储单元只能是整数档
//   Token(13+指针)  C_ALIAS / Norm / JsTypeOfToken 的操作面（见 §3）
// 排除项：'void' 无大小；u64n/i64n 是「恰 64 位」传输档，非 C 类型（u64/i64 才是）；
// 裸 'ptr' 用户面禁写（须写 '<>ptr'），内部保留 —— 唯一随架构变宽的标量档。
// lower 后所有指针归一为 kind 'ptr'，名字被擦掉。
// ============================================================
const KINDS = [
    'void', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32',
    'u64', 'i64', 'u64n', 'i64n', 'f32', 'f64', 'ptr',
] as const
export type Kind = (typeof KINDS)[number]

// C 的数字类型档：可作结构体字段 / bind 签名 token。排除项理由见 §1。
export type C_Number = Exclude<Kind, 'void' | 'u64n' | 'i64n' | 'ptr'>

// 整数档：位域存储单元的合法类型（C 位域只能用整型）。
export type C_Integer = Exclude<C_Number, 'f32' | 'f64'>

const KIND_SET: ReadonlySet<Kind> = new Set(KINDS)

// ============================================================
// §2 指针布局与品牌
// ============================================================
// 指针宽：与 bind 的调用约定 / quickjs-ffi-type.h 一致。
export const PTR_SIZE = os.arch === 'x64' ? 8 : 4

// 指针的编译期品牌（运行期擦除，值就是 number）：'<>ptr'（T=''）直接退化成 number，
// 带名 '<NAME>ptr' 提供名义约束 —— 不同 <NAME>ptr 不可互串，裸 number 不可传给 <NAME>ptr。
declare const ptrBrand: unique symbol
export type Ptr<T extends string> =
    T extends '' ? number : number & { readonly [ptrBrand]: T }

type NullablePtr<T extends string> = (T extends '' ? number : number & { readonly [ptrBrand]: T }) | null

// 指针 token 判定：NAME 可空（'<>ptr' 裸地址），但不许空白或尖括号嵌套。
const PTR_TOKEN_RE = /^<([^<>\s]*)>ptr$/

export function isCPtrToken(t: string): t is `<${string}>ptr` { return PTR_TOKEN_RE.test(t) }

// 整数档运行时判定：位域单元只能是整型。排除项与 C_Integer 的类型层 Exclude 一一对应。
export function isCInteger(t: string): t is C_Integer {
    return KIND_SET.has(t as Kind)
        && t !== 'f32' && t !== 'f64' && t !== 'void' && t !== 'u64n' && t !== 'i64n' && t !== 'ptr'
}

// ============================================================
// §3 C 别名与 token 归一 —— Windows LLP64：int/long 恒 32 位、long long 恒 64 位；
//   指针 typedef（LONG_PTR/WPARAM/SIZE_T…）归一 '<>ptr'，宽字符串 typedef 归一 '<WCHAR>ptr'。
//   单源常量 as const satisfies：类型层 Norm 由它派生，无需手同步；satisfies 让 value
//   也在定义处被校验 —— 仅 as const 会静默放过 'u3z'，错误推迟成调用点诡异的 never。
// ============================================================

// 规范 token 全集 = 规范 kind（去裸 'ptr'）∪ 指针 token。C_ALIAS 的值、Norm 的输入输出、
// JsTypeOfToken 的键都在此集合上。不含裸 'ptr' —— 用户必须写 '<>ptr'（见 §1）。
type Token = Exclude<Kind, 'ptr'> | `<${string}>ptr`

const C_ALIAS = {
    void: 'void', u8: 'u8', i8: 'i8', u16: 'u16', i16: 'i16', u32: 'u32', i32: 'i32',
    u64: 'u64', i64: 'i64', f32: 'f32', f64: 'f64', i64n: 'i64n', u64n: 'u64n',
    int: 'i32', long: 'i32', short: 'i16', char: 'i8', float: 'f32', double: 'f64',
    DWORD: 'u32', UINT: 'u32', ULONG: 'u32', LONG: 'i32', BOOL: 'i32', HRESULT: 'i32',
    SHORT: 'i16', USHORT: 'u16', BYTE: 'u8', WCHAR: 'u16',
    LONG_PTR: '<>ptr', ULONG_PTR: '<>ptr', INT_PTR: '<>ptr', UINT_PTR: '<>ptr', DWORD_PTR: '<>ptr',
    SIZE_T: '<>ptr', WPARAM: '<>ptr', LPARAM: '<>ptr',
    HANDLE: '<>ptr', HWND: '<>ptr', HDC: '<>ptr', HMODULE: '<>ptr', HFONT: '<>ptr', HBRUSH: '<>ptr',
    HICON: '<>ptr', HBITMAP: '<>ptr', LPVOID: '<>ptr', LPCVOID: '<>ptr',
    LPCWSTR: '<WCHAR>ptr', PCWSTR: '<WCHAR>ptr', LPWSTR: '<WCHAR>ptr',
} as const satisfies Record<string, Token>

export type C_ALIAS_MAP = typeof C_ALIAS

export type TokenJsTypeMap = {
    u8: number; i8: number; u16: number; i16: number
    u32: number; i32: number; u64: number; i64: number
    u64n: bigint; i64n: bigint; f32: number; f64: number
}

export type TokenReturnJsTypeMap = TokenJsTypeMap & { void: void }

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
export function normToken(t: string): string {
    return (C_ALIAS as Record<string, string>)[t] ?? t
}

// 别名归一 + kind 校验：非法 kind 抛错，合法者收窄为 Kind。
export function normKind(t: string): Kind {
    const k = normToken(t) as Kind
    if (!KIND_SET.has(k)) throw new Error(`ffi-bind: invalid kind "${t}"`)
    return k
}

// token（C 别名归一后）是否为 <NAME>ptr 指针布局；是则返回 NAME，否则 undefined。
export function ptrLayoutName(t: string): string | undefined {
    const m = PTR_TOKEN_RE.exec(normToken(t))
    return m?.[1] || undefined   // '<>ptr' 空名 → undefined，调用方按裸指针另行处理
}

// ============================================================
// §4 CType IR —— 复合类型（带 tag 的对象）；标量/指针直接写 kind 字符串。
// ============================================================
// encoding 只决定「这段字节怎么看成 JS string」，不参与布局：unit+length 决定 layout，
// encoding 仅在 encode/decode 用，可与任意 unit 组合。标签直接用 TextDecoder/TextEncoder
// 标准，读写走 lib/text-codec.js。定长字段：写入超长截断到 size，读取到 NUL 为止。
export type Encoding = 'utf-8' | 'utf-16le'

export type CString = {
    tag: 'string',
    unit: 'u8' | 'u16',   // 槽宽与对齐
    length: number,   // 槽数
    encoding: Encoding
}
export type CArray = {
    tag: 'array',
    ctype: CType,
    length: number
}
// 位域：unit 决定存储单元的宽、对齐与签别（必须整数档），width 是位宽。
// 布局规则（mingw 实测 MSVC 语义）在 struct.ts 的位域状态机里，此处不重复。
export type CBitfield = {
    tag: 'bitfield',
    unit: C_Integer,
    width: number
}
// 成员分两支，用 name 判别：命名成员（标量/string/array/bitfield，无可提升子布局、必须命名）
// 与匿名聚合（struct/union，C11 匿名字段其子字段被 splice 提升进父结构）。alignas 抬对齐下限。
// CBitfield 刻意不进 CType —— 数组元素只能是 CType（C 禁止位域数组），
// Member 用 CMemberType = CType | CBitfield 显式把它加回来。
export type CMemberType = CType | CBitfield

export type Member =
    | { name: string; type: CMemberType; alignas?: number }
    | { name?: undefined; type: CStruct | CUnion; alignas?: number }

export type CStruct = { tag: 'struct'; member: readonly Member[], pack?: number }
export type CUnion = { tag: 'union'; member: readonly Member[], pack?: number }

export type CType = C_Number | `<${string}>ptr` | CString | CArray | CStruct | CUnion

/** 构造位域成员类型：unit 决定单元宽与签别（整数档），width 是位宽（1..单元位宽）。 */
export function bit(unit: C_Integer, width: number): CBitfield {
    return { tag: 'bitfield', unit, width }
}
