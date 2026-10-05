import * as ffi from 'ffi'
import * as os from 'os'
import * as std from 'std'
import * as win from 'win'
import '../text-codec.js'
import { type C_BasicType, C_BasicType_No_Void, C_BasicType_Token, C_BasicType_Token_No_Void, cTokenToType, isCPtrToken, JsTypeOfToken, normToken, PTR_SIZE, ptrName, readScalar, TokenArgJsTypeMap, TokenReturnJsTypeMap, writeSlot } from './ctype.js'

// 形状刻意是「方法」而非裸函数：ffi-struct 的 struct()/union() 结果（StructDef）
// 结构上即满足 encode(v, buf?, offset?) -> ArrayBuffer，用户布局可直接透传。
type Encoder<V> = { encode(v: V, buf?: ArrayBuffer, offset?: number): ArrayBuffer }
type EncoderMap = Record<string, Encoder<any>>

const _dllCache: Map<string, win.HMODULE> = new Map()

function loadDll(dll: string): win.HMODULE {
    const cached = _dllCache.get(dll)
    if (cached !== undefined) return cached
    const loaded = win.LoadLibrary(dll)
    if (!loaded) throw new Error(`ffi-bind: LoadLibrary("${dll}") failed`)
    _dllCache.set(dll, loaded)
    return loaded
}

function parseSig(sig: string): { argTokens: C_BasicType_Token_No_Void[]; retToken: C_BasicType_Token } {
    const parts = sig.split(' -> ')
    if (parts.length !== 2) {
        throw new Error(`ffi-bind: invalid signature "${sig}" (expected "arg1 arg2 -> ret")`)
    }
    // 零参数签名是 ' -> u32'，此时 parts[0]===''，split(' ') 会产出 ['']；
    // 空串必须先滤掉，否则 normToken('') 抛 Unknown token 整个 suite 崩。
    const _args = parts[0]!.split(' ').filter(t => t !== '').map(normToken)
    const args: C_BasicType_Token_No_Void[] = []
    for (const arg of _args) {
        if (arg === 'void') {
            throw new Error("Void can not in args")
        }
        args.push(arg)
    }

    // 裸 'ptr'/非法 token 由类型层拦截（C_BasicType_Token 已 Exclude 'ptr'、拼错 token 塌成 never）；
    // 运行时再比较只会得到 TS2367「两类型无重叠」——类型已表达的约束不重复校验。
    return { argTokens: args, retToken: normToken(parts[1]!) }
}

function makeFn(proc: number, sig: string, encoders: EncoderMap): (...a: unknown[]) => unknown {
    const { argTokens, retToken } = parseSig(sig)
    return (...a: unknown[]) => callPacked(proc, argTokens, retToken, a, encoders)
}

// 每个参数在 argFrame 里占的字节数。与 quickjs-ffi-type.h 的 qwin_ffi_arg_size[]
// 保持一致（ia32：≤4B 类型进 4 字节、更大的进 8 字节；x64：恒 8 字节槽）。
// 注意这是「槽宽」，不是类型的 sizeof——同一定义也用于返回槽。指针布局恒指针宽。
const IA32_ARG_SIZE: Record<C_BasicType_No_Void, number> = {
    u8: 4, i8: 4, u16: 4, i16: 4, u32: 4, i32: 4,
    u64: 8, i64: 8, f32: 4, f64: 8,
    ptr: PTR_SIZE,
}
// x64 桩无条件双读 slots[0..3]，故 argFrame 至少 4 个槽（32 字节）
const X64_MIN_SLOTS = 4

function callPacked(proc: number, argTokens: C_BasicType_Token_No_Void[], retToken: C_BasicType_Token, args: any[], encoders: EncoderMap): unknown {
    const is64 = os.arch === 'x64'

    const getWidth = (t: C_BasicType_Token_No_Void, is64: boolean): number => {
        if (is64) return 8
        if (isCPtrToken(t)) return PTR_SIZE
        return IA32_ARG_SIZE[t]
    }

    let total = 0
    for (const t of argTokens) total += getWidth(t, is64)
    if (is64 && argTokens.length < X64_MIN_SLOTS) total = X64_MIN_SLOTS * 8

    const argFrame = new ArrayBuffer(total)
    const dv = new DataView(argFrame)
    const held: ArrayBuffer[] = []  // 指针布局编码缓冲需存活到调用结束

    let off = 0

    for (let i = 0; i < argTokens.length; i++) {
        const argToken = argTokens[i]!
        const arg = args[i]
        if (isCPtrToken(argToken)) {
            const name = ptrName(argToken)   // '' = <>ptr 裸地址档
            if (arg === null) {
                writeSlot(dv, off, { k: 'ptr', v: 0 })
            } else if (typeof arg === 'number') {
                // 裸地址 / 品牌指针（Ptr<'NAME'> 是 number）透传，不重编码。
                // 合法值形态由类型层约束（如 <BYTE>ptr 只收 ArrayBuffer|null），此处不重复校验。
                writeSlot(dv, off, { k: 'ptr', v: arg })
            } else {
                const encoder = encoders[name]
                if (!encoder) {
                    // undefined / 未知布局落到这：指针只收 null 或有效地址，不静默当 0。
                    throw new Error(name === ''
                        ? `ffi-bind: <>ptr expects number|null, got ${typeof arg}; use <BYTE>ptr to pass an ArrayBuffer, or ffi.bufferPtr(buf)`
                        : `ffi-bind: unknown layout "<${name}>ptr" (available: ${Object.keys(encoders).join(', ') || 'none'})`)
                }
                const buf = encoder.encode(arg)
                held.push(buf)
                writeSlot(dv, off, { k: 'ptr', v: ffi.bufferPtr(buf) })
            }
        }
        else {
            writeSlot(dv, off, { k: argToken, v: arg })
        }
        off += getWidth(argToken, is64)
    }

    const retBuf = new ArrayBuffer(8)
    const retIsFp = retToken === 'f32' || retToken === 'f64'
    ffi.ffiCall(proc, argFrame, retBuf, retIsFp ? 1 : 0)
    return readRet(cTokenToType(retToken), retBuf)
}

// 把标量参数写进 argFrame 槽位。ptr 为裸地址直通；引用型参数见 writePtrSlot。
function readRet(ret: C_BasicType, retBuf: ArrayBuffer): unknown {
    if (ret === 'void') return undefined
    return readScalar(new DataView(retBuf), 0, ret)
}

type ParseArgStr<S extends string, L, Acc extends unknown[] = []> =
    S extends `${infer F} ${infer R}`
    ? ParseArgStr<R, L, [...Acc, JsTypeOfToken<F, TokenArgJsTypeMap, L, never>]>
    : S extends ''
    ? Acc : [...Acc, JsTypeOfToken<S, TokenArgJsTypeMap, L, never>]

// 布局表：用户布局解包成 JS 形，并注入两个内建 codec 的值域，
// 使 <BYTE>ptr / <WCHAR>ptr 形参在类型层拿到 ArrayBuffer / string。
type BindEncoders<M> = {
    [K in keyof M]: M[K] extends Encoder<infer V> ? V : never
} & {
    WCHAR: string;
    BYTE: ArrayBuffer;
}

type BindFn<S extends string, L> =
    S extends `${infer ArgStr} -> ${infer RetStr}` ? ((...args: ParseArgStr<ArgStr, L>) => JsTypeOfToken<RetStr, TokenReturnJsTypeMap, {}, unknown>) : never

// 内建指针 encoder：类型校验放在这里，与「用户布局 encoder」同一分派点。
// BYTE/WCHAR 拒绝裸 number（无句柄可 pin），提示改用 <>ptr。
const builtinEncoders: EncoderMap = {
    WCHAR: {
        encode: (v: string) => {
            return new TextEncoder('utf-16le').encode(v + '\0').buffer
        }
    },
    BYTE: {
        encode: (v: ArrayBuffer) => {
            return v
        }
    },
}
export function bind<const S extends string, const L extends EncoderMap = {}>(
    dll: string, name: string, sig: S, encoders?: L) {
    const proc = win.GetProcAddress(loadDll(dll), name)
    if (!proc) throw new Error(`ffi-bind: proc "${name}" not found in ${dll}`)
    return makeFn(proc, sig, {
        ...builtinEncoders,
        ...encoders
    }) as unknown as BindFn<S, BindEncoders<L>>
}

export function bindLib<const M extends Record<string, string>, const L extends EncoderMap = {}>(
    dll: string, map: M, encoders?: EncoderMap) {
    const out: Record<string, (...a: unknown[]) => unknown> = {}
    const h = loadDll(dll)
    for (const [name, sig] of Object.entries(map)) {
        const proc = win.GetProcAddress(h, name)
        if (!proc) throw new Error(`ffi-bind: proc "${name}" not found in ${dll}`)
        out[name] = makeFn(proc, sig, {
            ...builtinEncoders, ...encoders
        })
    }
    return out as { [K in keyof M]: BindFn<M[K], BindEncoders<L>> }
}

/* ---- 闭包（回调）：JS 函数 → 可传给 Win32 API 的函数指针 ---- */

// 共享解码/编码助手：由每个闭包的 wrapper 调用（wrapper 闭包捕获 args/ret/fn）。
function dispatchClosure(args: C_BasicType_No_Void[], ret: C_BasicType, fn: (...a: unknown[]) => unknown,
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
            a.push(readScalar(fv, base, k))
        } else {
            a.push(readScalar(fv, off, k))
            off += IA32_ARG_SIZE[k]
        }
    }
    let r: any
    try {
        r = fn(...a)
    } catch (err) {
        std.printf('[ffi] closure callback threw: %s\n', String(err))
        return                            // 结果槽保持 0
    }
    if (ret !== 'void') {
        writeSlot(dv, 0, { k: ret, v: r })
    }
}

/** 把 JS 函数变成可传给 Win32 API 的函数指针（同步同线程回调）。
 *  sig 为回调签名：实参只许 BasicKind（ptr 读回 number|null），
 *  返回只许 void|u8..u64|i8..i64|f32|f64|ptr（u64/i64 走 EDX:EAX，x64 走 RAX）。
 *  opts.stdcall 仅 ia32 有效（默认 true，Win32 回调标准 CALLBACK）；msvcrt 等
 *  cdecl 库回调传 { stdcall: false }。x64 恒由调用方清栈，无需指定。
 *  返回 { ptr, dispose }：ptr 即函数指针（传给 API 的 ptr 参数）；dispose 注销
 *  并释放回调函数，幂等；闭包期间回调被强引用，不会被 GC 回收。
 *  注意：dispose 后 ptr 不得再被任何 native 方引用。 */
export function closure<S extends string>(sig: S, fn: BindFn<S, {}>,
    opts?: { stdcall?: boolean }): { ptr: number; dispose(): void } {
    const { argTokens, retToken } = parseSig(sig)
    const argTypes = argTokens.map(cTokenToType)
    const retType = cTokenToType(retToken)
    const is64 = os.arch === 'x64'
    const argBytes = (opts?.stdcall === false || is64) ? 0 : argTypes.reduce((s, k) => s + IA32_ARG_SIZE[k], 0)
    const retKind = retToken === 'f32' ? 1
        : retToken === 'f64' ? 2
            : (retToken === 'u64' || retToken === 'i64') ? 3
                : 0
    // per-closure wrapper：闭包捕获 args/ret/fn，C 侧只存它 + ctx；回调永远
    // 回到创建它的 context（无跨 context 全局、无 registry）。
    const wrapper = (frameBuf: ArrayBuffer, retBuf: ArrayBuffer): void => {
        dispatchClosure(argTypes, retType, fn as (...a: unknown[]) => unknown, frameBuf, retBuf)
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
