import * as os from 'os'

// ============================================================
// 语法词汇 —— struct/bind 共用的 C 类型描述。标量直接写 token 字符串（'i32'/'DWORD'），
// 指针写 '<>ptr'（裸地址）或 '<NAME>ptr'（带名）；对象值一律带 '#' 声明键（见 §4）。
// 只描述「C 声明怎么写」（unit/length/encoding 等意图）；内存布局与读写视图由
// struct.ts 的 computeStructLayout/lower 单独 lower 成 layout IR。
//
// 叶子模块：刻意不依赖 win/std/text-codec，可被 struct 直接引用，
// 避免「只用 struct」的调用方被动加载整个 bind 运行时。
// 四段按依赖序：§1 kind 词汇表 → §2 指针布局与品牌 → §3 C 别名与 token 归一 → §4 值词汇。
// ============================================================

// ============================================================
// §1 kind 词汇表 —— C_BASIC_TYPE 是唯一手写清单，下列集合全从它派生
//   C_BasicType(12)  bind 签名 token / lower 后 IR 共用
//   C_Number(10)    结构体字段的数字档
//   C_Integer(8)    C_Number 去浮点 —— 位域存储单元只能是整数档
//   Token(11+指针)  C_ALIAS / Norm / JsTypeOfToken 的操作面（见 §3）
// 排除项：'void' 无大小；裸 'ptr' 用户面禁写（须写 '<>ptr'），内部保留 ——
// 唯一随架构变宽的标量档。lower 后所有指针归一为 kind 'ptr'，名字被擦掉。
// ============================================================
const C_BASIC_TYPE = [
    'void', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32',
    'u64', 'i64', 'f32', 'f64', 'ptr',
] as const

export type C_BasicType = (typeof C_BASIC_TYPE)[number]
export type C_BasicType_No_Void = Exclude<C_BasicType, 'void'>

export type C_BasicType_Token = Exclude<C_BasicType, 'ptr'> | `<${string}>ptr`
export type C_BasicType_Token_No_Void = Exclude<C_BasicType_Token, 'void'>

const PTR_TOKEN_RE = /^<([^<>\s]*)>ptr$/

export function isCPtrToken(t: string): t is `<${string}>ptr` { return PTR_TOKEN_RE.test(t) }
export function ptrName<const N extends string>(t: `<${N}>ptr`): N {
    const m = PTR_TOKEN_RE.exec(t)
    return (m?.[1] || "") as N
}
/**
 * @description `<${string}>ptr` -> 'ptr'
 */
export const cTokenToType = <const T extends string>(t: T): Exclude<T, `<${string}>ptr`> | 'ptr' => {
    if (isCPtrToken(t)) return 'ptr'
    else return t as Exclude<T, `<${string}>ptr`>
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
//   token/别名   'u32' | 'DWORD'（别名经 normToken 归一；'void'/裸 'ptr' 运行时拒绝）
//   数组糖       'u32[4]'（仅 token 元素 —— 更复杂的元素写 '#' array 声明）
//   位域糖       'u32:3'（unit 位收别名，归一后须为整数档）
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

// token 值面：规范 token（含 '<T>ptr'）∪ C 别名键。'void' 除外 —— 无大小，不能作字段值。
export type SimpleToken = Exclude<keyof C_ALIAS_MAP, 'void'> | `<${string}>ptr`

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
    | `${SimpleToken}:${number}`
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

declare const ptrBrand: unique symbol
// `''` 判在左侧（右侧实例化，不作 naked 分布）：T=never 不再塌缩成 never（否则
// `Ptr<never>` 不可构造，decode(… | Ptr<N>) 在 N=never 时直接堵死），含 '' 的并集
// 不再拆分，宽 string 归一裸 number。字面品牌照旧走交叉 brand 分支。
export type Ptr<T extends string> =
    '' extends T ? number : number & { readonly [ptrBrand]: T }

export type NullablePtr<T extends string> = Ptr<T> | null

const C_ALIAS = {
    void: 'void', u8: 'u8', i8: 'i8', u16: 'u16', i16: 'i16', u32: 'u32', i32: 'i32',
    u64: 'u64', i64: 'i64', f32: 'f32', f64: 'f64',
    int: 'i32', long: 'i32', short: 'i16', char: 'i8', float: 'f32', double: 'f64',
    DWORD: 'u32', UINT: 'u32', ULONG: 'u32', LONG: 'i32', BOOL: 'i32', HRESULT: 'i32',
    SHORT: 'i16', USHORT: 'u16', BYTE: 'u8', WCHAR: 'u16',
    LONG_PTR: '<>ptr', ULONG_PTR: '<>ptr', INT_PTR: '<>ptr', UINT_PTR: '<>ptr', DWORD_PTR: '<>ptr',
    SIZE_T: '<>ptr', WPARAM: '<>ptr', LPARAM: '<>ptr',
    HANDLE: '<>ptr', HWND: '<>ptr', HDC: '<>ptr', HMODULE: '<>ptr', HFONT: '<>ptr', HBRUSH: '<>ptr',
    HICON: '<>ptr', HBITMAP: '<>ptr', LPVOID: '<>ptr', LPCVOID: '<>ptr',
    LPCWSTR: '<WCHAR>ptr', PCWSTR: '<WCHAR>ptr', LPWSTR: '<WCHAR>ptr',
} as const satisfies Record<string, C_BasicType_Token>

export type C_ALIAS_MAP = typeof C_ALIAS

export type C_TypeJsTypeMap = {
    u8: number; i8: number; u16: number; i16: number
    u32: number; i32: number; i64: bigint, u64: bigint
    f32: number; f64: number, ptr: number
}

export type TokenArgJsTypeMap = C_TypeJsTypeMap
export type TokenReturnJsTypeMap = C_TypeJsTypeMap & { void: void }

// token 的类型层归一（运行时对应 normToken）。约束刻意保持 string 而非 Token：
// 非法 token（如 'i3z'）要塌成 never 而不是报 TS2344 —— `& keyof` 把交集约成 never，
// 索引出 never 让调用点拿到 never。收紧到 Token 会把「拼错 token」从 never 变成硬错误。
export type Norm<K extends string> = K extends `<${string}>ptr` ? K : C_ALIAS_MAP[K & keyof C_ALIAS_MAP]

// token → JS 类型。M = kind→JS 映射（实参表 / 返回表）；L = 布局名→JS 形；
// D = 落不到任何映射时的默认（实参传 never，使 'void' 等非法档报 never）。
export type JsTypeOfToken<K extends string, M, L, D> =
    Norm<K> extends infer S ?
    S extends `<${infer N}>ptr` ? NullablePtr<N> | L[N & keyof L] :
    M[S & keyof M] extends never ? D
    : M[S & keyof M]
    : never

// token 归一：C/Windows typedef 别名 → 规范形式（'HANDLE' → '<>ptr' 等）；非别名原样返回。

export function normToken(t: string): C_BasicType_Token {
    if (isCPtrToken(t)) return t
    const isKey = (k: string): k is keyof C_ALIAS_MAP => k in C_ALIAS;
    if (isKey(t)) {
        return C_ALIAS[t]
    }
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
            const p = PTR_SIZE === 8 ? Number(dv.getBigUint64(off, true)) : dv.getUint32(off, true)
            // 0 归一为 null：类型层（ValOf / JsTypeOfToken）把指针一律声明为
            // NullablePtr，若此处返回裸 0，`p === null` 就永不成立 —— 类型允许、
            // 运行时永远走不到的分支比类型错误更隐蔽。
            return p === 0 ? null : p
        }
    }
}

type Entry =
    { [K in C_BasicType_No_Void]: { k: K; v: C_TypeJsTypeMap[K] } }[C_BasicType_No_Void];

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
            if (PTR_SIZE === 8) dv.setBigUint64(off, BigInt(v), true)
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