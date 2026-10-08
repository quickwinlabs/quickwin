import { bufferPtr } from 'ffi'
import * as os from 'os'

// ============================================================
// 语法词汇 —— struct/bind 共用的 C 类型描述。标量直接写规范 token 字符串（'i32'/'u32'），
// 指针写 '<>ptr'（裸地址）或 '<NAME>ptr'（带名）；对象值一律带 '#' 声明键（见 §4）。
// 只描述「C 声明怎么写」（unit/length/encoding 等意图）；内存布局与读写视图由
// struct.ts 的 computeStructLayout/lower 单独 lower 成 layout IR。
//
// 叶子模块：刻意不依赖 win/std/text-codec，可被 struct 直接引用，
// 避免「只用 struct」的调用方被动加载整个 bind 运行时。
// 四段按依赖序：§1 kind 词汇表 → §2 指针布局与品牌 → §3 token 词表与白名单（normToken） → §4 值词汇。
// ============================================================

// ============================================================
// §1 kind 词汇表 —— C_BASIC_TYPE 是唯一手写清单，下列集合全从它派生
//   C_BasicType(12)  bind 签名 token / lower 后 IR 共用
//   C_Number(10)    结构体字段的数字档
//   C_Integer(8)    C_Number 去浮点 —— 位域存储单元只能是整数档
//   Token(11+指针)  C_BasicType_Token / Arg·Ret JsTypeOfToken 的操作面（见 §3）
// 排除项：'void' 无大小；裸 'ptr' 用户面禁写（须写 '<>ptr'），内部保留 ——
// 唯一随架构变宽的标量档。lower 后所有指针归一为 kind 'ptr'，名字被擦掉。
// ============================================================
const C_BASIC_TYPE = [
    'void', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32',
    'u64', 'i64', 'f32', 'f64', 'ptr',
] as const

export type C_BasicType = (typeof C_BASIC_TYPE)[number]
export type C_BasicType_No_Void = Exclude<C_BasicType, 'void'>

// '!' 形随 token 走（normToken 只剥运行时不理解的 '@'，运行时要执法的 '!' 保留——
// token 即契约，callPacked/closure 按尾缀做 0 检查，无独立 flag 可丢）。
export type C_BasicType_Token = Exclude<C_BasicType, 'ptr'> | `<${string}>ptr` | `<${string}>ptr!`
export type C_BasicType_Token_No_Void = Exclude<C_BasicType_Token, 'void'>

// 尾缀修饰：'!' = 非空担保（见 Arg/RetJsTypeOfToken 的 ! 分支与 callPacked 的运行时 0 检查），
// '@Name' = 枚举值域标注（类型层启用前先由 Norm 归一剥掉）。两者语义正交但作用面不相交
// （! 主品牌位、@ 主裸档整数位，@ 枚举不含 0 时已蕴含 !），故每 token 至多一个修饰。
// 组 1 恒为名字（归一名），组 2 为修饰；槽宽/ABI 只看归一形式。
const PTR_TOKEN_RE = /^<([^<>\s]*)>ptr(!|@[A-Za-z_]\w*)?$/

export function isCPtrToken(t: string): t is `<${string}>ptr` | `${string}ptr!` | `${string}ptr@${string}` { return PTR_TOKEN_RE.test(t) }
export function ptrName<const N extends string>(t: `<${N}>ptr` | `<${N}>ptr!`): N {
    const m = PTR_TOKEN_RE.exec(t)
    return (m?.[1] || "") as N
}
/**
 * @description `<${string}>ptr` / `<${string}>ptr!` -> 'ptr'
 */
export const cTokenToType = <const T extends string>(t: T): Exclude<T, `<${string}>ptr` | `<${string}>ptr!`> | 'ptr' => {
    if (isCPtrToken(t)) return 'ptr'
    else return t as Exclude<T, `<${string}>ptr` | `<${string}>ptr!`>
}

// C 的数字类型档：可作结构体字段 / bind 签名 token。排除项理由见 §1。
export type C_Number = Exclude<C_BasicType, 'void' | 'ptr'>

// 整数档：位域存储单元的合法类型（C 位域只能用整型）。
export type C_Integer = Exclude<C_Number, 'f32' | 'f64'>

export type Encoding = 'utf-8' | 'utf-16le'

type First =
    | '_' | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm'
    | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z'
    | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M'
    | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z';

// ============================================================
// §4 值词汇（SimpleValue）—— 字段值/数组元素的全部合法形态：
//   token        'u32'（规范 token 词汇；'void'/裸 'ptr'/拼错 token 运行时拒绝 —— typedef 别名已移除）
//   数组糖       'u32[4]'（仅 token 元素 —— 更复杂的元素写 '#' array 声明）
//   位域糖       'u32:3'（unit 位归一后须为整数档）
//   字符串糖     'u16[128]@utf-16le'（布局 unit[length] × 解释 @encoding 正交：
//                size = typesize × length 由 unit/length 决定，encoding 只管怎么读写
//                这些字节 —— 错配如 'u8[128]@utf-16le' 也语义自洽。与键侧 alignas 同
//                用 '@' 但位置不同（键名尾 vs 值串尾），解析互不干扰。string 是唯一
//                没有 '#' 声明形式的值 —— 糖与 C_String 三元组双射，一种概念一种写法）
//   '#' 声明     struct/union（平铺字段 + '#pack'）、array（element+length）——
//                对象值的唯一判别键是 '#'（多字段/聚合元素无法用糖表达，故保留）
// '#' 必填（无「裸嵌套 map 默认 struct」）：漏写 '#' 时 union 不会静默翻转成 struct，
// 类型层直接报错、运行时 throw。顶层 struct()/union() 例外 —— kind 由函数名表明，
// 参数是平铺字段表（不含 '#'），'#'/`#pack` 由构造器写入 __struct。
// ============================================================

// token 值面：规范 token（C_Number 档）∪ 指针形（含 '!' 非空尾缀）∪ '@枚举标注形'
// （枚举名限 keyof EnumMap —— 未知枚举名在定义点就 ∉ SimpleValue 被拒，与拼错 token
// 同一道闸）。'void' 除外 —— 无大小，不能作字段值。
export type SimpleToken =
    | C_Number
    | `${C_Number}@${keyof EnumMap}`
    | `<${string}>ptr`
    | `${string}ptr!`
    | `<${string}>ptr@${keyof EnumMap}`

// 平铺字段表：struct()/union() 参数与 '#' 声明的字段部分（声明类型见下方 C_Struct/C_Union）。
// 键侧词汇：'k@N' = alignas N（键尾 @+数字，字段名不含 '@'）；'$x' = 匿名槽（只收聚合）。
// '#' 前缀键是指令位，与字段名（First 不含 '#'）天然无撞名。
export type SimpleMember = {
    [K: `${First}${string}`]: SimpleValue
    [K: `$${string}`]: C_Struct | C_Union
}

// 用 interface（而非 `{'#': ...} & SimpleMember` 交叉别名）：交叉 + 循环别名（SimpleMember
// ↔ SimpleValue ↔ 本类型）在展开时有解析顺序陷阱 —— 实测 C_Union 拿到的 SimpleMember
// 丢失索引签名（`'a' extends keyof C_Union` = false，字段字面量被 excess check 拒绝），
// 而 interface 成员惰性求值无此问题。索引签名与 SimpleMember 逐字同源，改一处须同步另一处。
export interface C_Struct {
    '#': 'struct'
    '#pack'?: number
    [K: `${First}${string}`]: SimpleValue
    [K: `$${string}`]: C_Struct | C_Union
}
export interface C_Union {
    '#': 'union'
    '#pack'?: number
    [K: `${First}${string}`]: SimpleValue
    [K: `$${string}`]: C_Struct | C_Union
}
export type C_Array = { '#': 'array', element: SimpleValue, length: number }

export type SimpleValue =
    | SimpleToken
    | `${SimpleToken}[${number}]`
    | `${C_Number}:${number}`   // 位域糖：仅裸数字档（'@'/'!'/'<T>ptr' 尾缀在位域位词汇拒）
    | `${'u8' | 'u16'}[${number}]@${Encoding}`   // 字符串糖（unit/length 布局 + encoding 解释）
    | C_Struct | C_Union | C_Array


export const PTR_SIZE = os.arch === 'x64' ? 8 : 4

export const SizeAlign: Record<C_Number, number> = {
    u8: 1, i8: 1,
    u16: 2, i16: 2,
    u32: 4, i32: 4,
    u64: 8, i64: 8,
    f32: 4, f64: 8,
}

// brand 属性用普通字符串键（phantom——运行时就是裸 number，属性不存在）：结构等价使
// quickwin.d.ts 的 gui.HWND 能直接书写 `number & { readonly ptrBrand: "HWND" }`，
// 与 Ptr<"HWND"> 双向可赋值、d.ts 零依赖 ctype；unique symbol 按声明位置定身份，
// 反而使跨包的重复副本互不兼容。同构碰撞的防线由 `number &` 交叉保证（裸 number
// 缺属性、纯对象缺 number，构造源只有 Ptr 本身或故意手写）。
// `''` 判在左侧（右侧实例化，不作 naked 分布）：T=never 不再塌缩成 never（否则
// `Ptr<never>` 不可构造，decode(… | Ptr<N>) 在 N=never 时直接堵死），含 '' 的并集
// 不再拆分，宽 string 归一裸 number。字面品牌照旧走交叉 brand 分支。
// 空品牌塌缩成 number 是有意设计：FFI 的 `<>ptr` 是 uintptr 双态位（WPARAM/LPARAM/
// void*/LONG_PTR 在 C ABI 里既收地址又收整数），品牌化会把 sel、max、算术值这类
// 合法实参拦成伪错误——裸档误用靠 NULL 迁移后的调用点纪律兜底，不做 tsc 强制。
export type Ptr<T extends string> =
    '' extends T ? number : number & { readonly ptrBrand: T }

/** NULL 品牌零：0 的品牌形态 —— 全 FFI 层唯一的空指针字面量（对应 C 的 NULL 宏，
 *  运行时就是 0）。JS 的 null 不在指针值域：类型层禁收，运行时不做 null→0 转换
 *  （动态 null 在参数槽 / 写槽处 fail-loud 报错）。 */
export type NULL = 0 & { readonly ptrBrand: 'NULL' }
export const NULL = 0 as NULL

/** 唯一指针类型：参数位 / 返回位 / struct 字段 / closure 双侧通用。
 *  C→JS 0 保真（readScalar 不做 0→null）；JS→C 空位写 NULL（写槽即 0）。
 *  传参前由 tsc 收窄掉空位（truthy / === NULL / === 0）。 */
export type MaybePtr<T extends string> =
    NULL | Ptr<T>

// 用户 token 词表 → JS 类型。刻意不含 'ptr'：用户面禁写裸 ptr，Arg/Ret 的
// `K & keyof` 索引到 never 自塌拒绝；IR 层 kind 含 'ptr' 的消费者（Entry）
// 自行 `& { ptr: number }` 增量。
export type C_TypeJsTypeMap = {
    u8: number; i8: number; u16: number; i16: number
    u32: number; i32: number; i64: bigint, u64: bigint
    f32: number; f64: number
}

export type TokenArgJsTypeMap = C_TypeJsTypeMap
export type TokenReturnJsTypeMap = C_TypeJsTypeMap & { void: void }

/** token 枚举标注（'u32@Name' / '<>ptr@Name'）的值域表 —— 全局 interface 声明合并：
 *  预填由 tools/gen_enum_map.sh 从 quickwin_const.d.ts 提取（quickwin_enum_map.d.ts），
 *  用户在自己的 .d.ts 里直接扩展（interface EnumMap { MyEnum: import('...').MyEnum }）——
 *  勿用 declare module：用户 import specifier 形态五花八门，模块匹配不上；全局合并对
 *  「按枚举名索引」的 token 语义才成立。消费点（bind Arg/Ret、struct 字段）统一以
 *  `infer E extends keyof EnumMap` 收紧后直接索引本表 —— 值域类型不分参数/返回语境
 *  （拦异种枚举、域外字面量靠枚举类型自身的 nominal）；未知枚举名由词汇/分支约束
 *  挡在外面：struct 定义点 ∉ SimpleValue，bind 签名落链末 map[never] 塌 never
 *  （参数位）/ unknown（返回位——never 是 bottom 会被任意使用放行，反而危险）。 */
declare global {
    // 预填见 quickwin_enum_map.d.ts；此处空声明兜底（预填文件缺省时引用处仍可解析）。
    interface EnumMap { }
}

// token → JS 类型（实参语境）。L = 布局名→JS 形；M/D 已固化（TokenArgJsTypeMap /
// never —— 'void'/裸 'ptr'/拼错 token 经 map[K & keyof] 塌 never，参数位调用点全红
// fail-loud）。分支链：'!' 在链首（非空担保 → Ptr<N> 排 NULL，带布局形照收）；
// '@E' 枚举值域（模式用 `infer E extends keyof EnumMap` 收紧：未知枚举名分支失配、
// 落链末 map[never] —— 与 struct 侧词汇定义点拒绝构成双层防线；nominal：拦异种枚举、
// 拦裸 0/NULL；单值位标注，flags 组合位不标；不并 layout 形 —— codec 入参编码成
// 地址必然落在枚举域外，留着就是绕过值域承诺的无检查后门）；裸 ptr 形收
// MaybePtr | L[N]。'u32!'/'DWORD' 等不匹配任何已知形 → map[never] 塌 never
// （非法形态宁可全红也不放行）。泛型未解析位（K = string —— closure/bindLib
// 泛型体内）由 `string & keyof map` = 全键联合兜底成非 never —— 否则 BindFn 塌
// (never)=>never 使内层强转失去可比性。
export type ArgJsTypeOfToken<K extends string, L> =
    K extends `<${infer N}>ptr!` ? Ptr<N> | L[N & keyof L] :
    K extends `<${string}>ptr@${infer E extends keyof EnumMap}` ? EnumMap[E] :
    K extends `<${infer N}>ptr` ? MaybePtr<N> | L[N & keyof L] :
    K extends `${C_Number}@${infer E extends keyof EnumMap}` ? EnumMap[E] :
    TokenArgJsTypeMap[K & keyof TokenArgJsTypeMap] extends never ? never
    : TokenArgJsTypeMap[K & keyof TokenArgJsTypeMap]

// token → JS 类型（返回语境）。D = 返回位布局表 decode 值域：该键有 decode →
// D[N] | NULL（解码结果替换地址，空指针 0 保真为 NULL）；否则 MaybePtr<N>，
// 与实参位同型（空品牌 <''> 归一裸 number，联合坍缩）。'!' 分支 = 「C 保证非零」
// 的作者担保：去掉 NULL 分支（有 decode → D[N]，无 decode → Ptr<N>），运行时返回
// 0 当场 throw 兜底标错；'@E' 分支 = 担保返回值在枚举值域（标错同担，值域校验按需
// Phase 2）。非法 token（'i3z'/裸 'ptr'）经 map[never] 塌 unknown —— 返回位刻意不是
// never：never 是 bottom 会被任意使用全放行，unknown 逼调用方显式收窄（与参数位
// never 拦调用的不对称是设计）。
export type RetJsTypeOfToken<K extends string, D> =
    K extends `<${infer N}>ptr!`
        ? (D[N & keyof D] extends never ? Ptr<N> : D[N & keyof D])
        : K extends `<${string}>ptr@${infer E extends keyof EnumMap}`
        ? EnumMap[E]
        : K extends `<${infer N}>ptr`
        ? (D[N & keyof D] extends never ? MaybePtr<N> : D[N & keyof D] | NULL)
        : K extends `${C_Number}@${infer E extends keyof EnumMap}`
        ? EnumMap[E]
        : TokenReturnJsTypeMap[K & keyof TokenReturnJsTypeMap] extends never ? unknown
        : TokenReturnJsTypeMap[K & keyof TokenReturnJsTypeMap]

// token 归一：只收规范 token（C_BASIC_TYPE 去 'ptr' = C_Number ∪ 'void'，由 §1 唯一手写
// 清单派生）与指针形；拼错 token、已移除的 typedef 别名（'DWORD'/'HANDLE'）一律 fail-loud。
export function normToken(t: string): C_BasicType_Token {
    if (isCPtrToken(t)) {
        // 只剥 '@Name'（枚举标注是纯类型层语义，运行时不校验、不理解）；'!' 保留在
        // token 上——运行时要执法的语义（0 检查）跟着 token 走到 callPacked/closure，
        // 无独立 flag 可被解构丢失。槽宽/ABI 判型走 isCPtrToken，带 '!' 不受影响。
        const m = PTR_TOKEN_RE.exec(t)
        return (m?.[2]?.startsWith('@') ? `<${m[1]}>ptr` : t) as C_BasicType_Token
    }
    // 整数档尾缀 '@Name'（枚举值域标注，与 ptr 位的 '@' 同源）：剥掉归一到原 token，
    // 槽宽/ABI 只看归一形式。@ 后缀须为纯枚举名形 —— 'u32@WmMsg:3' 这类混进位域/数组
    // 串的直接 throw，不静默吞成纯标量（布局会错）；名 ∈ EnumMap 的语义校验留给类型层
    // （运行时不理解枚举名）。白名单 = C_BASIC_TYPE（§1 唯一手写清单）；'u32!' 等非
    // ptr 位 '!' 尾缀、别名、拼错 token 不命中，落 throw（类型层先塌 never，这里
    // 兜底动态传入）。
    const at = t.indexOf('@')
    const base = at >= 0 ? t.slice(0, at) : t
    const suffixOk = at < 0 || /^[A-Za-z_]\w*$/.test(t.slice(at + 1))
    if (suffixOk && base !== 'ptr' && (C_BASIC_TYPE as readonly string[]).includes(base)) return base as C_BasicType_Token
    throw new Error("Unknown token: " + t)
}

export function readScalar(dv: DataView, off: number, k: C_BasicType_No_Void): number | bigint | null {
    switch (k) {
        case 'u8': return dv.getUint8(off)
        case 'i8': return dv.getInt8(off)
        case 'u16': return dv.getUint16(off, true)
        case 'i16': return dv.getInt16(off, true)
        case 'u32': return dv.getUint32(off, true)
        case 'i32': return dv.getInt32(off, true)
        case 'u64': return dv.getBigUint64(off, true)
        case 'i64': return dv.getBigInt64(off, true)
        case 'f32': return dv.getFloat32(off, true)
        case 'f64': return dv.getFloat64(off, true)
        case 'ptr': {
            // 有符号读（对齐 C 版 JS_NewInt64）：-1 哨兵等负值保真；用户态指针高位
            // 为 0，有符号读与无符号同值。0 保真返回（即 NULL 品牌零，类型层
            // MaybePtr = NULL | Ptr<N>，传参前收窄掉空位）。写回位模式见 writeScalar。
            return PTR_SIZE === 8 ? Number(dv.getBigInt64(off, true)) : dv.getInt32(off, true)
        }
    }
}

// IR kind 词汇（C_BasicType_No_Void 含 'ptr'）——用户词表无 ptr 档，这里自行增量。
type Entry =
    { [K in C_BasicType_No_Void]: { k: K; v: (C_TypeJsTypeMap & { ptr: number })[K] } }[C_BasicType_No_Void];

/** 内存写：按 sizeof 精确写，供 struct 字段编码用。小整数只占自己的字节，
 *  否则 `{a:u8,b:u8}` 这类紧凑布局会被 setUint32 越界覆盖相邻字段。 */
export function writeScalar(dv: DataView, off: number, { k, v }: Entry): void {
    switch (k) {
        case 'u8': dv.setUint8(off, Number(v)); break
        case 'i8': dv.setInt8(off, Number(v)); break
        case 'u16': dv.setUint16(off, Number(v), true); break
        case 'i16': dv.setInt16(off, Number(v), true); break
        case 'u32': dv.setUint32(off, (v) >>> 0, true); break
        case 'i32': dv.setUint32(off, (v) >>> 0, true); break
        case 'u64': dv.setBigUint64(off, v, true); break
        case 'i64': dv.setBigInt64(off, v, true); break
        case 'f32': dv.setFloat32(off, (v), true); break
        case 'f64': dv.setFloat64(off, (v), true); break
        case 'ptr': {
            // JS null/undefined 不是指针词汇（空位写 NULL）——fail-loud，不做 null→0 转换。
            if ((v as unknown) == null) {
                throw new Error('ffi: got null/undefined for a ptr slot; pass the imported NULL constant for empty')
            }
            // 读回的负值（LRESULT/句柄）再作参数回传时按二补位位模式写：asUintN /
            // >>> 0 取模保真，否则 x64 传负 setBigUint64 直接 RangeError。
            if (PTR_SIZE === 8) dv.setBigUint64(off, BigInt.asUintN(64, BigInt(v)), true)
            else dv.setUint32(off, v >>> 0, true)
            break
        }
    }
}

/** 槽写：供 bind 的参数槽/返回槽用。小整数扩展到 4 字节 —— 可变参数按 int 提升读，
 *  `i8 = -1` 必须给 `0xFFFFFFFF` 而非 `0x000000FF`。u32/i32/u64/i64/f32/f64/ptr
 *  槽宽 == sizeof，直接委托 writeScalar。 */
export function writeSlot(dv: DataView, off: number, e: Entry): void {
    const { k, v } = e
    if (k === 'u8' || k === 'i8' || k === 'u16' || k === 'i16') {
        dv.setUint32(off, Number(v) >>> 0, true)
        return
    }
    writeScalar(dv, off, e)
}

/** buffer + 品牌指针合一：一个引用既是 ArrayBuffer（喂 decode / encode(v, buf) 复用）
 *  又带 `.ptr` 直接喂 <N>ptr 形参 —— 替代旧 { buf, ptr } 结构包装。
 *  `ptr` 是构造时快照（与旧 StructAlloc 同性质：底层数据不可 detach/transfer）。
 *  品牌 N 由创建方声明：struct def 的 alloc()/encode() 返回值在类型层带 def 的 N（不可伪造）；
 *  直接 new 属自报品牌，仅限内部/原型场景 —— 生产路径一律走 def.alloc()。 */
export class PtrArrayBuffer<N extends string> extends ArrayBuffer {
    readonly ptr: Ptr<N>
    constructor(byteLength: number) {
        super(byteLength)
        this.ptr = bufferPtr(this) as Ptr<N>
    }
}
