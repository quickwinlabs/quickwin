import * as ffi from 'ffi'
import * as os from 'os'
import * as std from 'std'
import * as win from 'win'
import '../text-codec.js'
import { type C_BasicType, C_BasicType_No_Void, C_BasicType_Token, C_BasicType_Token_No_Void, cTokenToType, isCPtrToken, ArgJsTypeOfToken, RetJsTypeOfToken, normToken, PTR_SIZE, ptrName, type Ptr, readScalar, writeSlot, PtrArrayBuffer } from './ctype.js'

// 形状刻意是「方法」而非裸函数：ffi-struct 的 struct()/union() 结果（StructDef）
// 结构上即满足 encode 重载（无 buf 新建带品牌 .ptr 的 PtrArrayBuffer / 带 buf 写入既有
// buffer 返回其本身），用户布局可直接透传。
// Codec 三件全可选（可只入参 / 只出参）：encode JS→native 序列化、decode 读回 JS 值、
// alloc 出参预分配（分配描述符 T 由各 codec 自定——内建收元素数/字节数；StructDef 不提供
// alloc —— 其 encode() 无 buf 形态已覆盖零 buffer 分配，返回值自带 .ptr）。
// decode 双态单参：native 品牌指针（返回位分派 / bufferPtr）逐字节读、调用方持有的
// ArrayBuffer 直读。刻意没有 offset——out 参数恒从 buffer 起点读，嵌套偏移由布局
// 字段（doDecode 的 base）承担，顶层再收 offset 只会掩盖"读错位置"这类错误。
// 内建 WCHAR/BYTE 的 encode/alloc 一律返回 PtrArrayBuffer：既是 decode 的直读 buffer，
// .ptr 又带品牌直接喂 <N>ptr 形参——不再有 { buf, ptr } 结构包装。
type Codec<N extends string = string, V = unknown, T = unknown> = {
    // encode 顶层不收 offset（与 decode 对齐）：PAB 的 .ptr 恒指向起点，写入位置由
    // buf 自身表达；偏移写入（数组物化原语）由 StructDef.encode(v, buf, offset) 承担。
    encode?(v: V, buf?: PtrArrayBuffer<any>): PtrArrayBuffer<any>
    decode?(p: Ptr<N>| ArrayBuffer): V
    alloc?(a: T): PtrArrayBuffer<N>
}
// 约束层三件与 StructDef 形状一致，def 可整体透传；提取层按键存在性走（见下）。
// 类型层硬约束：encode/alloc 只返回 PtrArrayBuffer —— 裸 ArrayBuffer 出不了
// codec（callPacked 参数位统一取 .ptr，调用方拿到的也是 .ptr，.buf 词汇从 codec 出口消失）；
// NULL（0）是引擎层词汇（number 直通世界），不作为 codec 出口形态。
export type CodecMap = Record<string, {
    encode?(v: any, buf?: PtrArrayBuffer<any>): PtrArrayBuffer<any>
    decode?(p: any): any
    alloc?(a: any): PtrArrayBuffer<any>
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

// 解析后的签名：'!' 修饰留在 token 尾缀上（token 即契约——运行时要执法的语义跟着
// token 走，0 检查看尾缀即可，无独立 flag 可被解构丢失）；'@' 由 normToken 剥掉
// （纯类型层语义，运行时不校验）。签名原文留作错误上下文。互斥单修饰语法下合法
// token 的 '!' 修饰必以 '!' 结尾（品牌名里的 '!' 在 <>ptr 之前，不影响尾判）。
type ParsedSig = {
    argTokens: C_BasicType_Token_No_Void[]
    retToken: C_BasicType_Token
    sig: string
}

function parseSig(sig: string): ParsedSig {
    const parts = sig.split(' -> ')
    if (parts.length !== 2) {
        throw new Error(`ffi-bind: invalid signature "${sig}" (expected "arg1 arg2 -> ret")`)
    }
    // 零参数签名是 ' -> u32'，此时 parts[0]===''，split(' ') 会产出 ['']；
    // 空串必须先滤掉，否则 normToken('') 抛 Unknown token 整个 suite 崩。
    const rawArgs = parts[0]!.split(' ').filter(t => t !== '')
    const argTokens: C_BasicType_Token_No_Void[] = []
    for (const raw of rawArgs) {
        // '@Name' 枚举标注由 normToken 剥（槽宽/ABI 只看底档），名字合法性由类型层拦
        // （未知枚举塌 never）；结构侧的 '@'（键 alignas / 值 encoding）不走本路径——
        // bind 签名是 token 修饰的唯一入口。
        const tok = normToken(raw)
        if (tok === 'void') {
            throw new Error("Void can not in args")
        }
        argTokens.push(tok)
    }

    // 裸 'ptr'/非法 token 由类型层拦截（C_BasicType_Token 已 Exclude 'ptr'、拼错 token 塌成 never）；
    // 运行时再比较只会得到 TS2367「两类型无重叠」——类型已表达的约束不重复校验。
    const retToken = normToken(parts[1]!)
    return {
        argTokens,
        retToken,
        sig,
    }
}

function makeFn(proc: number, sig: string, encoders: CodecMap, decoders: CodecMap): (...a: unknown[]) => unknown {
    const ps = parseSig(sig)
    return (...a: unknown[]) => callPacked(proc, ps, a, encoders, decoders)
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

function callPacked(proc: number, { argTokens, retToken, sig }: ParsedSig, args: any[], encoders: CodecMap, decoders: CodecMap): unknown {
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
        const nonnull = argToken.endsWith('!')   // '!' 留在 token 尾缀上，此处按尾缀执法
        const arg = args[i]
        if (isCPtrToken(argToken)) {
            const name = ptrName(argToken)   // '' = <>ptr 裸地址档
            if (typeof arg === 'number') {
                // 裸地址 / NULL / 品牌指针（都是 number）透传，不重编码。
                // 合法值形态由类型层约束（MaybePtr | codec 形，如 <BYTE>ptr 另收 ArrayBuffer）。
                if (nonnull && arg === 0)
                    throw new Error(`ffi-bind: ${sig}: arg#${i + 1} <${name}>ptr! got 0 ` +
                        `(null pointer forbidden here; the token marks this position non-null)`)
                writeSlot(dv, off, { k: 'ptr', v: arg })
            } else {
                if (arg === null || arg === undefined) {
                    // JS null/undefined 不是指针词汇（空位只写 NULL）——fail-loud，不静默当 0。
                    throw new Error(`ffi-bind: <${name}>ptr got ${String(arg)}; ` +
                        `pass the imported NULL constant for an empty pointer`)
                }
                const codec = encoders[name]
                if (!codec) {
                    // 未知布局落到这：只收 NULL / 有效地址 / codec 值，不静默当 0。
                    throw new Error(name === ''
                        ? `ffi-bind: <>ptr expects number (NULL | Ptr), got ${typeof arg}; use <BYTE>ptr with a PtrArrayBuffer (new PtrArrayBuffer(n)), or ffi.bufferPtr(buf) for an address`
                        : `ffi-bind: unknown layout "<${name}>ptr" (available: ${Object.keys(encoders).join(', ') || 'none'})`)
                }
                if (!codec.encode) {
                    // codec 存在但只声明了 decode/alloc（只读出），入参位无序列化可用。
                    throw new Error(`ffi-bind: <${name}>ptr has no encoder (out-only codec)`)
                }
                const buf = codec.encode(arg)
                held.push(buf)
                // 类型层已保证 encode 返回 PtrArrayBuffer；这里再 fail-loud 兜一层
                // （动态传入的无类型 codec 仍可能违反），然后直接取 .ptr——不再重算。
                const p = (buf as PtrArrayBuffer<any>).ptr
                if (typeof p !== 'number')
                    throw new Error('ffi-bind: codec.encode must return a PtrArrayBuffer, got plain ArrayBuffer')
                if (nonnull && p === 0)
                    throw new Error(`ffi-bind: ${sig}: arg#${i + 1} <${name}>ptr! encode produced 0 ` +
                        `(null pointer forbidden here)`)
                writeSlot(dv, off, { k: 'ptr', v: p })
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
    // 返回位 '!' = 「C 保证非零」的作者担保，标错由这里当场 throw 兜底（显式崩溃而非静默流窜）。
    if (retToken.endsWith('!') && raw === 0)
        throw new Error(`ffi-bind: ${sig}: return ${retToken} got 0 ` +
            `(the token promises C never returns null here)`)
    // 返回位自动解码：品牌指针且该键声明了 decode → 交还 JS 值；
    // 空指针 0 恒原样返回（无可读内容，不进 decode），裸 <>ptr / 无 decode 的键原样返回。
    if (isCPtrToken(retToken) && raw !== 0) {
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
    ? ParseArgStr<R, L, [...Acc, ArgJsTypeOfToken<F, L>]>
    : S extends ''
    ? Acc : [...Acc, ArgJsTypeOfToken<S, L>]

// 按键存在性提取 codec 值域（方法全可选后，`extends Encoder<infer V>` 会整体塌 never）。
type EncodeValue<T> = 'encode' extends keyof T
    ? (T extends { encode?: (v: infer V, ...r: any[]) => ArrayBuffer } ? V : never)
    : never
type DecodeValue<T> = 'decode' extends keyof T
    ? (T extends { decode?: (p: any, ...r: any[]) => infer V } ? V : never)
    : never

// 入参布局表：用户 codec 解包成 JS 形，并注入两个内建 codec 的值域，
// 使 <BYTE>ptr / <WCHAR>ptr 形参在类型层拿到 PtrArrayBuffer / string。
// BYTE 用 PtrArrayBuffer<any> 收所有品牌：PAB<N> 因 .ptr 里的条件类型是不变型，
// 写 string/'' 都收不下 struct.encode 的具体品牌——any 双向通，形状（必须是 PAB）
// 才是硬约束，品牌本就由调用点自行声明。
type BindEncoders<M> = {
    [K in keyof M]: EncodeValue<M[K]>
} & {
    WCHAR: string;
    BYTE: PtrArrayBuffer<any>;
}
// 返回位布局表：只含 decode 值域。内建 WCHAR 注入与运行时（builtinCodecs.WCHAR
// 无条件合并进 decoders）对齐——<WCHAR>ptr 返回直接拿 string；BYTE 无 decode，
// 不注入，返回保持 MaybePtr<'BYTE'>（NULL | Ptr<'BYTE'>）。
type BindDecoders<M> = { [K in keyof M]: DecodeValue<M[K]> } & { WCHAR: string }

type BindFn<S extends string, E, D> =
    S extends `${infer ArgStr} -> ${infer RetStr}` ? ((...args: ParseArgStr<ArgStr, E>) => RetJsTypeOfToken<RetStr, D>) : never

// 内建 codec：类型校验放在这里，与「用户布局 codec」同一分派点。
// BYTE/WCHAR 拒绝裸 number（无句柄可 pin），提示改用 <>ptr。
/** 内建 UTF-16 编解码：encode 入参序列化（UTF-16LE + NUL）；decode 双态单参——
 *  品牌指针逐字节读到 NUL（野指针无终止 4MiB 上限 fail-fast）、ArrayBuffer 直读到
 *  NUL 或末尾（out 参数未写 NUL 时按读满处理）；alloc 预分配返回带 .ptr 的
 *  PtrArrayBuffer（a = 字符数，缺省 256）。类型取必需形态——
 *  内建三件齐备，调用无需空断言。刻意 Pick 而非 Required<Codec>：只声明消费的
 *  三件（encode/decode/alloc），新增可选能力位不被拉成必填。 */
export const WCHAR: Required<Pick<Codec<'WCHAR', string, number>, 'encode' | 'decode' | 'alloc'>> = {
    encode: (v: string) => {
        // TextEncoder 没有 encodeInto：先编码再拷入带 .ptr 的 buffer（单次 memcpy，
        // 编码逻辑仍全局唯一——这行是全部 UTF-16 字符串编码的唯一实现）。
        const u8 = new TextEncoder('utf-16le').encode(v + '\0')
        const out = new PtrArrayBuffer<'WCHAR'>(u8.byteLength)
        new Uint8Array(out).set(u8)
        return out
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
    alloc: (size = 256) => new PtrArrayBuffer<'WCHAR'>(size * 2),
}
/** 内建字节缓冲：encode identity 直通（收 PtrArrayBuffer、原地存活，native 写回同一
 *  buffer）；alloc 预分配返回带 .ptr 的 PtrArrayBuffer（a = 字节数）。无 decode——
 *  地址不携带长度（无终止符），读回直接在 buffer 上 DataView / TypedArray 取。 */
export const BYTE: Required<Pick<Codec<'BYTE', PtrArrayBuffer<any>, number>, 'encode' | 'alloc'>> = {
    encode: (v) => {
        // identity 原地直通（native 写回同一 buffer），不能拷贝——只收自带 .ptr 的
        // PtrArrayBuffer；普通 ArrayBuffer 过来 fail-loud，先包一层 new PtrArrayBuffer(n)。
        if (!(v instanceof PtrArrayBuffer))
            throw new Error('ffi-bind: <BYTE>ptr wants a PtrArrayBuffer (new PtrArrayBuffer(n) / BYTE.alloc / struct.encode), not a plain ArrayBuffer')
        return v
    },
    alloc: (byteLen) => new PtrArrayBuffer<'BYTE'>(byteLen),
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
// args/ret 为「底档 + '!' 绑定」的记录（与 ParsedSig 同形态——修饰随 token 走，
// 消费者要么整体拿到、要么整体拿不到）。'!' 违约（C 传入 0 / fn 返回 0）打印诊断并
// 中止本次分发（fn 不被调用 / 结果槽保持 0），与 fn-throw 同风格：此处不 throw，
// 异常通道只留给用户回调（C 桩捕获 wrapper 异常并清零，quickjs-ffi-closure.c）。
function dispatchClosure(
    args: { tok: C_BasicType_No_Void, nonnull: boolean }[],
    ret: { tok: C_BasicType, nonnull: boolean },
    fn: (...a: unknown[]) => unknown,
    frameBuf: ArrayBuffer, retBuf: ArrayBuffer, sig: string): void {
    const dv = new DataView(retBuf)
    const is64 = os.arch === 'x64'
    const fv = new DataView(frameBuf)
    const a: unknown[] = []
    let off = 0
    for (let i = 0; i < args.length; i++) {
        const spec = args[i]!
        const k = spec.tok
        let v: unknown
        if (is64) {
            const fp = k === 'f32' || k === 'f64'
            const base = fp
                ? (i < 4 ? 128 + i * 8 : 32 + (i - 4) * 8)   // xmm 区（前 4）/ 溢出区
                : (i < 4 ? i * 8 : 32 + (i - 4) * 8)          // 整数寄存器区 / 溢出区
            v = readScalar(fv, base, k)
        } else {
            v = readScalar(fv, off, k)
            off += IA32_ARG_SIZE[k]
        }
        // 参数位 '!' = 「C 保证非空」的作者担保，C 传 0 即标错 → 跳过回调。
        if (spec.nonnull && v === 0) {
            std.printf('[ffi] closure %s: arg#%d got 0 (! promise violated by caller), skipping callback\n', sig, i + 1)
            return
        }
        a.push(v)
    }
    let r: any
    try {
        r = fn(...a)
    } catch (err) {
        std.printf('[ffi] closure callback threw: %s\n', String(err))
        return                            // 结果槽保持 0
    }
    // 返回位 '!' = 「JS 保证非零」的作者担保，fn 返回 0 即标错 → 不写结果槽。
    if (ret.nonnull && r === 0) {
        std.printf('[ffi] closure %s: return got 0 (! promise violated by callback), leaving result slot 0\n', sig)
        return
    }
    if (ret.tok !== 'void') {
        writeSlot(dv, 0, { k: ret.tok, v: r })
    }
}

/** 把 JS 函数变成可传给 Win32 API 的函数指针（同步同线程回调）。
 *  sig 为回调签名：实参只许 BasicKind（ptr 槽 0 保真读回 NULL | Ptr），
 *  返回只许 void|u8..u64|i8..i64|f32|f64|ptr（u64/i64 走 EDX:EAX，x64 走 RAX）。
 *  '!' 标记位运行时校验（与 bind 调用位同语义，见 dispatchClosure）：参数位 C 传入 0
 *  → 打印诊断并跳过回调；返回位 fn 返回 0 → 保持结果槽 0。
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
    const argSpecs = argTokens.map(t => ({ tok: cTokenToType(t), nonnull: t.endsWith('!') }))
    const retSpec = { tok: cTokenToType(retToken), nonnull: retToken.endsWith('!') }
    const is64 = os.arch === 'x64'
    const stackCapture = argSpecs.reduce((s, x) => s + IA32_ARG_SIZE[x.tok], 0)
    // C 桩捕获窗定长（quickjs-ffi-closure.c：x64 栈区 96B=12 槽，第 5 参起在栈上，
    // 即至多 16 参；ia32 16×4B）——超限 dispatch 会读到捕获缓冲之外的垃圾，或
    // RangeError 被吞成返回 0，故创建期 fail-fast。扩容改 C 侧 buf 尺寸并同步放宽。
    if (is64 ? argSpecs.length > 16 : stackCapture > 64) {
        throw new Error(`ffi-bind: closure signature exceeds capture window ` +
            `(${is64 ? 'max 16 params' : 'max 64 stack bytes'}): ${sig}`)
    }
    const argBytes = (opts?.stdcall === false || is64) ? 0 : stackCapture
    const retKind = retSpec.tok === 'f32' ? 1
        : retSpec.tok === 'f64' ? 2
            : (retSpec.tok === 'u64' || retSpec.tok === 'i64') ? 3
                : 0
    // per-closure wrapper：闭包捕获 argSpecs/retSpec/fn/sig，C 侧只存它 + ctx；回调
    // 永远回到创建它的 context（无跨 context 全局、无 registry）。
    const wrapper = (frameBuf: ArrayBuffer, retBuf: ArrayBuffer): void => {
        dispatchClosure(argSpecs, retSpec, fn as (...a: unknown[]) => unknown, frameBuf, retBuf, sig)
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
