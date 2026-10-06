import * as ffi from 'ffi'
import * as os from 'os'
import * as std from 'std'
import * as win from 'win'
import '../text-codec.js'
import { type C_BasicType, C_BasicType_No_Void, C_BasicType_Token, C_BasicType_Token_No_Void, cTokenToType, isCPtrToken, JsTypeOfToken, normToken, type Norm, NullablePtr, PTR_SIZE, ptrName, type Ptr, readScalar, TokenArgJsTypeMap, TokenReturnJsTypeMap, writeSlot } from './ctype.js'

// 形状刻意是「方法」而非裸函数：ffi-struct 的 struct()/union() 结果（StructDef）
// 结构上即满足 encode(v, buf?, offset?) -> ArrayBuffer，用户布局可直接透传。
// Codec 三件全可选（可只入参 / 只出参）：encode JS→native 序列化、decode 读回 JS 值、
// alloc 出参预分配（分配描述符 T 由各 codec 自定——内建收元素数/字节数）。
// decode 双态单参：native 品牌指针（返回位分派 / bufferPtr）逐字节读、调用方持有的
// ArrayBuffer 直读。刻意没有 offset——out 参数恒从 buffer 起点读，嵌套偏移由布局
// 字段（doDecode 的 base）承担，顶层再收 offset 只会掩盖"读错位置"这类错误。
// alloc 统一返回 { buf, ptr }：buf 喂 decode 直读，ptr 带品牌直接喂 <N>ptr 形参。
type Codec<N extends string = string, V = unknown, T = unknown> = {
    encode?(v: V, buf?: ArrayBuffer, offset?: number): ArrayBuffer
    decode?(p: Ptr<N>| ArrayBuffer): V
    alloc?(a: T): { buf: ArrayBuffer; ptr: Ptr<N> }
}
// 约束层三件与 StructDef 形状一致，def 可整体透传；提取层按键存在性走（见下）。
export type CodecMap = Record<string, {
    encode?(v: any, buf?: ArrayBuffer, offset?: number): ArrayBuffer
    decode?(p: any): any
    alloc?(a: any): { buf: ArrayBuffer; ptr: Ptr<any> }
}>

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

function makeFn(proc: number, sig: string, encoders: CodecMap, decoders: CodecMap): (...a: unknown[]) => unknown {
    const { argTokens, retToken } = parseSig(sig)
    return (...a: unknown[]) => callPacked(proc, argTokens, retToken, a, encoders, decoders)
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

function callPacked(proc: number, argTokens: C_BasicType_Token_No_Void[], retToken: C_BasicType_Token, args: any[], encoders: CodecMap, decoders: CodecMap): unknown {
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
                const codec = encoders[name]
                if (!codec) {
                    // undefined / 未知布局落到这：指针只收 null 或有效地址，不静默当 0。
                    throw new Error(name === ''
                        ? `ffi-bind: <>ptr expects number|null, got ${typeof arg}; use <BYTE>ptr to pass an ArrayBuffer, or ffi.bufferPtr(buf)`
                        : `ffi-bind: unknown layout "<${name}>ptr" (available: ${Object.keys(encoders).join(', ') || 'none'})`)
                }
                if (!codec.encode) {
                    // codec 存在但只声明了 decode/alloc（只读出），入参位无序列化可用。
                    throw new Error(`ffi-bind: <${name}>ptr has no encoder (out-only codec)`)
                }
                const buf = codec.encode(arg)
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
    const raw = readRet(cTokenToType(retToken), retBuf)
    // 返回位自动解码：非空品牌指针且该键声明了 decode → 交还 JS 值；
    // NULL 恒原样 null（无可读内容），裸 <>ptr / 无 decode 的键原样返回。
    if (raw !== null && isCPtrToken(retToken)) {
        const name = ptrName(retToken)
        if (name !== '') {
            const codec = decoders[name]
            if (codec?.decode) return codec.decode(raw)
        }
    }
    return raw
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

// 按键存在性提取 codec 值域（方法全可选后，`extends Encoder<infer V>` 会整体塌 never）。
type EncodeValue<T> = 'encode' extends keyof T
    ? (T extends { encode?: (v: infer V, ...r: any[]) => ArrayBuffer } ? V : never)
    : never
type DecodeValue<T> = 'decode' extends keyof T
    ? (T extends { decode?: (p: any, ...r: any[]) => infer V } ? V : never)
    : never

// 入参布局表：用户 codec 解包成 JS 形，并注入两个内建 codec 的值域，
// 使 <BYTE>ptr / <WCHAR>ptr 形参在类型层拿到 ArrayBuffer / string。
type BindEncoders<M> = {
    [K in keyof M]: EncodeValue<M[K]>
} & {
    WCHAR: string;
    BYTE: ArrayBuffer;
}
// 返回位布局表：只含 decode 值域。内建 WCHAR 注入与运行时（builtinCodecs.WCHAR
// 无条件合并进 decoders）对齐——<WCHAR>ptr 返回直接拿 string；BYTE 无 decode，
// 不注入，返回保持 Ptr<'BYTE'> | null。
type BindDecoders<M> = { [K in keyof M]: DecodeValue<M[K]> } & { WCHAR: string }

// 返回位 token → JS 类型：该键有 decode → V | null（品牌指针被解码结果替换，
// 可直接访问字段）；否则 Ptr<N> | null。入参路径不动（仍是 Ptr | V | null 并集）。
type RetOfToken<K extends string, M, D> = Norm<K> extends infer S ?
    S extends `<${infer N}>ptr`
        ? (D[N & keyof D] extends never ? NullablePtr<N> : D[N & keyof D] | null)
        : M[S & keyof M] extends never ? unknown : M[S & keyof M]
    : never

type BindFn<S extends string, E, D> =
    S extends `${infer ArgStr} -> ${infer RetStr}` ? ((...args: ParseArgStr<ArgStr, E>) => RetOfToken<RetStr, TokenReturnJsTypeMap, D>) : never

// 内建 codec：类型校验放在这里，与「用户布局 codec」同一分派点。
// BYTE/WCHAR 拒绝裸 number（无句柄可 pin），提示改用 <>ptr。
/** 内建 UTF-16 编解码：encode 入参序列化（UTF-16LE + NUL）；decode 双态单参——
 *  品牌指针逐字节读到 NUL（野指针无终止 4MiB 上限 fail-fast）、ArrayBuffer 直读到
 *  NUL 或末尾（out 参数未写 NUL 时按读满处理）；alloc 出参预分配返回 { buf, ptr }
 *  （a = 字符数，缺省 256；ptr 带 <WCHAR> 品牌直接喂形参）。类型取必需形态——
 *  内建三件齐备，调用无需空断言。 */
export const WCHAR: Required<Codec<'WCHAR', string, number>> = {
    encode: (v: string) => {
        return new TextEncoder('utf-16le').encode(v + '\0').buffer
    },
    decode: (p) => {
        // 两分支同构（UTF-16LE code unit、拼接到 NUL 止），唯一差异是读法。
        if (typeof p === 'number') {
            let s = ''
            let addr: number = p
            const start = addr
            for (;;) {
                const lo = ffi.readByte(addr)
                const hi = ffi.readByte(addr + 1)
                if (lo === 0 && hi === 0) return s
                s += String.fromCharCode(lo | (hi << 8))
                addr += 2
                if (addr - start > 1 << 21) {
                    throw new Error('ffi-bind: WCHAR decode exceeded 4MiB without NUL')
                }
            }
        }
        const u8 = new Uint8Array(p)
        const limit = u8.length & ~1   // 奇数末尾的残半字节丢弃
        let s = ''
        for (let i = 0; i < limit; i += 2) {
            const c = u8[i]! | (u8[i + 1]! << 8)
            if (c === 0) return s
            s += String.fromCharCode(c)
        }
        return s
    },
    alloc: (size = 256) => {
        const buf = new ArrayBuffer(size * 2)
        return { buf, ptr: ffi.bufferPtr(buf) as Ptr<'WCHAR'> }
    },
}
/** 内建字节缓冲：encode identity 直通（调用方持有 buffer 原地存活）；alloc 出参预
 *  分配返回 { buf, ptr }（a = 字节数；ptr 带 <BYTE> 品牌直接喂形参）。无 decode——
 *  地址不携带长度（无终止符），读回用 buf 原地读（native 写回后 DataView 直接取）。 */
export const BYTE: Required<Pick<Codec<'BYTE', ArrayBuffer, number>, 'encode' | 'alloc'>> = {
    encode: (v) => {
        return v
    },
    alloc: (byteLen) => {
        const buf = new ArrayBuffer(byteLen)
        return { buf, ptr: ffi.bufferPtr(buf) as Ptr<'BYTE'> }
    },
}
// 运行时两张表是同一对象：参数位只调 .encode、返回位只调 .decode，互不干扰。
const builtinCodecs: CodecMap = { WCHAR, BYTE }
/** 绑定单个函数。encoders/decoders 是两张可选布局表（结构上是 Codec）：
 *  encoders 喂入参位（encode 值域 → 形参类型），decoders 喂返回位（decode 值域
 *  → 返回 V | null，替代 Ptr | null）。decoders 缺省时回退到 encoders——双向 codec
 *  只需传一次（与运行时 `decoders ?? encoders` 同构：都只在实参缺省时生效，
 *  显式传空对象不 fallback）。内建 WCHAR/BYTE 无条件参与两张表。 */
export function bind<const S extends string,
    const LE extends CodecMap = {},
    const LD extends CodecMap = LE>(
    dll: string, name: string, sig: S, encoders?: LE, decoders?: LD) {
    const proc = win.GetProcAddress(loadDll(dll), name)
    if (!proc) throw new Error(`ffi-bind: proc "${name}" not found in ${dll}`)
    const effDec = decoders ?? encoders
    return makeFn(proc, sig,
        { ...builtinCodecs, ...encoders },
        { ...builtinCodecs, ...(effDec ?? {}) }
    ) as unknown as BindFn<S, BindEncoders<LE>, BindDecoders<LD>>
}

/** 批量绑定（map = 函数名 → 签名串）。encoders/decoders 语义同 bind()。 */
export function bindLib<const M extends Record<string, string>,
    const LE extends CodecMap = {},
    const LD extends CodecMap = LE>(
    dll: string, map: M, encoders?: LE, decoders?: LD) {
    const out: Record<string, (...a: unknown[]) => unknown> = {}
    const h = loadDll(dll)
    const effDec = decoders ?? encoders
    const encTable = { ...builtinCodecs, ...encoders }
    const decTable = { ...builtinCodecs, ...(effDec ?? {}) }
    for (const [name, sig] of Object.entries(map)) {
        const proc = win.GetProcAddress(h, name)
        if (!proc) throw new Error(`ffi-bind: proc "${name}" not found in ${dll}`)
        out[name] = makeFn(proc, sig, encTable, decTable)
    }
    return out as { [K in keyof M]: BindFn<M[K], BindEncoders<LE>, BindDecoders<LD>> }
}

/* ---- 闭包（回调）：JS 函数 → 可传给 Win32 API 的函数指针 ---- */

// 泄漏警告：target = dispose 本体 —— 警告条件字面对齐「释放通道死亡」：
// `const {dispose} = closure(...)` 解构出的就是 target 本身，持有期间绝不触发；
// dispose 体内 unregister(dispose)（自引用 token），释放即撤销，之后丢弃不误报。
// 回调只打印、绝不自动 free：ptr 会被复制进任意 native API，JS 对象的可达性
// 推不出 native 是否还在用它，自动释放会把「泄漏」升级成「野指针崩溃」
// （wrapper 被 C 侧强引用，不 dispose 的代价只是滞留到进程结束）。
// heldValue 纯数据、不引用 target —— 若反向强持，target 永不可达，警告永不触发。
// 注意：触发时机依赖 QuickJS 的 GC→job 队列链路，未做强时序断言（best-effort
// 诊断 —— 即使不触发也只是退回静默泄漏，无任何负面后果）。
const leakRegistry: FinalizationRegistry<{ sig: string, ptr: number }> =
    new FinalizationRegistry((held) => {
        std.printf('[ffi] closure leaked (GCed without dispose): sig="%s" ptr=0x%x\n',
            held.sig, held.ptr)
    })

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
 *  参数上限：x64 至多 16 个、ia32 栈区至多 64 字节（C 桩定长捕获窗），超限抛错。
 *  返回 { ptr, dispose }：ptr 即函数指针（传给 API 的 ptr 参数）；dispose 注销
 *  并释放回调函数，幂等；闭包期间回调被强引用，不会被 GC 回收。
 *  注意：dispose 后 ptr 不得再被任何 native 方引用。
 *  从未 dispose 就丢弃通道（整个返回对象或解构出来的 dispose 均算）
 *  → 打印泄漏警告（只警告、不自动释放，见 leakRegistry）。 */
export function closure<S extends string>(sig: S, fn: BindFn<S, {}, {}>,
    opts?: { stdcall?: boolean }): { ptr: number; dispose(): void } {
    const { argTokens, retToken } = parseSig(sig)
    const argTypes = argTokens.map(cTokenToType)
    const retType = cTokenToType(retToken)
    const is64 = os.arch === 'x64'
    const stackCapture = argTypes.reduce((s, k) => s + IA32_ARG_SIZE[k], 0)
    // C 桩捕获窗定长（quickjs-ffi-closure.c：x64 栈区 96B=12 槽，第 5 参起在栈上，
    // 即至多 16 参；ia32 16×4B）——超限 dispatch 会读到捕获缓冲之外的垃圾，或
    // RangeError 被吞成返回 0，故创建期 fail-fast。扩容改 C 侧 buf 尺寸并同步放宽。
    if (is64 ? argTypes.length > 16 : stackCapture > 64) {
        throw new Error(`ffi-bind: closure signature exceeds capture window ` +
            `(${is64 ? 'max 16 params' : 'max 64 stack bytes'}): ${sig}`)
    }
    const argBytes = (opts?.stdcall === false || is64) ? 0 : stackCapture
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
    const dispose = (): void => {
        if (done) return
        done = true
        leakRegistry.unregister(dispose)    // 释放即撤销：之后通道死亡不再警告
        ffi.closureFree(ptr)
    }
    const ret = { ptr, dispose }
    leakRegistry.register(dispose, { sig, ptr })   // target = 通道本体（非 ret）
    return ret
}
