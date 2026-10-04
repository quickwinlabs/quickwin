import * as os from 'os'

// ============================================================
// AST IR —— struct/bind 的类型描述树（CType = FieldKind|CString|CArray|CStruct|CUnion）。
// 标量直接写 kind 字符串（如 'i32'）；指针必须写 '<>ptr'（裸地址）或 '<NAME>ptr'（带名），
// 复合类型才是带 tag 的对象。
// 只描述「C 声明怎么写」（unit/length/encoding 等意图）；内存布局与读写视图由
// struct.ts 的 computeStructLayout/lower 单独 lower 成 layout IR。
// ============================================================

// 标量 kind 词汇表（bind 与 struct 共用）：规范 kind 集合、C/Windows typedef 别名表、
// token 归一化与校验。刻意不依赖 win/std/text-codec，可作叶子模块被 struct 直接引用，
// 避免「只用 struct」的调用方被动加载整个 bind 运行时。

// kind：
//   BasicKind = void u8 i8 u16 i16 u32 i32 u64 i64 u64n i64n f32 f64 ptr（内部 kind，含裸 ptr）
//   用户写法一律 '<NAME>ptr'：'<>ptr' = 裸地址（内部归一为 kind 'ptr'），
//   '<NAME>ptr' = 带名指针（compile-time 品牌见 Ptr<T>）。
// 可用 C/Windows typedef 别名：int long short char float double
//   + DWORD UINT LONG BOOL HRESULT ... + *_PTR WPARAM LPARAM SIZE_T
//   + HANDLE HWND HDC ... (+ LPVOID 等指针 typedef，指针 typedef 均归一为 '<>ptr')
type BasicKind = 'void' | 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'u64' | 'i64' | 'u64n' | 'i64n' | 'f32' | 'f64' | 'ptr'
export type Kind = BasicKind

export type CInteger = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'u64' | 'i64'
export type CFloat = 'f32' | 'f64'
export type CPointer<T extends string = ''> = `<${T}>ptr`

// 注意用 CPointer<string>（非默认 ''）：默认参数会把它收缩成字面量 '<>ptr'，
// 导致 '<RECT>ptr' 等具体指针无法赋给 CType。
export type FieldKind = CInteger | CFloat | CPointer<string>

// 字符串解释方式（与 printf 的 %d/%u 类比：encoding 只决定「把这段字节怎么看成 JS string」）。
// 直接复用 TextDecoder/TextEncoder 的标准标签，读写统一走 lib/text-codec.js：
//   utf-8    变长编解码
//   utf-16le 每 2 字节 1 码元（宽字符）
// 定长字段：写入超长即截断到 size，读取到 NUL 为止。
// unit+length 共同决定 layout；encoding 只在 decode/encode 时使用，可与任意 unit 组合。
export type Encoding = 'utf-8' | 'utf-16le'

export type CType = FieldKind | CString | CArray | CStruct | CUnion
export type CString = {
    tag: 'string',
    unit: 'u8' | 'u16',   // 存储单元类型（决定槽宽与对齐）
    length: number,   // 槽数
    encoding: Encoding
}
export type CArray = {
    tag: 'array',
    ctype: CType,
    length: number
}
// 成员分两支，用 name 判别：
//   命名成员：标量 kind / string / array（没有可提升的子布局，必须命名）
//   匿名聚合：struct / union（C11 匿名字段，其字段被 splice 提升进父结构）
// alignas 抬对齐下限（pack 压上限）；bitfield 暂不支持。
export type Member =
    | { name: string;     type: CType;            alignas?: number }
    | { name?: undefined; type: CStruct | CUnion; alignas?: number }

export type CStruct = { tag: 'struct'; member: readonly Member[], pack?: number }
export type CUnion = { tag: 'union'; member: readonly Member[], pack?: number }

// C / Windows typedef → 规范 token。Windows x86/x64 均 LLP64：int/long 恒 32 位，
// long long 恒 64 位；LONG_PTR/WPARAM/SIZE_T 等指针 typedef 一律归一到 '<>ptr'（裸地址）。
// 单源常量（as const）：类型层 CTypeOf = typeof C_ALIAS 派生，无需手同步。
// LPCWSTR 等宽字符串 typedef 归一到 '<WCHAR>ptr' 指针布局。
const C_ALIAS = {
    int: 'i32', long: 'i32', short: 'i16', char: 'i8', float: 'f32', double: 'f64',
    DWORD: 'u32', UINT: 'u32', ULONG: 'u32', LONG: 'i32', BOOL: 'i32', HRESULT: 'i32',
    SHORT: 'i16', USHORT: 'u16', BYTE: 'u8', WCHAR: 'u16',
    LONG_PTR: '<>ptr', ULONG_PTR: '<>ptr', INT_PTR: '<>ptr', UINT_PTR: '<>ptr', DWORD_PTR: '<>ptr',
    SIZE_T: '<>ptr', WPARAM: '<>ptr', LPARAM: '<>ptr',
    HANDLE: '<>ptr', HWND: '<>ptr', HDC: '<>ptr', HMODULE: '<>ptr', HFONT: '<>ptr', HBRUSH: '<>ptr',
    HICON: '<>ptr', HBITMAP: '<>ptr', LPVOID: '<>ptr', LPCVOID: '<>ptr',
    LPCWSTR: '<WCHAR>ptr', PCWSTR: '<WCHAR>ptr', LPWSTR: '<WCHAR>ptr',
} as const

export type CTypeOf = typeof C_ALIAS

export type Norm<T extends string> = T extends keyof CTypeOf ? CTypeOf[T] : T

// 指针的编译期品牌（运行期擦除，值就是 number）：'<>ptr'（T=''）直接退化成 number，
// 带名 '<NAME>ptr' 提供名义约束 —— 不同 <NAME>ptr 不可互串，裸 number 不可传给 <NAME>ptr。
declare const ptrBrand: unique symbol
export type Ptr<T extends string = ''> =
    [T] extends [''] ? number : number & { readonly [ptrBrand]: T }
// 旧名别名（bind 参数/返回、StructAlloc.ptr 仍在用，保持兼容）。
export type StructPtr<N extends string> = Ptr<N>

const KIND_SET: ReadonlySet<string> = new Set<string>([
    'void', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32',
    'u64', 'i64', 'u64n', 'i64n', 'f32', 'f64', 'ptr',
])

const PTR_LAYOUT_RE = /^<(\w+)>ptr$/

// 指针宽：与 bind 的调用约定 / quickjs-ffi-type.h 一致。
export const PTR_SIZE = os.arch === 'x64' ? 8 : 4

export function normKind(t: string): Kind {
    const k = normToken(t)
    if (!KIND_SET.has(k)) throw new Error(`ffi-bind: invalid kind "${t}"`)
    return k as Kind
}

// token 归一：C/Windows typedef 别名 → 规范形式（'HANDLE' → '<>ptr' 等）。
export function normToken(t: string): string {
    return (C_ALIAS as Record<string, string>)[t] ?? t
}

// token（C 别名归一后）是否为 <NAME>ptr 指针布局；是则返回 NAME，否则 undefined。
// 注意 '<>ptr'（空名裸指针）不匹配 —— 调用方按裸指针另行处理。
export function ptrLayoutName(t: string): string | undefined {
    const m = PTR_LAYOUT_RE.exec(normToken(t))
    return m ? m[1]! : undefined
}

// token（C 别名归一后）是否为 <NAME>ptr 指针布局。
export function isPointerLayout(t: string): boolean {
    return ptrLayoutName(t) !== undefined
}
