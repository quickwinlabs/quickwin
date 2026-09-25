import * as ffi from 'ffi'
import * as win from 'win'
import './text-codec.js'

// 声明式 FFI 绑定：把字符串签名（'ptr wstr i32 ptr i32 -> i32'）解析成
// 一个可调用函数（bind）或一个 dll 的签名表（bindLib）。
// kind：void u8 i8 u16 i16 u32 i32 u64 i64 f32 f64 ptr wstr
//   可用 C/Windows typedef 别名：int long short char float double
//     + DWORD UINT LONG BOOL HRESULT ... + *_PTR WPARAM LPARAM SIZE_T
//     + HANDLE HWND HDC ... (+ LPVOID/LPCWSTR 等指针 typedef)
//   别名在 token 层归一化到上面规范 kind（见 CTypeOf / C_ALIAS，两者须同步）
//   ptr   收 ArrayBuffer | number | null，槽宽=指针宽（ia32 4B / x64 8B）
//   wstr  收 string，自动 utf-16le+'\0' 编码后走 ptr 槽（仅参数，不能作返回）

type Kind = 'void' | 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'u64' | 'i64' | 'f32' | 'f64' | 'ptr' | 'wstr'

type ArgTypeOf = {
    u8: number; i8: number; u16: number; i16: number
    u32: number; i32: number
    u64: number; i64: number
    f32: number; f64: number
    ptr: ArrayBuffer | number | null
    wstr: string
}
type RetTypeOf = {
    u8: number; i8: number; u16: number; i16: number
    u32: number; i32: number
    u64: number; i64: number
    f32: number; f64: number
    ptr: number | null
}

// C / Windows typedef → 规范 kind。Windows x86/x64 均 LLP64：int/long 恒 32 位，
// long long 恒 64 位；LONG_PTR/WPARAM/SIZE_T 等指针宽随 arch 走 'ptr' 槽。
// 运行时见 C_ALIAS（两表内容必须保持一致）。
type CTypeOf = {
    int: 'i32'
    long: 'i32'
    short: 'i16'
    char: 'i8'
    float: 'f32'
    double: 'f64'
    DWORD: 'u32'
    UINT: 'u32'
    ULONG: 'u32'
    LONG: 'i32'
    BOOL: 'i32'
    HRESULT: 'i32'
    SHORT: 'i16'
    USHORT: 'u16'
    BYTE: 'u8'
    LONG_PTR: 'ptr'
    ULONG_PTR: 'ptr'
    INT_PTR: 'ptr'
    UINT_PTR: 'ptr'
    DWORD_PTR: 'ptr'
    SIZE_T: 'ptr'
    WPARAM: 'ptr'
    LPARAM: 'ptr'
    HANDLE: 'ptr'
    HWND: 'ptr'
    HDC: 'ptr'
    HMODULE: 'ptr'
    HFONT: 'ptr'
    HBRUSH: 'ptr'
    HICON: 'ptr'
    HBITMAP: 'ptr'
    LPVOID: 'ptr'
    LPCVOID: 'ptr'
    LPCWSTR: 'ptr'
    PCWSTR: 'ptr'
    LPWSTR: 'ptr'
}

export type Norm<T extends string> = T extends keyof CTypeOf ? CTypeOf[T] : T

type ArgsOf<T extends string> =
    T extends '' ? []
        : T extends `${infer H} ${infer R}` ? [ArgTypeOf[Norm<H> & keyof ArgTypeOf], ...ArgsOf<R>]
        : [ArgTypeOf[Norm<T> & keyof ArgTypeOf]]

type _Args<S extends string> = S extends `${infer A} -> ${string}` ? ArgsOf<A> : never
type _Ret<S extends string> = S extends `${string} -> ${infer R}` ? RetTypeOf[Norm<R> & keyof RetTypeOf] : never

const KIND_TO_FFI: Record<Kind, ffi.FfiType> = {
    void: ffi.FFI_TYPE_VOID,
    u8: ffi.FFI_TYPE_UINT8,
    i8: ffi.FFI_TYPE_SINT8,
    u16: ffi.FFI_TYPE_UINT16,
    i16: ffi.FFI_TYPE_SINT16,
    u32: ffi.FFI_TYPE_UINT32,
    i32: ffi.FFI_TYPE_SINT32,
    u64: ffi.FFI_TYPE_UINT64,
    i64: ffi.FFI_TYPE_SINT64,
    f32: ffi.FFI_TYPE_FLOAT,
    f64: ffi.FFI_TYPE_DOUBLE,
    ptr: ffi.FFI_TYPE_POINTER,
    wstr: ffi.FFI_TYPE_POINTER,
}

// 与类型层 CTypeOf 同步的运行时别名表
const C_ALIAS: Record<string, Kind> = {
    int: 'i32', long: 'i32', short: 'i16', char: 'i8', float: 'f32', double: 'f64',
    DWORD: 'u32', UINT: 'u32', ULONG: 'u32', LONG: 'i32', BOOL: 'i32', HRESULT: 'i32',
    SHORT: 'i16', USHORT: 'u16', BYTE: 'u8',
    LONG_PTR: 'ptr', ULONG_PTR: 'ptr', INT_PTR: 'ptr', UINT_PTR: 'ptr', DWORD_PTR: 'ptr',
    SIZE_T: 'ptr', WPARAM: 'ptr', LPARAM: 'ptr',
    HANDLE: 'ptr', HWND: 'ptr', HDC: 'ptr', HMODULE: 'ptr', HFONT: 'ptr', HBRUSH: 'ptr',
    HICON: 'ptr', HBITMAP: 'ptr', LPVOID: 'ptr', LPCVOID: 'ptr', LPCWSTR: 'ptr',
    PCWSTR: 'ptr', LPWSTR: 'ptr',
}

export function normKind(t: string): Kind {
    const k = C_ALIAS[t] ?? t
    if (!(k in KIND_TO_FFI)) throw new Error(`ffi-bind: invalid kind "${t}"`)
    return k as Kind
}

const _dllCache: Map<string, win.HMODULE> = new Map()

function loadDll(dll: string): win.HMODULE {
    const cached = _dllCache.get(dll)
    if (cached !== undefined) return cached
    const loaded = win.LoadLibrary(dll)
    if (!loaded) throw new Error(`ffi-bind: LoadLibrary("${dll}") failed`)
    _dllCache.set(dll, loaded)
    return loaded
}

function parseSig(sig: string): { args: Kind[]; ret: Kind } {
    const parts = sig.split(' -> ')
    const ret = parts[1]
    if (ret === undefined || parts.length > 2) {
        throw new Error(`ffi-bind: invalid signature "${sig}" (expected "arg1 arg2 -> ret")`)
    }
    const retK = normKind(ret)
    if (retK === 'wstr') throw new Error('ffi-bind: "wstr" cannot be a return type')
    const tokens = (parts[0] ?? '') === '' ? [] : (parts[0] as string).split(' ')
    const args = tokens.map((t) => normKind(t))
    return { args, ret: retK }
}

function makeFn(proc: number, sig: string): (...a: unknown[]) => unknown {
    const { args, ret } = parseSig(sig)
    const argTypes = args.map((k) => KIND_TO_FFI[k])
    const retType = KIND_TO_FFI[ret]
    return (...a: unknown[]) => {
        const vals = args.map((k, i) =>
            k === 'wstr' ? new TextEncoder('utf-16le').encode(String(a[i]) + '\0').buffer : a[i])
        return ffi.ffiCall(proc, argTypes as any, vals as any, retType)
    }
}

export function bind<const S extends string>(dll: string, name: string, sig: S): (...args: _Args<S>) => _Ret<S> {
    const proc = win.GetProcAddress(loadDll(dll), name)
    if (!proc) throw new Error(`ffi-bind: proc "${name}" not found in ${dll}`)
    return makeFn(proc, sig) as unknown as (...args: _Args<S>) => _Ret<S>
}

export function bindLib<const M extends Record<string, string>>(dll: string, map: M):
    { [K in keyof M]: (...args: _Args<M[K]>) => _Ret<M[K]> } {
    const out: Record<string, (...a: unknown[]) => unknown> = {}
    const h = loadDll(dll)
    for (const [name, sig] of Object.entries(map)) {
        const proc = win.GetProcAddress(h, name)
        if (!proc) throw new Error(`ffi-bind: proc "${name}" not found in ${dll}`)
        out[name] = makeFn(proc, sig)
    }
    return out as { [K in keyof M]: (...args: _Args<M[K]>) => _Ret<M[K]> }
}