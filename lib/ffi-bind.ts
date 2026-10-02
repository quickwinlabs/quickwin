import * as ffi from 'ffi'
import * as win from 'win'
import * as os from 'os'
import './text-codec.js'

// 声明式 FFI 绑定：把字符串签名（'ptr i32 -> i32'）解析成可调用函数（bind）
// 或一个 dll 的签名表（bindLib）。
// kind：
//   BasicKind = void u8 i8 u16 i16 u32 i32 u64 i64 u64n i64n f32 f64 ptr
//   Kind      = BasicKind | buf_ptr | wchar_ptr
//     ptr       number|null —— 裸地址；buffer 用 ffi.bufferPtr 取址或改用 buf_ptr
//     buf_ptr   ArrayBuffer|null —— 调用期 pin，按指针宽写槽
//     wchar_ptr string|null —— utf-16le+'\0' 编码 + 调用期 pin（仅参数）
//   u64/i64 收 number（0..2^53 连续无损，之上有空洞即 lossy）；u64n/i64n 收
//   bigint、端到端 64 位全精确（恰 64 位，DataView 天然范围护栏）。裸 bigint
//   类型会误读为任意精度，故用 i64n/u64n 显式钉死「恰 64 位」语义。
//   指针/缓冲/字符串实参一一对应各自类型，运行时严格校验；null 恒 →0。
//   buf_ptr/wchar_ptr 不可作返回类型（返回恒原始值/地址）。
//   可用 C/Windows typedef 别名：int long short char float double
//     + DWORD UINT LONG BOOL HRESULT ... + *_PTR WPARAM LPARAM SIZE_T
//     + HANDLE HWND HDC ... (+ LPVOID 等指针 typedef)
//   别名在 token 层归一化到规范 kind（C_ALIAS as const 单源，CTypeOf 由它派生）；
//   LPCWSTR/PCWSTR/LPWSTR → wchar_ptr，其余指针 typedef → ptr。

type BasicKind = 'void' | 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'u64' | 'i64' | 'u64n' | 'i64n' | 'f32' | 'f64' | 'ptr'
type Kind = BasicKind | 'buf_ptr' | 'wchar_ptr'

type ArgTypeOf = {
    u8: number; i8: number; u16: number; i16: number
    u32: number; i32: number
    u64: number; i64: number
    u64n: bigint; i64n: bigint
    f32: number; f64: number
    ptr: number | null
    buf_ptr: ArrayBuffer | null
    wchar_ptr: string | null
}
// 返回表 ⊂ BasicKind：返回没有封送可言
type RetTypeOf = {
    u8: number; i8: number; u16: number; i16: number
    u32: number; i32: number
    u64: number; i64: number
    u64n: bigint; i64n: bigint
    f32: number; f64: number
    ptr: number | null
}

// C / Windows typedef → 规范 kind。Windows x86/x64 均 LLP64：int/long 恒 32 位，
// long long 恒 64 位；LONG_PTR/WPARAM/SIZE_T 等指针宽随 arch 走 'ptr' 槽。
// 单源常量（as const）：类型层 CTypeOf = typeof C_ALIAS 派生，无需手同步。
const C_ALIAS = {
    int: 'i32', long: 'i32', short: 'i16', char: 'i8', float: 'f32', double: 'f64',
    DWORD: 'u32', UINT: 'u32', ULONG: 'u32', LONG: 'i32', BOOL: 'i32', HRESULT: 'i32',
    SHORT: 'i16', USHORT: 'u16', BYTE: 'u8',
    LONG_PTR: 'ptr', ULONG_PTR: 'ptr', INT_PTR: 'ptr', UINT_PTR: 'ptr', DWORD_PTR: 'ptr',
    SIZE_T: 'ptr', WPARAM: 'ptr', LPARAM: 'ptr',
    HANDLE: 'ptr', HWND: 'ptr', HDC: 'ptr', HMODULE: 'ptr', HFONT: 'ptr', HBRUSH: 'ptr',
    HICON: 'ptr', HBITMAP: 'ptr', LPVOID: 'ptr', LPCVOID: 'ptr',
    LPCWSTR: 'wchar_ptr', PCWSTR: 'wchar_ptr', LPWSTR: 'wchar_ptr',
} as const

export type CTypeOf = typeof C_ALIAS

export type Norm<T extends string> = T extends keyof CTypeOf ? CTypeOf[T] : T

type ArgsOf<T extends string> =
    T extends '' ? []
        : T extends `${infer H} ${infer R}` ? [ArgTypeOf[Norm<H> & keyof ArgTypeOf], ...ArgsOf<R>]
        : [ArgTypeOf[Norm<T> & keyof ArgTypeOf]]

type _Args<S extends string> = S extends `${infer P} -> ${string}` ? ArgsOf<P> : never
type _Ret<S extends string> = S extends `${string} -> ${infer R}` ? RetTypeOf[Norm<R> & keyof RetTypeOf] : never

const KIND_SET: ReadonlySet<Kind> = new Set<Kind>([
    'void', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32',
    'u64', 'i64', 'u64n', 'i64n', 'f32', 'f64', 'ptr', 'buf_ptr', 'wchar_ptr',
])

export function normKind(t: string): Kind {
    const k = (C_ALIAS as Record<string, Kind>)[t] ?? t
    if (!KIND_SET.has(k as Kind)) throw new Error(`ffi-bind: invalid kind "${t}"`)
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
    if (retK === 'buf_ptr' || retK === 'wchar_ptr') {
        throw new Error(`ffi-bind: "${retK}" cannot be a return type`)
    }
    const tokens = (parts[0] ?? '') === '' ? [] : (parts[0] as string).split(' ')
    const args = tokens.map((t) => normKind(t))
    return { args, ret: retK }
}

function makeFn(proc: number, sig: string): (...a: unknown[]) => unknown {
    const { args, ret } = parseSig(sig)
    return (...a: unknown[]) => callPacked(proc, args, ret, a)
}

// 每个参数在 argFrame 里占的字节数。与 quickjs-ffi-type.h 的 qwin_ffi_arg_size[]
// 保持一致（ia32：≤4B 类型进 4 字节、更大的进 8 字节；x64：恒 8 字节槽）。
// 注意这是「槽宽」，不是类型的 sizeof——同一定义也用于返回槽。
const PTR_SIZE = os.arch === 'x64' ? 8 : 4
const ARG_SIZE: Record<Kind, number> = {
    void: 0, u8: 4, i8: 4, u16: 4, i16: 4, u32: 4, i32: 4,
    u64: 8, i64: 8, u64n: 8, i64n: 8, f32: 4, f64: 8,
    ptr: PTR_SIZE, buf_ptr: PTR_SIZE, wchar_ptr: PTR_SIZE,
}
// x64 桩无条件双读 slots[0..3]，故 argFrame 至少 4 个槽（32 字节）
const X64_MIN_SLOTS = 4

function callPacked(proc: number, args: Kind[], ret: Kind, a: unknown[]): unknown {
    const is64 = os.arch === 'x64'
    // 先算总槽宽；x64 固定 8 字节/槽
    let total = 0
    for (const k of args) total += is64 ? 8 : ARG_SIZE[k]
    if (is64 && args.length < X64_MIN_SLOTS) total = X64_MIN_SLOTS * 8

    const argFrame = new ArrayBuffer(total)
    const dv = new DataView(argFrame)
    const held: ArrayBuffer[] = []  // buf_ptr/wchar 编码缓冲需存活到调用结束

    let off = 0
    for (let i = 0; i < args.length; i++) {
        const k = args[i]!
        const v = a[i]
        if (is64) {
            const w = 8
            writeSlot(dv, off, k, v, held)
            off += w
        } else {
            const w = ARG_SIZE[k]
            writeSlot(dv, off, k, v, held)
            off += w
        }
    }

    const retBuf = new ArrayBuffer(8)
    const retIsFp = ret === 'f32' || ret === 'f64'
    ffi.ffiCall(proc, argFrame, retBuf, retIsFp ? 1 : 0)
    return readRet(ret, retBuf)
}

// 把第 i 个参数写进 argFrame 槽位。指针系槽宽=指针宽，封送见 slotPtrArg。
function writeSlot(dv: DataView, off: number, k: Kind, v: unknown, held: ArrayBuffer[]): void {
    const ptrW = PTR_SIZE
    switch (k) {
        case 'u8': dv.setUint32(off, Number(v) >>> 0, true); break
        case 'i8': dv.setUint32(off, Number(v) >>> 0, true); break
        case 'u16': dv.setUint32(off, Number(v) >>> 0, true); break
        case 'i16': dv.setUint32(off, Number(v) >>> 0, true); break
        case 'u32': dv.setUint32(off, Number(v) >>> 0, true); break
        case 'i32': dv.setUint32(off, Number(v) >>> 0, true); break
        case 'u64': dv.setBigUint64(off, BigInt(Math.trunc(Number(v))), true); break
        case 'i64': dv.setBigInt64(off, BigInt(Math.trunc(Number(v))), true); break
        case 'u64n': {
            if (typeof v !== 'bigint') throw new Error(`ffi-bind: u64n expects bigint, got ${typeof v}`)
            dv.setBigUint64(off, v, true)   // 超 64 位 DataView 天然 RangeError
            break
        }
        case 'i64n': {
            if (typeof v !== 'bigint') throw new Error(`ffi-bind: i64n expects bigint, got ${typeof v}`)
            dv.setBigInt64(off, v, true)    // 超 64 位 DataView 天然 RangeError
            break
        }
        case 'f32': dv.setFloat32(off, Number(v), true); break
        case 'f64': dv.setFloat64(off, Number(v), true); break
        case 'ptr':
        case 'buf_ptr':
        case 'wchar_ptr': {
            const p = slotPtrArg(k, v, held)
            if (ptrW === 8) dv.setBigUint64(off, BigInt(p), true)
            else dv.setUint32(off, p >>> 0, true)
            break
        }
        case 'void': break
    }
}

// 指针系参数 → 指针整数。三 kind 各守各的类型，运行时严格校验：
//   ptr       number→裸地址直通；ArrayBuffer/others 报错（提示 buf_ptr / ffi.bufferPtr）
//   buf_ptr   ArrayBuffer→调用期 pin（held 撑到 ffiCall 返回）+ 取址；number/others 报错
//   wchar_ptr string→utf-16le+'\0' 编码 + 调用期 pin；number/others 报错（裸地址请用 ptr）
//   null/undefined→0（三者同）
function slotPtrArg(k: 'ptr' | 'buf_ptr' | 'wchar_ptr', v: unknown, held: ArrayBuffer[]): number {
    if (v === null || v === undefined) return 0
    if (k === 'ptr' && typeof v === 'number') return v
    if (k === 'buf_ptr' && v instanceof ArrayBuffer) {
        held.push(v)  // 调用期 pin：GC 在 ffiCall 返回前不可回收
        return ffi.bufferPtr(v)
    }
    if (k === 'wchar_ptr' && typeof v === 'string') {
        const enc = new TextEncoder('utf-16le').encode(v + '\0')
        const buf = enc.buffer as ArrayBuffer
        held.push(buf)
        return ffi.bufferPtr(buf)
    }
    const expect = k === 'ptr' ? 'number|null'
        : k === 'buf_ptr' ? 'ArrayBuffer|null' : 'string|null'
    const hint = k === 'ptr'
        ? '; use kind "buf_ptr" to pass an ArrayBuffer, or ffi.bufferPtr(buf)'
        : '; use kind "ptr" to pass a raw address'
    throw new Error(`ffi-bind: ${k} expects ${expect}${hint}, got ${typeof v}`)
}

// 从 retBuf 按返回类型解码。指针槽读指针宽；NULL→null；数值按声明宽度截断/扩展。
function readRet(ret: Kind, retBuf: ArrayBuffer): unknown {
    const dv = new DataView(retBuf)
    const ptrW = PTR_SIZE
    switch (ret) {
        case 'void': return undefined
        case 'u8': return dv.getUint32(0, true) & 0xFF
        case 'i8': { const b = dv.getUint8(0); return (b & 0x80) ? b - 0x100 : b }
        case 'u16': return dv.getUint32(0, true) & 0xFFFF
        case 'i16': { const s = dv.getUint16(0, true); return (s & 0x8000) ? s - 0x10000 : s }
        case 'u32': return dv.getUint32(0, true)
        case 'i32': return dv.getInt32(0, true)
        case 'u64': return Number(dv.getBigUint64(0, true))
        case 'i64': return Number(dv.getBigInt64(0, true))
        case 'u64n': return dv.getBigUint64(0, true)
        case 'i64n': return dv.getBigInt64(0, true)
        case 'f32': return dv.getFloat32(0, true)
        case 'f64': return dv.getFloat64(0, true)
        case 'ptr': {
            const p = ptrW === 8 ? Number(dv.getBigUint64(0, true)) : dv.getUint32(0, true)
            return p === 0 ? null : p
        }
    }
    throw new Error(`ffi-bind: unsupported return kind "${ret}"`)
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