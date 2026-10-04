import * as ffi from 'ffi'
import * as win from 'win'
import * as os from 'os'
import * as std from 'std'
import '../text-codec.js'
import { type Kind, type Norm, type StructPtr, PTR_SIZE, normKind, ptrLayoutName } from './ctype.js'

// 标量 kind / C 别名表见 ./ctype.js；此处透传其公共类型与函数，保持 bind.js 深导入面不变。
export * from './ctype.js'

// 声明式 FFI 绑定：把字符串签名（'ptr i32 -> i32'）解析成可调用函数（bind）
// 或一个 dll 的签名表（bindLib）。
// kind：
//   BasicKind = void u8 i8 u16 i16 u32 i32 u64 i64 u64n i64n f32 f64 ptr
//     ptr       number|null —— 裸地址；buffer 用 ffi.bufferPtr 取址或改用 <VOID>ptr
//   指针布局 <NAME>ptr（调用期 pin，按指针宽读写）：
//     <VOID>ptr     ArrayBuffer|null —— 原样传 JS 缓冲（仅参数）
//     <WCHAR>ptr    string|null —— utf-16le+'\0' 编码（仅参数）
//     <STRUCT>ptr   参数：布局 JS 形（编码成 buffer）或 StructPtr<STRUCT>（裸地址透传）；
//                   返回：StructPtr<STRUCT>（指针，品牌在类型层，不解码内容）
//   u64/i64 收 number（0..2^53 连续无损，之上有空洞即 lossy）；u64n/i64n 收
//   bigint、端到端 64 位全精确（恰 64 位，DataView 天然范围护栏）。裸 bigint
//   类型会误读为任意精度，故用 i64n/u64n 显式钉死「恰 64 位」语义。
//   指针/缓冲/字符串实参一一对应各自类型，运行时严格校验；null 恒 →0。
//   <VOID>ptr/<WCHAR>ptr 不可作返回类型（返回裸地址/宽串指针请用 ptr）。
//   可用 C/Windows typedef 别名：int long short char float double
//     + DWORD UINT LONG BOOL HRESULT ... + *_PTR WPARAM LPARAM SIZE_T
//     + HANDLE HWND HDC ... (+ LPVOID 等指针 typedef)
//   别名在 token 层归一化到规范形式（C_ALIAS as const 单源，见 ./ctype.js）；
//   LPCWSTR/PCWSTR/LPWSTR → '<WCHAR>ptr'，其余指针 typedef → ptr。

// 原生标量（传值/地址）类型表：实参、返回共用
type BasicTypeOf = {
    u8: number; i8: number; u16: number; i16: number
    u32: number; i32: number
    u64: number; i64: number
    u64n: bigint; i64n: bigint
    f32: number; f64: number
    ptr: number | null
}

type ArgTypeOf = BasicTypeOf

// 返回表 = 标量表 + void（返回没有封送可言）
type RetTypeOf = BasicTypeOf & {
    void: void
}

// 用户布局：把 JS 形编码成 buffer 供 <NAME>ptr 输入。ffi-struct 的 struct()
// 结果（StructDef）结构上即满足（encode(v) -> ArrayBuffer）。
export type Layout<V = unknown> = {
    encode(v: V, buf?: ArrayBuffer, offset?: number): ArrayBuffer
}
export type LayoutMap = Record<string, Layout<any>>
export type LayoutValue<T> = T extends Layout<infer V> ? V : never

// <NAME>ptr 实参：内建布局（VOID/WCHAR）或用户布局 —— 结构形（编码）或 StructPtr（透传）。
type PtrArgType<N extends string, L> =
    N extends 'VOID' ? ArrayBuffer | null
        : N extends 'WCHAR' ? string | null
            : StructPtr<N> | null | (N extends keyof L ? LayoutValue<L[N]> : never)

type ArgToken<T extends string, L> =
    Norm<T> extends `<${infer N}>ptr` ? PtrArgType<N, L>
        : ArgTypeOf[Norm<T> & keyof ArgTypeOf]

type ArgsOf<T extends string, L> =
    T extends '' ? []
        : T extends `${infer H} ${infer R}` ? [ArgToken<H, L>, ...ArgsOf<R, L>]
            : [ArgToken<T, L>]

type _Args<S extends string, L = {}> = S extends `${infer P} -> ${string}` ? ArgsOf<P, L> : never

// 返回位：用户 <STRUCT>ptr → StructPtr<N>（指针，不解码）；VOID/WCHAR 返回非法。
type RetToken<T extends string> =
    Norm<T> extends `<${infer N}>ptr`
        ? N extends 'VOID' | 'WCHAR' ? never : StructPtr<N> | null
        : RetTypeOf[Norm<T> & keyof RetTypeOf]

type _Ret<S extends string> = S extends `${string} -> ${infer R}` ? RetToken<R> : never

const _dllCache: Map<string, win.HMODULE> = new Map()

function loadDll(dll: string): win.HMODULE {
    const cached = _dllCache.get(dll)
    if (cached !== undefined) return cached
    const loaded = win.LoadLibrary(dll)
    if (!loaded) throw new Error(`ffi-bind: LoadLibrary("${dll}") failed`)
    _dllCache.set(dll, loaded)
    return loaded
}

/* ---- 指针布局 codec：把 JS 值编码成原生指针 ---- */

type PtrCodec = {
    name: string
    encode(v: unknown, held: ArrayBuffer[]): number
}

const VOID_PTR: PtrCodec = {
    name: 'VOID',
    encode(v, held) {
        if (v === null || v === undefined) return 0
        if (!(v instanceof ArrayBuffer)) {
            throw new Error(`ffi-bind: <VOID>ptr expects ArrayBuffer|null, got ${typeof v}; use kind "ptr" for a raw address, or ffi.bufferPtr(buf)`)
        }
        held.push(v)  // 调用期 pin：GC 在 ffiCall 返回前不可回收
        return ffi.bufferPtr(v)
    },
}

const WCHAR_PTR: PtrCodec = {
    name: 'WCHAR',
    encode(v, held) {
        if (v === null || v === undefined) return 0
        if (typeof v !== 'string') {
            throw new Error(`ffi-bind: <WCHAR>ptr expects string|null, got ${typeof v}; use kind "ptr" for a raw address`)
        }
        const enc = new TextEncoder('utf-16le').encode(v + '\0')
        const buf = enc.buffer as ArrayBuffer
        held.push(buf)
        return ffi.bufferPtr(buf)
    },
}

const BUILTIN_PTR_CODECS: Record<string, PtrCodec> = { VOID: VOID_PTR, WCHAR: WCHAR_PTR }

// 用户布局 codec：延迟解析 —— 只有真的收到「结构形」实参时才要求 layouts 里存在该布局；
// 纯 brand number / null 透传不需要 layout（与参数类型层一致，bind 期不再抛）。
function userPtrCodec(name: string, layouts: LayoutMap | undefined): PtrCodec {
    return {
        name,
        encode(v, held) {
            if (v === null || v === undefined) return 0
            if (typeof v === 'number') return v  // StructPtr 品牌指针 → 裸地址透传
            const lay = layouts?.[name]
            if (!lay) {
                const avail = [...Object.keys(BUILTIN_PTR_CODECS), ...Object.keys(layouts ?? {})]
                throw new Error(`ffi-bind: unknown layout "<${name}>ptr" (available: ${avail.join(', ') || 'none'})`)
            }
            const buf = lay.encode(v)
            held.push(buf)  // 调用期 pin
            return ffi.bufferPtr(buf)
        },
    }
}

// 解析一个 <NAME>ptr codec：内建（VOID/WCHAR）即时取 —— 保持其严格类型校验；
// 用户布局延迟到 encode（收到结构形）时才查。
function ptrCodec(name: string, layouts: LayoutMap | undefined): PtrCodec {
    return BUILTIN_PTR_CODECS[name] ?? userPtrCodec(name, layouts)
}

// 解析后的实参规格：'val' = 标量 kind；'ptr' = <NAME>ptr 指针布局 codec。
type ArgSpec = { t: 'val'; k: Kind } | { t: 'ptr'; c: PtrCodec }
// 返回规格：'val' 标量；'ptr' = 用户 <STRUCT>ptr 返回（只读指针，品牌在类型层）。
type RetSpec = { t: 'val'; k: Kind } | { t: 'ptr'; name: string }

function parseSig(sig: string, layouts?: LayoutMap): { args: ArgSpec[]; ret: RetSpec } {
    const parts = sig.split(' -> ')
    const ret = parts[1]
    if (ret === undefined || parts.length > 2) {
        throw new Error(`ffi-bind: invalid signature "${sig}" (expected "arg1 arg2 -> ret")`)
    }
    let retSpec: RetSpec
    const retName = ptrLayoutName(ret)
    if (retName !== undefined) {
        if (retName === 'VOID' || retName === 'WCHAR') {
            throw new Error(`ffi-bind: "<${retName}>ptr" cannot be a return type (use "ptr")`)
        }
        // 宽松：返回只读指针，不要求 layouts 里注册该布局（品牌是编译期的）。
        retSpec = { t: 'ptr', name: retName }
    } else {
        retSpec = { t: 'val', k: normKind(ret) }
    }
    const tokens = (parts[0] ?? '') === '' ? [] : (parts[0] as string).split(' ')
    const args = tokens.map((t): ArgSpec => {
        const name = ptrLayoutName(t)
        if (name !== undefined) return { t: 'ptr', c: ptrCodec(name, layouts) }
        return { t: 'val', k: normKind(t) }
    })
    return { args, ret: retSpec }
}

function makeFn(proc: number, sig: string, layouts?: LayoutMap): (...a: unknown[]) => unknown {
    const { args, ret } = parseSig(sig, layouts)
    return (...a: unknown[]) => callPacked(proc, args, ret, a)
}

// 每个参数在 argFrame 里占的字节数。与 quickjs-ffi-type.h 的 qwin_ffi_arg_size[]
// 保持一致（ia32：≤4B 类型进 4 字节、更大的进 8 字节；x64：恒 8 字节槽）。
// 注意这是「槽宽」，不是类型的 sizeof——同一定义也用于返回槽。指针布局恒指针宽。
const ARG_SIZE: Record<Kind, number> = {
    void: 0, u8: 4, i8: 4, u16: 4, i16: 4, u32: 4, i32: 4,
    u64: 8, i64: 8, u64n: 8, i64n: 8, f32: 4, f64: 8,
    ptr: PTR_SIZE,
}
// x64 桩无条件双读 slots[0..3]，故 argFrame 至少 4 个槽（32 字节）
const X64_MIN_SLOTS = 4

function specWidth(s: ArgSpec, is64: boolean): number {
    if (is64) return 8
    return s.t === 'val' ? ARG_SIZE[s.k] : PTR_SIZE
}

function callPacked(proc: number, args: ArgSpec[], ret: RetSpec, a: unknown[]): unknown {
    const is64 = os.arch === 'x64'
    // 先算总槽宽；x64 固定 8 字节/槽
    let total = 0
    for (const s of args) total += specWidth(s, is64)
    if (is64 && args.length < X64_MIN_SLOTS) total = X64_MIN_SLOTS * 8

    const argFrame = new ArrayBuffer(total)
    const dv = new DataView(argFrame)
    const held: ArrayBuffer[] = []  // 指针布局编码缓冲需存活到调用结束

    let off = 0
    for (let i = 0; i < args.length; i++) {
        const s = args[i]!
        if (s.t === 'ptr') writePtrSlot(dv, off, s.c, a[i], held)
        else writeSlot(dv, off, s.k, a[i])
        off += specWidth(s, is64)
    }

    const retBuf = new ArrayBuffer(8)
    const retIsFp = ret.t === 'val' && (ret.k === 'f32' || ret.k === 'f64')
    ffi.ffiCall(proc, argFrame, retBuf, retIsFp ? 1 : 0)
    return readRet(ret, retBuf)
}

// 指针布局参数：codec.encode 出指针整数，按指针宽写槽；编码缓冲由 held 保活。
function writePtrSlot(dv: DataView, off: number, c: PtrCodec, v: unknown, held: ArrayBuffer[]): void {
    const p = c.encode(v, held)
    if (PTR_SIZE === 8) dv.setBigUint64(off, BigInt(p), true)
    else dv.setUint32(off, p >>> 0, true)
}

// 把标量参数写进 argFrame 槽位。ptr 为裸地址直通；引用型参数见 writePtrSlot。
function writeSlot(dv: DataView, off: number, k: Kind, v: unknown): void {
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
        case 'ptr': {
            const p = slotRawPtr(v)
            if (ptrW === 8) dv.setBigUint64(off, BigInt(p), true)
            else dv.setUint32(off, p >>> 0, true)
            break
        }
        case 'void': break
    }
}

// ptr 参数 → 裸地址整数；number 直通，null/undefined →0，其余报错并提示 <VOID>ptr。
function slotRawPtr(v: unknown): number {
    if (v === null || v === undefined) return 0
    if (typeof v === 'number') return v
    throw new Error(`ffi-bind: ptr expects number|null, got ${typeof v}; use <VOID>ptr to pass an ArrayBuffer, or ffi.bufferPtr(buf)`)
}

// 从 retBuf 按返回类型解码。'ptr' 布局返回读指针宽、NULL→null；标量按声明宽度截断/扩展。
function readRet(ret: RetSpec, retBuf: ArrayBuffer): unknown {
    const dv = new DataView(retBuf)
    const ptrW = PTR_SIZE
    if (ret.t === 'ptr') {
        const p = ptrW === 8 ? Number(dv.getBigUint64(0, true)) : dv.getUint32(0, true)
        return p === 0 ? null : p
    }
    switch (ret.k) {
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
    throw new Error(`ffi-bind: unsupported return kind "${ret.k}"`)
}

export function bind<const S extends string, const L extends LayoutMap = {}>(
    dll: string, name: string, sig: S, layouts?: L): (...args: _Args<S, L>) => _Ret<S> {
    const proc = win.GetProcAddress(loadDll(dll), name)
    if (!proc) throw new Error(`ffi-bind: proc "${name}" not found in ${dll}`)
    return makeFn(proc, sig, layouts) as unknown as (...args: _Args<S, L>) => _Ret<S>
}

export function bindLib<const M extends Record<string, string>, const L extends LayoutMap = {}>(
    dll: string, map: M, layouts?: L):
    { [K in keyof M]: (...args: _Args<M[K], L>) => _Ret<M[K]> } {
    const out: Record<string, (...a: unknown[]) => unknown> = {}
    const h = loadDll(dll)
    for (const [name, sig] of Object.entries(map)) {
        const proc = win.GetProcAddress(h, name)
        if (!proc) throw new Error(`ffi-bind: proc "${name}" not found in ${dll}`)
        out[name] = makeFn(proc, sig, layouts)
    }
    return out as { [K in keyof M]: (...args: _Args<M[K], L>) => _Ret<M[K]> }
}

/* ---- 闭包（回调）：JS 函数 → 可传给 Win32 API 的函数指针 ---- */

// 回调签名约束：实参只许 BasicKind（native 传原始值/指针）；返回只许 ≤32 位整/ptr/f32/f64
const CLOSURE_ARG_OK: ReadonlySet<string> = new Set<string>(['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'u64n', 'i64n', 'f32', 'f64', 'ptr'])
const CLOSURE_RET_OK: ReadonlySet<string> = new Set<string>(['void', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'f32', 'f64', 'ptr'])

// 从捕获 frame 解一个实参。x64: 8 字节槽（浮点取 xmm 区）；ia32: 按 ARG_SIZE 连续排列。
function decodeArg(k: Kind, dv: DataView, off: number, w64: boolean): unknown {
    switch (k) {
        case 'u8': return dv.getUint32(off, true) & 0xFF
        case 'i8': { const b = dv.getUint8(off); return (b & 0x80) ? b - 0x100 : b }
        case 'u16': return dv.getUint32(off, true) & 0xFFFF
        case 'i16': { const s = dv.getUint16(off, true); return (s & 0x8000) ? s - 0x10000 : s }
        case 'u32': return dv.getUint32(off, true)
        case 'i32': return dv.getInt32(off, true)
        case 'u64': return Number(dv.getBigUint64(off, true))
        case 'i64': return Number(dv.getBigInt64(off, true))
        case 'u64n': return dv.getBigUint64(off, true)
        case 'i64n': return dv.getBigInt64(off, true)
        case 'f32': return dv.getFloat32(off, true)
        case 'f64': return dv.getFloat64(off, true)
        case 'ptr': {
            const p = w64 ? Number(dv.getBigUint64(off, true)) : dv.getUint32(off, true)
            return p === 0 ? null : p
        }
        default: return undefined
    }
}

// 共享解码/编码助手：由每个闭包的 wrapper 调用（wrapper 闭包捕获 args/ret/fn）。
function dispatchClosure(args: Kind[], ret: Kind, fn: (...a: unknown[]) => unknown,
    frameBuf: ArrayBuffer, retBuf: ArrayBuffer): void {
    const dv = new DataView(retBuf)
    const is64 = os.arch === 'x64'
    const fv = new DataView(frameBuf)
    const a: unknown[] = []
    let off = 0
    for (let i = 0; i < args.length; i++) {
        const k = args[i]!
        if (is64) {
            const fp = k === 'f32' || k === 'f64'
            const base = fp
                ? (i < 4 ? 128 + i * 8 : 32 + (i - 4) * 8)   // xmm 区（前 4）/ 溢出区
                : (i < 4 ? i * 8 : 32 + (i - 4) * 8)          // 整数寄存器区 / 溢出区
            a.push(decodeArg(k, fv, base, true))
        } else {
            a.push(decodeArg(k, fv, off, false))
            off += ARG_SIZE[k]
        }
    }
    let r: unknown
    try {
        r = fn(...a)
    } catch (err) {
        std.printf('[ffi] closure callback threw: %s\n', String(err))
        return                            // 结果槽保持 0
    }
    if (ret !== 'void') {
        try { writeSlot(dv, 0, ret, r) } catch { /* 返回类型不合法：保持 0 */ }
    }
}

/** 把 JS 函数变成可传给 Win32 API 的函数指针（同步同线程回调）。
 *  sig 为回调签名：实参只许 BasicKind（ptr 读回 number|null），
 *  返回只许 void|u8..u32|i8..i32|f32|f64|ptr（ia32 回调 ABI 无 64 位整数返回）。
 *  opts.stdcall 仅 ia32 有效（默认 true，Win32 回调标准 CALLBACK）；msvcrt 等
 *  cdecl 库回调传 { stdcall: false }。x64 恒由调用方清栈，无需指定。
 *  返回 { ptr, dispose }：ptr 即函数指针（传给 API 的 ptr 参数）；dispose 注销
 *  并释放回调函数，幂等；闭包期间回调被强引用，不会被 GC 回收。
 *  注意：dispose 后 ptr 不得再被任何 native 方引用。 */
export function closure<S extends string>(sig: S, fn: (...args: _Args<S>) => _Ret<S>,
    opts?: { stdcall?: boolean }): { ptr: number; dispose(): void } {
    const { args, ret } = parseSig(sig)
    const argKinds: Kind[] = args.map((s) => {
        if (s.t === 'ptr') throw new Error(`ffi-bind: closure arg layout "<${s.c.name}>ptr" not supported (BasicKind only)`)
        if (!CLOSURE_ARG_OK.has(s.k)) throw new Error(`ffi-bind: closure arg kind "${s.k}" not supported (BasicKind only)`)
        return s.k
    })
    if (ret.t === 'ptr') throw new Error(`ffi-bind: closure return layout "<${ret.name}>ptr" not supported (BasicKind only)`)
    if (!CLOSURE_RET_OK.has(ret.k)) throw new Error(`ffi-bind: closure return kind "${ret.k}" not supported (void|u8..u32|i8..i32|f32|f64|ptr)`)
    const is64 = os.arch === 'x64'
    const argBytes = (opts?.stdcall === false || is64) ? 0 : argKinds.reduce((s, k) => s + ARG_SIZE[k], 0)
    const retKind = ret.k === 'f32' ? 1 : ret.k === 'f64' ? 2 : 0
    // per-closure wrapper：闭包捕获 args/ret/fn，C 侧只存它 + ctx；回调永远
    // 回到创建它的 context（无跨 context 全局、无 registry）。
    const wrapper = (frameBuf: ArrayBuffer, retBuf: ArrayBuffer): void => {
        dispatchClosure(argKinds, ret.k, fn as (...a: unknown[]) => unknown, frameBuf, retBuf)
    }
    const ptr = ffi.closureNew(argBytes, retKind, wrapper)
    let done = false
    return {
        ptr,
        dispose(): void {
            if (done) return
            done = true
            ffi.closureFree(ptr)
        },
    }
}
