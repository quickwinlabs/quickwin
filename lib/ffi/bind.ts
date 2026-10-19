import * as ffi from 'ffi'
import * as os from 'os'
import * as std from 'std'
import '../text-codec.js'
import { type C_BasicType, C_BasicType_No_Void, C_BasicType_Token, C_BasicType_Token_No_Void, cTokenToType, isCPtrToken, isCValToken, valName, ArgJsTypeOfToken, RetJsTypeOfToken, normToken, PTR_SIZE, ptrName, type Ptr, readScalar, writeSlot, PtrArrayBuffer } from './ctype.js'

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

// 按值位（'<N>'）消费的布局形态：size（决定槽宽与「传值 / 按引用」分派）+
// encode(v, buf, offset)（写入任意 buffer 的既有偏移——argFrame 槽内写入、
// 16 对齐临时副本两条路径共用）。StructDef 结构上即满足，内建 WCHAR/BYTE 无 size。
type StructValCodec = {
    size: number
    encode(v: unknown, buf: ArrayBuffer, offset: number): unknown
}

// CodecMap 的值是结构形（size 只在 StructDef 上、不属 Codec 契约），统一走 unknown
// 二跳提取；存在性与 size 由 makeFn 绑定期校验。
function valCodec(name: string, encoders: CodecMap): StructValCodec | undefined {
    return encoders[name] as unknown as StructValCodec | undefined
}

const _dllCache: Map<string, ffi.HMODULE> = new Map()

function loadDll(dll: string): ffi.HMODULE {
    const cached = _dllCache.get(dll)
    if (cached !== undefined) return cached
    const loaded = ffi.LoadLibrary(dll)
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
    // 按值形 '<N>' 仅支持入参位：大结构返回需要隐藏指针/sret 级 ABI（本运行时的
    // retBuf 恒 8 字节，只支持标量/浮点/指针返回），绑定期 throw 而非静默降级。
    // 类型层对返回位的 '<N>' 不设专门分支（fallthrough），本 throw 是唯一防线。
    if (isCValToken(retToken))
        throw new Error(`ffi-bind: "${sig}": by-value struct at the return position ` +
            `(<${valName(retToken)}>) is not supported — argument positions only; ` +
            `pass a struct out through an out-param slot instead (<N>ptr + caller buffer)`)
    return {
        argTokens,
        retToken,
        sig,
    }
}

/** proc 是 GetProcAddress 拿到的函数地址（<FARPROC>ptr）：调用方已校验非空，故收窄后的
 *  Ptr 而非 MaybePtr；品牌只在绑定层内部走，落到 ffiCall 的 uintptr 槽（number）时脱落。 */
function makeFn(proc: Ptr<'FARPROC'>, sig: string, encoders: CodecMap, decoders: CodecMap): (...a: unknown[]) => unknown {
    const ps = parseSig(sig)
    // 按值位的能力校验前移到绑定期（模块加载即炸，不留到首个调用）：布局缺位 / 非结构
    // 布局（无 size）/ 退化 size 都是签名层面的错误，报错指向具体位与可用布局清单。
    for (const t of ps.argTokens) {
        if (!isCValToken(t)) continue
        const name = valName(t)
        const codec = valCodec(name, encoders)
        if (!codec || typeof codec.encode !== 'function')
            throw new Error(`ffi-bind: ${sig}: by-value position <${name}> has no registered layout ` +
                `(available: ${Object.keys(encoders).join(', ') || 'none'})`)
        if (typeof codec.size !== 'number' || codec.size < 1)
            throw new Error(`ffi-bind: ${sig}: by-value position <${name}> requires a struct ` +
                `layout with size >= 1 (got ${codec.size}; non-struct codecs expose no size)`)
    }
    const plan = buildPlan(ps, encoders, decoders)
    return (...a: unknown[]) => callPlan(proc, plan, a)
}

// 每个参数在 argFrame 里占的字节数。与 src/quickjs-ffi-type.h 的 qwin_ffi_arg_size[]
// 保持一致（ia32：≤4B 类型进 4 字节、更大的进 8 字节；x64：恒 8 字节槽）。
// 注意这是「槽宽」，不是类型的 sizeof——同一定义也用于返回槽。指针布局恒指针宽。
const IA32_ARG_SIZE: Record<C_BasicType_No_Void, number> = {
    u8: 4, i8: 4, u16: 4, i16: 4, u32: 4, i32: 4,
    u64: 8, i64: 8, f32: 4, f64: 8,
    ptr: PTR_SIZE,
}
// x64 桩无条件双读 slots[0..3]，故 argFrame 至少 4 个槽（32 字节）
const X64_MIN_SLOTS = 4
// os.arch 是编译期的进程指针宽度（见 worker.ts 同款说明），全程恒定：提到模块级，
// 别在每调路径上读属性。
const IS64 = os.arch === 'x64'
// 指针槽按二补位位模式写（读回的负值再回传时保真）：setBigUint64/setUint32 内部即
// ToBigUint64/ToUint32，负值自然取模成全 1；QuickJS 只收 BigInt，故 x64 仍需 BigInt(v)。
// 宽度分支在模块加载时就定死，call 期零判断。
const writePtr = PTR_SIZE === 8
    ? (dv: DataView, off: number, v: number): void => { dv.setBigUint64(off, BigInt(v), true) }
    : (dv: DataView, off: number, v: number): void => { dv.setUint32(off, v, true) }
// 返回槽读法：与 ctype.readScalar 的对应分支逐条等价，但按类型定型到闭包——readScalar
// 每次调用要走 token 字符串 switch，实测 ~0.5μs/call，是 0 参调用里最大的一笔。
// 指针位有符号读（对齐 C 版 JS_NewInt64）：-1 哨兵等负值保真。
const RET_READER: Record<C_BasicType_No_Void, (dv: DataView) => number | bigint> = {
    u8: dv => dv.getUint8(0),
    i8: dv => dv.getInt8(0),
    u16: dv => dv.getUint16(0, true),
    i16: dv => dv.getInt16(0, true),
    u32: dv => dv.getUint32(0, true),
    i32: dv => dv.getInt32(0, true),
    u64: dv => dv.getBigUint64(0, true),
    i64: dv => dv.getBigInt64(0, true),
    f32: dv => dv.getFloat32(0, true),
    f64: dv => dv.getFloat64(0, true),
    ptr: PTR_SIZE === 8 ? dv => Number(dv.getBigInt64(0, true)) : dv => dv.getInt32(0, true),
}

/** 返回槽：所有 bind 出来的函数共用一个 8 字节缓冲。不变量：两个桩都在 call **之后**
 *  才写 out，而 JS 在 ffiCall 返回后立刻由 RET_READER 读出——中间不得插入任何用户代码
 *  （decode 必须在 raw 取出之后）。故 native 期间的回调重入即使写了同一块缓冲，外层读到的
 *  仍是本层自己的返回值（每一层自己的桩写都是该层读到前的最后一次写）。 */
const RET_DV = new DataView(new ArrayBuffer(8))

/** 绑定期类型分派的结果：每调只做「取值 + 写槽（必要时先编码）」。返回需存活到本次
 *  调用结束的临时 buffer（codec 编码结果 / x64 按值引用副本），无则直接落到底（隐式 undefined）。
 *  dv 恒为覆盖整个 argFrame 的视图——写器要往帧里铺字节（按值 struct）就近取 dv.buffer。 */
type SlotWriter = (dv: DataView<ArrayBuffer>, arg: any) => ArrayBuffer | undefined

/** 一次 bind() 的固定调用计划。原先这些判定散在 callPacked 的每调路径上：getWidth/widthOf
 *  每调新建闭包、token 正则每调重跑、writeSlot 每参一个对象字面量 + switch、os.arch 每调读
 *  ——实测 ~19μs/call 的成本主要就在这里（对照 raw 直调地板 0.68μs）。 */
type CallPlan = {
    total: number
    slots: SlotWriter[]
    retIsFp: boolean
    read: () => unknown
    /** 参数帧：首调分配后复用（帧 = `dv.buffer`，长度恰为 total，C 侧 af_size 自动正确）。
     *  签名固定 ⇒ 每个槽写器每调写入的字节区间恒定，故首分配的零填充——0 参时补齐槽、
     *  u8/u16/u32 占的 8 字节槽高位、ia32 结构体的 ALIGN(size,4) 填充——永不被踩，
     *  无需逐调清零。两个桩都在进入 native 前就把帧拷走（x64 装载寄存器/栈、ia32 rep movsb），
     *  故 native 期间的回调重入覆盖帧也无害（但见 bind() 的 codec 契约，那道窗口不覆盖写槽期）。 */
    dv: DataView<ArrayBuffer> | null
}

// 标量/指针标量槽写器按 token 定型（bind 期分派完，call 期只剩一次 DataView 写）。
// 32 位槽不显式 `>>> 0` / `Number()`：setUint32 内部即 ToUint32/ToNumber，逐位等价。
function mkScalarWriter(tok: C_BasicType_No_Void, off: number): SlotWriter {
    switch (tok) {
        // 所有 ≤4 字节槽一次 setUint32：小整数按 int 提升写（i8 = -1 必须给 0xFFFFFFFF），
        // u32/i32 槽宽本就是 4 字节——ToUint32 取模让两种情形写法一致，合并成一档。
        case 'u8': case 'i8': case 'u16': case 'i16': case 'u32': case 'i32':
            return (dv, v) => { dv.setUint32(off, v, true) }
        case 'u64':
            return (dv, v) => { dv.setBigUint64(off, v, true) }
        case 'i64':
            return (dv, v) => { dv.setBigInt64(off, v, true) }
        case 'f32':
            return (dv, v) => { dv.setFloat32(off, v, true) }
        case 'f64':
            return (dv, v) => { dv.setFloat64(off, v, true) }
        // 指针标量槽只收 number（NULL 品牌零也是 number）：类型层已排除 null/undefined，
        // 这里不再运行时校验；带布局的 <N>ptr 走 mkPtrWriter，那边仍 fail-loud。
        case 'ptr':
            return (dv, v) => { writePtr(dv, off, v) }
    }
}

// 指针位写器：number（裸地址 / NULL 品牌零 / 品牌指针）直通不重编码，其余交 codec 编码。
// 布局存在性保持「懒校验」——未注册布局的 <NOPE>ptr 只在真正调用时 throw，bind 期不炸。
function mkPtrWriter(
    name: string, codec: CodecMap[string] | undefined, nonnull: boolean,
    sig: string, at: string, off: number, encoders: CodecMap,
): SlotWriter {
    const encode = codec?.encode
    return (dv, arg) => {
        if (typeof arg === 'number') {
            if (nonnull && arg === 0)
                throw new Error(`ffi-bind: ${sig}: ${at} <${name}>ptr! got 0 ` +
                    `(null pointer forbidden here; the token marks this position non-null)`)
            writePtr(dv, off, arg)
            return   // number（裸地址 / NULL / 品牌指针）直通，不进下面的 codec 分支
        }
        if (arg === null || arg === undefined) {
            // JS null/undefined 不是指针词汇（空位只写 NULL）——fail-loud，不静默当 0。
            throw new Error(`ffi-bind: <${name}>ptr got ${String(arg)}; ` +
                `pass the imported NULL constant for an empty pointer`)
        }
        if (!codec) {
            // 未知布局落到这：只收 NULL / 有效地址 / codec 值，不静默当 0。
            throw new Error(name === ''
                ? `ffi-bind: <>ptr expects number (NULL | Ptr), got ${typeof arg}; use <BYTE>ptr with a PtrArrayBuffer (new PtrArrayBuffer(n)), or ffi.bufferPtr(buf) for an address`
                : `ffi-bind: unknown layout "<${name}>ptr" (available: ${Object.keys(encoders).join(', ') || 'none'})`)
        }
        if (!encode)
            throw new Error(`ffi-bind: <${name}>ptr has no encoder (out-only codec)`)
        const buf = encode(arg) as PtrArrayBuffer<any>
        // 类型层已保证 encode 返回 PtrArrayBuffer；这里再 fail-loud 兜一层
        // （动态传入的无类型 codec 仍可能违反），然后直接取 .ptr——不再重算。
        const p = buf.ptr
        if (typeof p !== 'number')
            throw new Error('ffi-bind: codec.encode must return a PtrArrayBuffer, got plain ArrayBuffer')
        if (nonnull && p === 0)
            throw new Error(`ffi-bind: ${sig}: ${at} <${name}>ptr! encode produced 0 ` +
                `(null pointer forbidden here)`)
        writePtr(dv, off, p)
        return buf
    }
}

// 按值位写器：x64 尺寸 ∈{1,2,4,8} 按「同尺寸整数」落槽（字节在槽低位，callee 右对齐读；
// 帧首分配即零填充，槽高位无歧义——复用帧同样成立，写器每调写入的区间恒定），
// 其余尺寸按引用传 caller 分配的对齐临时副本；ia32 结构字节原样压栈（任意尺寸）。
// 布局与尺寸已由 makeFn 在 bind 期校验。
function mkValWriter(name: string, codec: StructValCodec, size: number, off: number): SlotWriter {
    const encode = codec.encode!
    const badArg = (arg: any): never => {
        throw new Error(`ffi-bind: <${name}> value position got ${String(arg)}; ` +
            `pass a struct object (use <${name}>ptr to pass a pointer)`)
    }
    if (!IS64 || (size <= 8 && (size & (size - 1)) === 0))
        // 帧由 dv 反查（SlotWriter 不再单传 frame）：若将来 argFrame 走池化子视图，
        // 这里要像 struct.ts 的字节访问那样补上 dv.byteOffset。
        return (dv, arg) => {
            if (arg === null || arg === undefined) badArg(arg)
            encode(arg, dv.buffer, off)
        }
    return (dv, arg) => {
        if (arg === null || arg === undefined) badArg(arg)
        // 16 字节对齐自算（不依赖分配器的对齐保证）；返回值让调用方 held 到最后
        const buf = new ArrayBuffer(size + 15)
        const base = ffi.bufferPtr(buf)
        const pad = (16 - (base % 16)) % 16
        encode(arg, buf, pad)
        writePtr(dv, off, base + pad)
        return buf
    }
}

// bind 期算一次：槽偏移/写器/返回读法全部固化，call 期只剩搬运。
function buildPlan(ps: ParsedSig, encoders: CodecMap, decoders: CodecMap): CallPlan {
    const { argTokens, retToken, sig } = ps
    const slots: SlotWriter[] = []
    let off = 0
    for (let i = 0; i < argTokens.length; i++) {
        const argToken = argTokens[i]!
        const at = 'arg#' + String(i + 1)
        if (isCPtrToken(argToken)) {
            // '!' 留在 token 尾缀上（运行时要执法的语义跟着 token 走，无独立 flag）
            const name = ptrName(argToken)   // '' = <>ptr 裸地址档
            slots.push(mkPtrWriter(name, encoders[name], argToken.endsWith('!'), sig, at, off, encoders))
            off += IS64 ? 8 : PTR_SIZE
            continue
        }
        if (isCValToken(argToken)) {
            const name = valName(argToken)
            // makeFn 已校验：布局存在、是结构（有 size）且 size >= 1
            const codec = valCodec(name, encoders)!
            const size = codec.size
            slots.push(mkValWriter(name, codec, size, off))
            // ia32 = ALIGN(size, 4)：结构字节原样压栈（libffi ffi.c 的 ia32 分支同规则）
            off += IS64 ? 8 : (size % 4 === 0 ? size : size + 4 - (size % 4))
            continue
        }
        slots.push(mkScalarWriter(argToken, off))
        off += IS64 ? 8 : IA32_ARG_SIZE[argToken]
    }
    // x64 头 4 槽恒被桩读取，帧不足 4 槽时补零到 32 字节
    const total = IS64 && argTokens.length < X64_MIN_SLOTS ? X64_MIN_SLOTS * 8 : off

    const ret = cTokenToType(retToken)   // 按值形返回已在 parseSig 拒掉
    const retIsFp = retToken === 'f32' || retToken === 'f64'
    // 返回位 '!' = 「C 保证非零」的作者担保，标错由这里当场 throw 兜底（显式崩溃而非静默流窜）
    const zeroMsg = retToken.endsWith('!')
        ? `ffi-bind: ${sig}: return ${retToken} got 0 (the token promises C never returns null here)`
        : null
    // 返回位自动解码：品牌指针且该键声明了 decode → 交还 JS 值；空指针 0 / 裸 <>ptr /
    // 无 decode 的键原样返回。
    let decode: ((raw: number) => unknown) | null = null
    if (isCPtrToken(retToken)) {
        const name = ptrName(retToken)
        const dec = name !== '' ? decoders[name]?.decode : undefined
        if (dec) decode = (raw: number) => dec(raw)
    }
    const read = ret === 'void'
        ? (): unknown => undefined
        : (): unknown => {
            // 返槽读法按类型定型（RET_READER），不再走 readScalar 的 token 字符串 switch
            const raw = RET_READER[ret](RET_DV)
            if (zeroMsg !== null && raw === 0) throw new Error(zeroMsg)
            if (decode !== null && raw !== 0) return decode(raw as number)
            return raw
        }

    return { total, slots, retIsFp, read, dv: null }
}

function callPlan(proc: Ptr<'FARPROC'>, plan: CallPlan, args: any[]): unknown {
    const slots = plan.slots
    const n = slots.length
    // 参数帧复用（见 CallPlan.dv）：首调分配，其后原样重用——写入区间恒定，无需清零。
    let dv = plan.dv
    if (dv === null) {
        dv = new DataView(new ArrayBuffer(plan.total))
        plan.dv = dv
    }
    // codec 编码缓冲要活到 read 之后（decode 可能顺着回传的指针读调用方缓冲）：靠这个
    // 局部变量存活，返回即不可达、交 GC 回收。原先恒分配空数组，无编码参数时这次省掉。
    let held: ArrayBuffer[] | null = null
    for (let i = 0; i < n; i++) {
        const h = slots[i]!(dv, args[i])
        if (h !== undefined) {
            if (held === null) held = [h]
            else held.push(h)
        }
    }
    ffi.ffiCall(proc, dv.buffer, RET_DV.buffer, plan.retIsFp ? 1 : 0)
    return plan.read()
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
 *  显式传空对象不 fallback）。内建 WCHAR/BYTE 无条件参与两张表。
 *
 *  codec 契约（参数帧复用的前提，调用方须遵守）：
 *   1. encode/decode 内不得回调任何已 bind 的函数。参数帧按签名只分配一次并逐调复用，
 *      回调重入发生在本层 ffiCall 之前，会把本层已写好的槽抹掉（静默错参）。
 *   2. encode(v, buf, off) 必须写满槽宽：少写会残留上一调的字节。
 *  输入校验/转码若需要调 Win32 API，请在调用 bind 出的函数**之前**做。 */
export function bind<const S extends string,
    const LE extends CodecMap = {},
    const LD extends CodecMap = LE>(
    dll: string, name: string, sig: S, encoders?: LE, decoders?: LD) {
    const proc = ffi.GetProcAddress(loadDll(dll), name)
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
        const proc = ffi.GetProcAddress(h, name)
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
// 异常通道只留给用户回调（C 桩捕获 wrapper 异常并清零，src/quickjs-ffi-closure.c）。
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
    // 按值位仅支持 bind 的入参方向：closure 的 C→JS 方向由 quickjs-ffi-closure-*.S
    // 按固定槽宽读参数（x64 固定 8 字节槽、ia32 IA32_ARG_SIZE 表），不区分「槽内是
    // 结构字节还是指向临时副本的指针」——该分派未实现，创建期 fail-fast。
    for (const t of argTokens)
        if (isCValToken(t))
            throw new Error(`ffi-bind: closure signature cannot take a by-value struct ` +
                `(<${valName(t)}>); by-value is bind-only — the C→JS direction has no ` +
                `struct slot decoding (pass a pointer and decode on the JS side)`)
    // 上方已拒 '<N>' 按值形：此处 tok 恒为标量/指针档（cTokenToType 对 val 形原样返回，
    // 但那条路径不可达——IA32_ARG_SIZE 索引与 dispatchClosure 只认标量档）。
    const argSpecs = argTokens.map(t => ({ tok: cTokenToType(t) as C_BasicType_No_Void, nonnull: t.endsWith('!') }))
    const retSpec = { tok: cTokenToType(retToken), nonnull: retToken.endsWith('!') }
    const is64 = os.arch === 'x64'
    const stackCapture = argSpecs.reduce((s, x) => s + IA32_ARG_SIZE[x.tok], 0)
    // C 桩捕获窗定长（src/quickjs-ffi-closure.c：x64 栈区 96B=12 槽，第 5 参起在栈上，
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
