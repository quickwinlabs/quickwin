import * as os from 'os'

// 标量 kind 词汇表（bind 与 struct 共用）：规范 kind 集合、C/Windows typedef 别名表、
// token 归一化与校验。刻意不依赖 win/std/text-codec，可作叶子模块被 struct 直接引用，
// 避免「只用 struct」的调用方被动加载整个 bind 运行时。

// kind：
//   BasicKind = void u8 i8 u16 i16 u32 i32 u64 i64 u64n i64n f32 f64 ptr
//   指针布局 <NAME>ptr（调用期 pin，按指针宽读写）见 bind.ts。
// 可用 C/Windows typedef 别名：int long short char float double
//   + DWORD UINT LONG BOOL HRESULT ... + *_PTR WPARAM LPARAM SIZE_T
//   + HANDLE HWND HDC ... (+ LPVOID 等指针 typedef)
type BasicKind = 'void' | 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'u64' | 'i64' | 'u64n' | 'i64n' | 'f32' | 'f64' | 'ptr'
export type Kind = BasicKind

// C / Windows typedef → 规范 token。Windows x86/x64 均 LLP64：int/long 恒 32 位，
// long long 恒 64 位；LONG_PTR/WPARAM/SIZE_T 等指针宽随 arch 走 'ptr' 槽。
// 单源常量（as const）：类型层 CTypeOf = typeof C_ALIAS 派生，无需手同步。
// LPCWSTR 等宽字符串 typedef 归一到 '<WCHAR>ptr' 指针布局。
const C_ALIAS = {
    int: 'i32', long: 'i32', short: 'i16', char: 'i8', float: 'f32', double: 'f64',
    DWORD: 'u32', UINT: 'u32', ULONG: 'u32', LONG: 'i32', BOOL: 'i32', HRESULT: 'i32',
    SHORT: 'i16', USHORT: 'u16', BYTE: 'u8', WCHAR: 'u16',
    LONG_PTR: 'ptr', ULONG_PTR: 'ptr', INT_PTR: 'ptr', UINT_PTR: 'ptr', DWORD_PTR: 'ptr',
    SIZE_T: 'ptr', WPARAM: 'ptr', LPARAM: 'ptr',
    HANDLE: 'ptr', HWND: 'ptr', HDC: 'ptr', HMODULE: 'ptr', HFONT: 'ptr', HBRUSH: 'ptr',
    HICON: 'ptr', HBITMAP: 'ptr', LPVOID: 'ptr', LPCVOID: 'ptr',
    LPCWSTR: '<WCHAR>ptr', PCWSTR: '<WCHAR>ptr', LPWSTR: '<WCHAR>ptr',
} as const

export type CTypeOf = typeof C_ALIAS

export type Norm<T extends string> = T extends keyof CTypeOf ? CTypeOf[T] : T

// 结构体指针的编译期品牌（运行期擦除，值就是 number|null）：参数透传「返回的
// <STRUCT>ptr」时提供名义约束 —— 不同 <STRUCT>ptr 不可互串，裸 number 不可传。
declare const structPtrBrand: unique symbol
export type StructPtr<N extends string> = number & { readonly [structPtrBrand]: N }

const KIND_SET: ReadonlySet<string> = new Set<string>([
    'void', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32',
    'u64', 'i64', 'u64n', 'i64n', 'f32', 'f64', 'ptr',
])

const PTR_LAYOUT_RE = /^<(\w+)>ptr$/

// 指针宽：与 bind 的调用约定 / quickjs-ffi-type.h 一致。
export const PTR_SIZE = os.arch === 'x64' ? 8 : 4

export function normKind(t: string): Kind {
    const k = (C_ALIAS as Record<string, string>)[t] ?? t
    if (!KIND_SET.has(k)) throw new Error(`ffi-bind: invalid kind "${t}"`)
    return k as Kind
}

// token（C 别名归一后）是否为 <NAME>ptr 指针布局；是则返回 NAME，否则 undefined。
export function ptrLayoutName(t: string): string | undefined {
    const m = PTR_LAYOUT_RE.exec((C_ALIAS as Record<string, string>)[t] ?? t)
    return m ? m[1]! : undefined
}

// token（C 别名归一后）是否为 <NAME>ptr 指针布局。
export function isPointerLayout(t: string): boolean {
    return ptrLayoutName(t) !== undefined
}
