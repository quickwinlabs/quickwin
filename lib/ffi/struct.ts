import * as ffi from 'ffi';
import '../text-codec.js';
import {
    C_BasicType_No_Void,
    C_TypeJsTypeMap,
    isCPtrToken,
    normToken,
    MaybePtr,
    PTR_SIZE,
    PtrArrayBuffer,
    readScalar,
    SizeAlign,
    writeScalar,
    type C_Array,
    type C_BasicType_Token,
    type C_Integer,
    type C_Number,
    type C_Struct, type C_Union,
    type Encoding,
    type Ptr,
    type SimpleMember,
    type SimpleToken,
} from './ctype.js';

// ============================================================
// 聚合定义：唯一 API 是平铺语法（值词汇见 ctype.ts §4），签名与 pack 见末尾 struct()/union()。
// layout 采用 MSVC 对齐语义：
//   i8/u8→1  i16/u16→2  i32/u32/f32→4  i64/u64/f64→8  '<>ptr'/'<T>ptr'→arch 宽(4/8)
//   struct 对齐 = 最大字段对齐，总尺寸末尾补齐；pack 压上限、键尾 '@N'（alignas）抬下限
//   位域布局规则见下方 computeStructLayout 的状态机注释（mingw 实测 DCB/COMSTAT）。
// ============================================================

// ============================================================
// 类型推导 — 值词汇 → decode/encode 形状
// ============================================================

// 指针成员：'<>ptr' → number（T='' 品牌退化）；'<NAME>ptr' → MaybePtr<NAME>（NULL | 品牌 number）。
// 该品牌 number 可直接喂 bind 的 <NAME>ptr 形参（裸地址透传）；空位写 NULL。

type N =
    | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
    | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19
    | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29
    | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 | 39
    | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49
    | 50 | 51 | 52 | 53;

// 规范 token（SimpleToken 守卫后，T 恒为规范形）→ JS 形状：'<T>ptr' → MaybePtr（0 保真，
// 对齐 C 版）；'<T>ptr!' → Ptr（非空担保：decode 直出非空品牌且运行时 0 断言，见 doDecode；
// 下游 '! 消费位'由 bind 的 callPacked 兜底）；'@E' → EnumMap 值域（与 bind 签名位同构：
// decode 出值域收窄、encode 收同型 —— 异种枚举/域外字面量由枚举 nominal 拦，运行时值域
// 校验按设计留 Phase 2）；数字档 → JsType 映射。落不到的（'void'、裸 'ptr'、拼错 token）
// 塌 never。
type ValOf<T> =
    T extends `<${infer B}>ptr!` ? Ptr<B>
    : T extends `<${string}>ptr@${infer E extends keyof EnumMap}` ? EnumMap[E]
    : T extends `<${infer B}>ptr` ? MaybePtr<B>
    : T extends `${infer U}@${infer E extends keyof EnumMap}` ? (U extends C_Number ? EnumMap[E] : never)
    : T extends C_Number ? C_TypeJsTypeMap[T]
    : never

// 位域糖 → 形状：unit 非整数档（如 'f32:3'；T 已被 SimpleToken 守卫限定为规范 token）
// 塌 never（运行时同报错）；width ≤53 可被 number 精确表示 → number，否则 bigint。
type BitShape<T extends string, W extends number> =
    T extends C_Integer ? (W extends N ? number : bigint) : never

// 值 → 形状。对象值一律按 '#' 分派（无「裸嵌套 map 默认 struct」—— 漏写 '#' 是错误）。
// 字符串糖（值尾带 @encoding）在数组糖之前判别 —— 两形态本不相交（数组糖以 ] 收尾），
// 特判在前更可读。注意 infer 出的 L 是字符串字面（'8'），不能写 `L extends number`
// （string 永不 extends number → 塌 never），要用 `L extends `${number}`` 检查；
// U/L/E 都在条件里被引用，避免未使用的 infer 触发 TS6196。
type ShapeOfValue<V> =
    V extends infer T extends SimpleToken ? ValOf<T>
    : V extends `${infer U}[${infer L}]@${infer E}`
      ? (U extends 'u8' | 'u16' ? (L extends `${number}` ? (E extends Encoding ? string : never) : never) : never)
    : V extends `${infer T extends SimpleToken}[${infer L extends number}]` ? Tuple<ShapeOfValue<T>, L>
    : V extends `${infer T extends SimpleToken}:${infer W extends number}` ? BitShape<T, W>
    : V extends { '#': 'array', element: infer E, length: infer L extends number } ? Tuple<ShapeOfValue<E>, L>
    : V extends { '#': 'struct' | 'union' } ? ShapeOfC<V>
    : never

type Tuple<T, N extends number, R extends T[] = []> =
    number extends N ? T[]
    : R['length'] extends N ? R
    : R['length'] extends 64 ? T[]
    : Tuple<T, N, [...R, T]>
type DollarKeys<T> = { [K in keyof T]: K extends `$${string}` ? K : never }[keyof T];
type UnionToIntersection<U> =
    (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;
type Lift<T> =
    {
        [K in keyof T as K extends `$${string}` ? never : K]:
        T[K] extends readonly unknown[] ? T[K] :
        // 品牌 number（NULL / Ptr = 0&{brand} 或 number&{brand}）经自己的对象半边
        // extends object，会被误当嵌套对象递归，把 number 榨成方法集对象（丧失
        // number 属性）——number 档先跳过。只递归进真正嵌套的结构体形状。
        T[K] extends number ? T[K] :
        T[K] extends object ? Lift<T[K]> : T[K];
    } & UnionToIntersection<
        { [K in DollarKeys<T>]: Lift<T[K]> }[DollarKeys<T>]
    >;
// 形状层刻意不设约束：M 常是泛型实例化里的 C_Struct 交叉（在 struct()/union() 声明处
// 无法证明满足模板索引签名），约束检查会在这里炸掉（TS2344/TS2589）。
// 非法 M 落到 ShapeOfValue 的 never 分支，由具体实例化点暴露。
// 指令键（'#'/'#pack'）不进形状；键尾 '@N'（alignas）拆掉 —— 对齐只影响布局、不影响读写形状。
type FieldKey<K> =
    K extends `#${string}` ? never
    : K extends `${infer B}@${string}` ? B
    : K
type _ShapeOfC<M> = {
    [K in keyof M as FieldKey<K>]: ShapeOfValue<M[K]>
}
type ShapeOfC<M> = Lift<_ShapeOfC<M>>

// encode 入参的深度可选形态：缺省字段运行时跳过（doEncode 的 undefined-continue——
// 不动 buffer 该字段，新建 buffer 上等价写 0），decode 返回仍是全字段 ShapeOfC。
// 数组元组排除在外：writeArray 是整体写入语义，"省略第 N 个元素"没有意义——
// 数组字段维持"要么给全、要么整个缺省"（整个缺省由外层 continue 拦下）。
export type DeepPartial<T> =
    T extends readonly unknown[] ? T
    : T extends number | string | boolean | bigint | symbol ? T
    : { [K in keyof T]?: DeepPartial<T[K]> }

// encode 物化入参：缺省字段运行时跳过（doEncode 的 undefined-continue —— 不动 buffer，
// 新建槽等价写 0），decode 返回仍是全字段 ShapeOfC。
// 必填集 = '!' 字段（非空担保，省略 = 槽留 0 违约）∪ '@' 值域字段中 0 ∉ 值域的（省略 =
// 新槽写 0，0 不在枚举值域同样是静默违约；0 ∈ 值域或宽 number 值域可省 —— 省略产生的 0
// 本身就是合法枚举值）。判定从 T 的**原始 token** 按 DFS 后序递归展开（子先判、父取 OR）：
// 原文 token 是标注的唯一权威，且 `<>ptr!` 的 '!' 在形上已塌进裸 number（Ptr<''> 空品牌
// 归一），只有 token 能看见。数组（`{'#':'array'}` 与 `u32@E[N]` 糖）按**元素**穿透 ——
// 整组省略 = 元素全 0，违约同理；嵌套 struct/union 递归字段 —— 子树含必填 ⇒ 本键必填，
// 堵掉「encode 通过、decode 0 断言炸」的嵌套/数组缺口。
// 必填键的值经 EncodeValOfT **后序合成**：嵌套 struct/union 再套同一 EncodeShapeOfC
// （内层必填键强制、非必填兄弟维持 DeepPartial 可省 —— 与运行时逐字段对应：省略兄弟 =
// 写 0，合法零值），标量/数组取全量形。其余字段维持 DeepPartial 缺省语义（省略 = 跳过，
// 新建槽写 0 / 复用槽留旧值）。
// 无必填字段时整体退化为纯 DeepPartial、**不进交集**：`{} & {全可选}` 会绕过 TS 的
// weak-type 检查（TS2559 'no properties in common' 不再触发），裸 number/string 就此
// 混进任何 codec 实参位（asctime(123) 回归实测）。元组包一层防 never 分发。
type IsSubtreeMandatory<D> =
    // —— 结构形态：DFS 后序（先子后父）——
    D extends { '#': 'array', element: infer E } ? IsSubtreeMandatory<E>
    : D extends { '#': 'struct' | 'union' }
        ? (true extends { [K in keyof D]-?: IsSubtreeMandatory<D[K]> extends true ? true : false }[keyof D] ? true : false)
    // —— token 形态：分支序对齐 ShapeOfValue（字符串糖先于数组糖，编码 @ 先于枚举 @）——
    : D extends `${string}[${number}]@${string}` ? false            // 字符串糖（'u16[4]@utf-8'）：'' 合法 → 可省
    : D extends `${infer TK extends SimpleToken}[${string}]` ? IsSubtreeMandatory<TK>   // 数组糖穿透元素
    : D extends `${string}:${number}` ? false                       // 位域：数值零合法 → 可省
    : D extends `<${string}>ptr!` ? true                            // '!'（含裸 <>ptr! —— 形塌 number，token 是唯一判据）
    : D extends `<${string}>ptr@${infer E extends keyof EnumMap}` ? (0 extends EnumMap[E] ? false : true)
    : D extends `${infer U}@${infer E extends keyof EnumMap}`
        ? (U extends C_Number ? (0 extends EnumMap[E] ? false : true) : false)
    : false
// 必填键 → 其**原始声明值**的映射（`as` 重映射一步完成过滤 + alignas 归一 + 剔 '#'）。
type MandatoryDeclKeys<T> = {
    [K in keyof T]-?: IsSubtreeMandatory<T[K]> extends true ? FieldKey<K> : never
}[keyof T]
// 必填键的值：嵌套 struct/union 后序递归同一形态，其余（标量/数组/糖）取全量形。
type EncodeValOfT<D> =
    D extends { '#': 'struct' | 'union' } ? EncodeShapeOfC<D>
    : ShapeOfValue<D>
type EncodeShapeOfC<T> =
    DeepPartial<ShapeOfC<T>> & {
        [K in keyof T as IsSubtreeMandatory<T[K]> extends true ? FieldKey<K> : never]-?: EncodeValOfT<T[K]>
    }
type EncodeIn<T extends { '#': 'struct' | 'union' }> =
    [MandatoryDeclKeys<T>] extends [never]
        ? DeepPartial<ShapeOfC<T>>
        : EncodeShapeOfC<T>


// ============================================================
// 运行时类型
// ============================================================

// lower 后指针统一归一为内部 kind 'ptr'（用户面写 '<>ptr' 或 '<NAME>ptr'）。

// kind → size/align（不含指针：指针统一 PTR_SIZE，见 lower）。


// 运行时 Field：IR 的 lowered 视图（独立于语法层，不保留 alignas）。
// computeStructLayout 在 lowering 时把子布局内嵌进 FieldType（struct/union→fields，
// array→elementType+elementSize，bitfield→bit 单元内偏移），运行期 read/write 零查表。
// offset 相对本层起点；位域成员的 offset 是其存储单元的基址（不是位域自己的地址）。
type FieldType =
    { tag: 'basic', kind: C_BasicType_No_Void }
    | { tag: 'bitfield', unit: C_Integer, bit: number, width: number }
    | { tag: 'string', encoding: Encoding }
    | { tag: 'struct' | 'union', fields: Field[] }
    | { tag: 'array', elementType: FieldType, elementSize: number }
export type Field = {
    name: string
    offset: number
    size: number
    type: FieldType
    /** '!' 标注字段（原文 token `<X>ptr!`）：decode 读出 0 当场 throw（后置兜底 ——
     *  C 没填 / 拿未填充槽 decode 都在这里拦，见 doDecode）。 */
    nonnull?: true
}
export type Fields = Field[]

// T 约束 = '#' 声明本身：struct()/union() 构造的 `{'#':'struct'} & M` 可证 —— M 是平铺
// 字段表（SimpleMember 无 '#' 键），交叉的 '#' 取字面声明。形状层不设约束的理由见 ShapeOfC。
// N = 布局品牌（struct(name, …) 传入）：decode 入参与 alloc().ptr 同品牌。默认 '' ——
// `Ptr<''>` 归一裸 number（与旧 never 守卫结果相同），品牌化 def 未来收窄时签名不用再动。
export type StructDef<T extends { '#': 'struct' | 'union' }, N extends string = ''> = {
    readonly __struct: T
    readonly size: number
    readonly structAlign: number
    decode(buf: ArrayBuffer | Ptr<N>): ShapeOfC<T>
    // alloc = 出参槽分配（全新全 0：'!' 字段的 0 是出参哨兵，decode 的 0 断言兜 C 没填）；
    // encode = 物化（C 要读的对象），带品牌 .ptr 直接喂 <N>ptr 形参。'!' 字段在 EncodeIn
    // 里必填 —— 省略即编译错，不静默写 0 / 复用槽留旧值（DFS 后序穿透嵌套与数组：子树/
    // 数组元素含必填 ⇒ 该键必给，值后序合成到内层）。带 buf = 写入调用方既有
    // PtrArrayBuffer（返回其本身，供链式读回）——encode 出口一律 PAB，裸 ArrayBuffer
    // 不出 codec（与 CodecMap 同约束）。动态调用方无参 encode 由运行时 throw 兜底。
    /** n（默认 1）= 按本布局 size 步长连续分配 n 个元素的零填充缓冲（出参数组场景，
     *  品牌 .ptr 直接喂 <N>ptr 位）。n < 1 / 非整数运行时 throw ——
     *  任何路径都不产出 PAB(0)（其 .ptr 是"非 0 的 1 字节堆指针"，会骗过 C 的 NULL
     *  防御；空位语义由调用方显式传 NULL）。 */
    alloc(n?: number): PtrArrayBuffer<N>
    encode(v: EncodeIn<T>): PtrArrayBuffer<N>
    // 带 buf = 写入调用方既有 PtrArrayBuffer（复用/预分配形态）；带 offset = 写入点
    // 相对 buf 起点的字节偏移（数组物化/自定义内存管理的底层写入原语，内部即 doEncode
    // 的 base）。返回值仍是 buf 本身 —— offset 形态下其 .ptr 对不上写入点，写入点地址
    // = buf.ptr + offset（自算术，品牌随算术丢失同 CreatePipe 先例）；越界写由 DataView
    // RangeError 兜底，无需额外校验。
    encode(v: EncodeIn<T>, buf: PtrArrayBuffer<any>, offset?: number): PtrArrayBuffer<any>
    offsetOf(name: string): number
}

// ============================================================
// Layout IR —— computeStructLayout/lower 把 CType AST IR lower 到此。
// 自包含：子布局在 lowering 时内嵌、offset 相对本层起点，运行期 read/write 不回查 AST IR。
// ============================================================

/** 向上对齐（a 必须是 2 的幂）。 */
function alignUp(v: number, a: number): number {
    return (v + a - 1) & ~(a - 1)
}

type Layout = {
    size: number,
    maxEffectiveAlign: number,
    fields: Fields,
}

// 归一后 token 的档位检查：'void'/指针 token 查表为 undefined（SizeAlign 只收 C_Number）。
const isCNumberToken = (t: C_BasicType_Token): t is C_Number =>
    SizeAlign[t as C_Number] !== undefined

// 值 → { size, align, FieldType }：字符串先试字符串糖/数组糖/位域糖，再按 token 归一；
// 对象值一律按 '#' 分派 —— 无「裸嵌套 map 默认 struct」，漏写 '#' 直接报错。
// 字符串无 '#' 声明形式（词汇只有糖，见 ctype.ts §4）：旧写法落到末尾 unknown '#' 报错。
function lower(v: unknown): { size: number, align: number, type: FieldType } {
    if (typeof v === 'string') {
        const st = /^(u8|u16)\[(\d+)\]@(utf-8|utf-16le)$/.exec(v)   // 'u16[128]@utf-16le' → 字符串糖
        if (st) {
            const length = Number(st[2])
            if (!Number.isInteger(length) || length < 1)
                throw new Error(`ffi-struct: string length must be an integer >= 1, got ${length}`)
            // 布局 = unit × length（与 encoding 无关），encoding 只是读写时的解释 ——
            // 'u8[128]@utf-16le'（128 字节按 utf-16le 解出 64 字符）之类的错配语义自洽。
            const s = st[1] === 'u8' ? 1 : 2
            return { size: s * length, align: s, type: { tag: 'string', encoding: st[3] as Encoding } }
        }
        const a = /^([^\[\]]+)\[(\d+)\]$/.exec(v)          // 'u32[4]' / 'i3z[4]' → 数组糖（元素递归归一）
        if (a) {
            const length = Number(a[2])
            if (!Number.isInteger(length) || length < 1)
                throw new Error(`ffi-struct: array length must be an integer >= 1, got ${length}`)
            const el = lower(a[1])
            if (el.type.tag === 'bitfield')
                throw new Error('ffi-struct: bitfields cannot be array elements')
            return {
                size: el.size * length,
                align: el.align,
                type: { tag: 'array', elementType: el.type, elementSize: el.size },
            }
        }
        const b = /^([A-Za-z_]\w*):(\d+)$/.exec(v)          // 'u32:3' → 位域糖（'f32:3' 归一后非整数档被拒）
        if (b) {
            const rawUnit = b[1]!
            const unit = normToken(rawUnit)
            // 'void'/'<>ptr' 查表为 undefined、'float' 等别名 normToken 直接抛 —— 都不是合法位域单元。
            if (!isCNumberToken(unit) || unit === 'f32' || unit === 'f64')
                throw new Error(`ffi-struct: bitfield unit must be an integer type, got "${rawUnit}"`)
            const width = Number(b[2])
            const s = SizeAlign[unit]
            const cap = s * 8
            if (!Number.isInteger(width) || width < 1)
                throw new Error(`ffi-struct: bitfield width must be an integer >= 1, got ${width}`)
            if (width > cap)
                throw new Error(`ffi-struct: bitfield width ${width} exceeds unit width ${cap}`)
            // bit 是单元内偏移，由 computeStructLayout 的位域状态机填写；这里占位 0。
            return { size: s, align: s, type: { tag: 'bitfield', unit, bit: 0, width } }
        }
        // 规范 token / 指针 token（别名机制已移除：'DWORD' 等 normToken 直接抛）。
        // 归一后必须先判指针形，否则落 unknown kind；'void' 归一后无大小、
        // 裸 'ptr'/'i3z' 未知 —— 都在这里抛（原先由 SizeAlign 查表兜住，现归一并入）。
        const k = normToken(v)
        if (isCPtrToken(k))
            return { size: PTR_SIZE, align: PTR_SIZE, type: { tag: 'basic', kind: 'ptr' } }
        if (!isCNumberToken(k)) throw new Error(`ffi-struct: unknown kind "${v}"`)
        const s = SizeAlign[k]
        return { size: s, align: s, type: { tag: 'basic', kind: k } }
    }
    if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>
        const tag = o['#']
        if (tag === undefined)
            throw new Error(`ffi-struct: nested object value requires a '#' key ('struct' | 'union' | 'array')`)
        if (tag === 'array' && '#pack' in o)
            throw new Error(`ffi-struct: '#pack' is only allowed on struct/union, got '${tag}'`)
        if (tag === 'array') {
            const length = o['length']
            if (!Number.isInteger(length) || (length as number) < 1)
                throw new Error(`ffi-struct: array length must be an integer >= 1, got ${String(length)}`)
            const el = lower(o['element'])
            if (el.type.tag === 'bitfield')
                throw new Error('ffi-struct: bitfields cannot be array elements')
            return {
                size: el.size * (length as number),
                align: el.align,
                type: { tag: 'array', elementType: el.type, elementSize: el.size },
            }
        }
        if (tag === 'struct' || tag === 'union') {
            const l = computeStructLayout(v as C_Struct | C_Union)
            return { size: l.size, align: l.maxEffectiveAlign, type: { tag, fields: l.fields } }
        }
        throw new Error(`ffi-struct: unknown '#' declaration ${JSON.stringify(String(tag))}`)
    }
    throw new Error(`ffi-struct: invalid member value: ${String(v)}`)
}

export function computeArray(t: C_Array): { align: number, size: number } {
    const { size, align } = lower(t)
    return { align, size }
}

export function computeStructLayout(t: C_Struct | C_Union): Layout {
    const isStruct = t['#'] === 'struct'
    const pack = t['#pack'] ?? 8
    let maxEffectiveAlign = 1
    let maxMemberSize = 0
    const fields: Fields = []
    let cursor = 0

    // 位域组状态：unitBase 是当前存储单元的字节基址（-1 = 不在位域组内），
    // unitBits 是单元内已用位数，unitSize 是单元宽（字节）。
    // MSVC 规则（mingw 交叉实测 DCB/COMSTAT 验证）：
    //   - 连续同宽位域共单元，LSB→MSB（签别不参与分组）
    //   - 放不下的位域开新单元，单元剩余位废弃
    //   - 非位域成员打断位域组，游标跳到完整单元边界（不是按字节截断）
    // 联合体位域不分组：每位域成员独立从 offset 0/bit 0 起算——完全别名
    // （mingw 16 x64+ia32 实测：a=1→b=1、溢出成员回 offset 0、sizeof=单元宽）。
    let unitBase = -1
    let unitBits = 0
    let unitSize = 0

    // 落定当前位域组：游标 = 单元起点 + 已用字节数，向上取整到单元宽。
    const flushUnit = () => {
        if (unitBase < 0) return
        cursor = alignUp(unitBase + Math.ceil(unitBits / 8), unitSize)
        unitBase = -1
    }

    for (const [rawName, v] of Object.entries(t as unknown as Record<string, unknown>)) {
        if (rawName.startsWith('#')) continue            // '#' 指令键（'#'/'#pack'）不是字段
        const m = /^([^@]+)@(\d+)$/.exec(rawName)        // 键尾 '@N' = alignas（字段名不含 '@'）
        const name = m ? m[1]! : rawName
        const alignas = m ? Number(m[2]) : 0
        const { size, align: natural, type } = lower(v)
        // '!' 非空担保标记（原文 `<X>ptr!`）：lower 里 normToken 已拒掉 'u32!'/'HANDLE!' 等
        // 非法尾缀，能走到这里的 '!' 尾必是指针 token —— 记到 Field 上供 decode 的 0 断言。
        const nonnull = typeof v === 'string' && v.endsWith('!')
        let align = natural
        if (pack > 0) align = Math.min(pack, align)
        if (alignas) align = Math.max(align, alignas)

        if (type.tag === 'bitfield') {
            if (name.startsWith('$')) throw new Error('ffi-struct: bitfield members must be named')

            // union：成员同址（C 标准），每位域成员独立从 offset 0/bit 0 起算。
            // 不顺序分组、不开新单元、不动游标（flushUnit 因 unitBase 恒 -1 而
            // no-op，普通/匿名成员的 offset 也因此保持 0）——曾因游标推进致
            // 溢出单元/后续成员落在 union 声明 size 之外（越界读写）。
            if (!isStruct) {
                fields.push({ name: name, offset: 0, size, type: { ...type, bit: 0 } })
                maxEffectiveAlign = Math.max(maxEffectiveAlign, align)
                maxMemberSize = Math.max(maxMemberSize, size)
                continue
            }

            const width = type.width

            // 新单元：无活动单元 / 单元宽不同 / 放不下。
            if (unitBase < 0 || size !== unitSize || unitBits + width > unitSize * 8) {
                // 单元宽变化或溢出时先把旧单元落定，新单元从落定点对齐。
                if (unitBase >= 0) flushUnit()
                const offset = alignUp(cursor, align)
                unitBase = offset
                unitBits = 0
                unitSize = size
            }

            fields.push({
                name: name,
                offset: unitBase,   // 单元基址（不是位域自己的地址）
                size,
                type: { ...type, bit: unitBits },
            })
            unitBits += width

            maxEffectiveAlign = Math.max(maxEffectiveAlign, align)
            maxMemberSize = Math.max(maxMemberSize, size)
            continue
        }

        flushUnit()
        const offset = alignUp(cursor, align)

        if (!name.startsWith('$')) {
            fields.push({ name: name, offset, size, type, ...(nonnull ? { nonnull: true as const } : {}) })
        } else {
            // 匿名聚合：内嵌 fields 已 lower 好，offset 平移到本成员起点。
            if (type.tag !== 'struct' && type.tag !== 'union')
                throw new Error(`ffi-struct: anonymous member "${name}" must be a struct/union`)
            for (const cf of type.fields)
                fields.push({ ...cf, offset: cf.offset + offset })
        }

        if (isStruct) cursor = offset + size
        maxEffectiveAlign = Math.max(maxEffectiveAlign, align)
        maxMemberSize = Math.max(maxMemberSize, size)
    }

    flushUnit()

    return {
        size: isStruct ? alignUp(cursor, maxEffectiveAlign) : alignUp(maxMemberSize, maxEffectiveAlign),
        maxEffectiveAlign,
        fields,
    }
}

// ============================================================
// 位域读写
// ============================================================
// 存储单元统一按无符号读（避免单元高位的符号位干扰提取），再用掩码取出位域。
// 有符号单元在提取后做符号扩展。写是读-改-写：只改本位域占的位，其余位保留。
// 64 位单元往返走 BigInt；读回时 width>53 返回 bigint、否则 number（见 readBitfield）。
type BitfieldType = Extract<FieldType, { tag: 'bitfield' }>

function readUnitRaw(dv: DataView, off: number, unit: C_Integer): bigint {
    const s = SizeAlign[unit]
    if (s === 1) return BigInt(dv.getUint8(off))
    if (s === 2) return BigInt(dv.getUint16(off, true))
    if (s === 4) return BigInt(dv.getUint32(off, true))
    return dv.getBigUint64(off, true)
}

function writeUnitRaw(dv: DataView, off: number, unit: C_Integer, v: bigint): void {
    const s = SizeAlign[unit]
    if (s === 1) { dv.setUint8(off, Number(v & 0xffn)); return }
    if (s === 2) { dv.setUint16(off, Number(v & 0xffffn), true); return }
    if (s === 4) { dv.setUint32(off, Number(v & 0xffffffffn), true); return }
    dv.setBigUint64(off, v & 0xffffffffffffffffn, true)
}

function readBitfield(dv: DataView, off: number, t: BitfieldType): number | bigint {
    const w = BigInt(t.width)
    let v = (readUnitRaw(dv, off, t.unit) >> BigInt(t.bit)) & ((1n << w) - 1n)
    if (t.unit[0] === 'i' && (v & (1n << (w - 1n))))   // 有符号单元且符号位为 1 → 先符号扩展
        v -= 1n << w
    if (t.width > 53) return v      // 值域装不进安全整数 → bigint（与类型层 BitShape 同界）
    return Number(v)
}

function writeBitfield(dv: DataView, off: number, t: BitfieldType, val: number | bigint): void {
    const w = BigInt(t.width)
    const bit = BigInt(t.bit)
    const widthMask = (1n << w) - 1n
    const posMask = widthMask << bit
    const raw = readUnitRaw(dv, off, t.unit)
    const bits = (typeof val === 'bigint' ? val : BigInt(Math.trunc(val))) & widthMask
    writeUnitRaw(dv, off, t.unit, (raw & ~posMask) | (bits << bit))
}

// 字符串读写统一走 TextEncoder/TextDecoder（polyfill 见 lib/text-codec.js）。
const stringEncoders: Record<Encoding, TextEncoder> = {
    'utf-8': new TextEncoder('utf-8'),
    'utf-16le': new TextEncoder('utf-16le'),
}

const stringDecoders: Record<Encoding, TextDecoder> = {
    'utf-8': new TextDecoder('utf-8', { ignoreBOM: true }),
    'utf-16le': new TextDecoder('utf-16le', { ignoreBOM: true }),
}

function readString(dv: DataView, off: number, size: number, enc: Encoding): string {
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset + off, size)
    const unit = enc === 'utf-16le' ? 2 : 1
    let end = size
    for (let i = 0; i + unit <= size; i += unit) {
        if (bytes[i] === 0 && (unit === 1 || bytes[i + 1] === 0)) { end = i; break }
    }
    return stringDecoders[enc].decode(bytes.subarray(0, end))
}

function writeString(dv: DataView, off: number, size: number, enc: Encoding, v: unknown): void {
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset + off, size)
    bytes.fill(0)
    // 始终给 NUL 终止符留一个存储单元（宽度由 encoding 决定，见 readString）：
    // 末尾保持 0，payload 最多 size - unit 字节。这样 C 侧 strlen/wcslen 都不会越界。
    const unit = enc === 'utf-16le' ? 2 : 1
    const cap = size - unit
    if (cap <= 0) return
    const src = stringEncoders[enc].encode(String(v ?? ''))
    bytes.set(src.subarray(0, Math.min(src.length, cap)))
}

type ArrayFieldType = Extract<FieldType, { tag: 'array' }>

function readArray(dv: DataView, off: number, size: number, t: ArrayFieldType): unknown[] {
    const count = t.elementSize > 0 ? size / t.elementSize : 0
    const out: unknown[] = []
    for (let i = 0; i < count; i++)
        out.push(readElement(dv, off + i * t.elementSize, t.elementType, t.elementSize))
    return out
}

function writeArray(dv: DataView, off: number, size: number, t: ArrayFieldType, v: unknown): void {
    const count = t.elementSize > 0 ? size / t.elementSize : 0
    const list = (v ?? []) as unknown[]
    for (let i = 0; i < count; i++)
        writeElement(dv, off + i * t.elementSize, t.elementType, t.elementSize, list[i])
}

function readElement(dv: DataView, off: number, t: FieldType, size: number): unknown {
    switch (t.tag) {
        case 'basic': return readScalar(dv, off, t.kind)
        case 'bitfield': return readBitfield(dv, off, t)
        case 'string': return readString(dv, off, size, t.encoding)
        case 'struct':
        case 'union': return doDecode(dv, off, t.fields)
        case 'array': return readArray(dv, off, size, t)
    }
}

function writeElement(dv: DataView, off: number, t: FieldType, size: number, val: unknown): void {
    switch (t.tag) {
        // TODO: remove this any
        case 'basic': writeScalar(dv, off, { k: t.kind, v: val as any }); break
        // 直传（不 Number()）：writeBitfield 的 val 是 number | bigint，
        // 64 位单元走 bigint，先 Number() 会把 >2^53 的位域值截断。
        case 'bitfield': writeBitfield(dv, off, t, (val ?? 0) as number | bigint); break
        case 'string': writeString(dv, off, size, t.encoding, val); break
        case 'struct':
        case 'union': doEncode(dv, off, t.fields, (val ?? {}) as Record<string, unknown>); break
        case 'array': writeArray(dv, off, size, t, val); break
    }
}

function doDecode(dv: DataView, base: number, fields: Fields): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const f of fields) {
        const v = readElement(dv, base + f.offset, f.type, f.size)
        // '!' 非空担保的后置兜底：C 没填（忘判成功就 decode）或拿未填充槽（decode(alloc())）
        // 读出 0 —— 当场 throw，不让 0 带 Ptr 品牌流到下游 '! 消费位'。成功路径必非零，不触发。
        if (f.nonnull && v === 0)
            throw new Error(`ffi-struct: decode: '!' field "${f.name}" got 0 ` +
                `(C did not fill it, or decode was called on an unfilled slot)`)
        out[f.name] = v
    }
    return out
}

function doEncode(dv: DataView, base: number, fields: Fields, v: Record<string, unknown>): void {
    for (const f of fields) {
        // DeepPartial 缺省：不动该字段（新建 buffer 上保持 0、复用 buffer 上保留旧值）；
        // 嵌套/数组字段整个缺失也在这里拦下（writeElement 的 struct 分支回到本函数）。
        if (v[f.name] === undefined) continue
        writeElement(dv, base + f.offset, f.type, f.size, v[f.name])
    }
}

// ============================================================
// 内部构造器
// ============================================================

function createStruct(t: C_Struct | C_Union): any {
    const { fields, size, maxEffectiveAlign } = computeStructLayout(t)
    return {
        __struct: t,
        size,
        structAlign: maxEffectiveAlign,
        decode: (p: ArrayBuffer | number) => {
            // number = native 拥有的品牌指针（Codec 的 decode(p) 形态）：按布局 size
            // 逐字节拷进临时 buffer 再解码；ArrayBuffer = 调用方持有的 out buffer 直读。
            // 顶层不收 offset——out 参数恒从起点读，嵌套偏移由字段布局（doDecode 的 base）承担。
            if (typeof p === 'number') {
                const buf = new ArrayBuffer(size)
                const u8 = new Uint8Array(buf)
                for (let i = 0; i < size; i++) u8[i] = ffi.readByte(p + i)
                return doDecode(new DataView(buf), 0, fields)
            }
            return doDecode(new DataView(p), 0, fields)
        },
        alloc: ((n?: number) => {
            // fail-loud：n < 1 / 非整数绝不静默产出 PAB(0)（其 .ptr 是"非 0 的 1 字节
            // 堆指针"，会骗过 C 的 NULL 防御）—— 空位语义由调用方显式传 NULL。
            if (n !== undefined && (!Number.isInteger(n) || n < 1))
                throw new Error(`ffi-struct: alloc(n) requires an integer n >= 1 ` +
                    `(PAB(0) never escapes — pass NULL for an empty pointer position)`)
            return new PtrArrayBuffer(size * (n ?? 1))
        }) as StructDef<any, any>['alloc'],
        encode: ((v: any, buf?: PtrArrayBuffer<any>, offset?: number) => {
            // fail-loud：无参 = 分配语义，走 alloc()；这里绝不静默零填充 —— 类型层由
            // EncodeIn 拦 '!' 字段省略，动态/JS 调用方由本 throw 兜住。顶层默认从起点写，
            // offset 显式给写入点（数组物化原语，见接口注释）。
            if (v === undefined || v === null)
                throw new Error(`ffi-struct: encode(v) requires an argument; ` +
                    `use alloc() for a zeroed out-param slot`)
            const out = buf ?? new PtrArrayBuffer(size)
            doEncode(new DataView(out), offset ?? 0, fields, v)
            return out
        }) as StructDef<any, any>['encode'],
        offsetOf: (name: string) => {
            for (const f of fields) if (f.name === name) return f.offset
            throw new Error(`ffi-struct: no field "${name}"`)
        },
    }
}

// ============================================================
// 公共 API
// ============================================================

/** 聚合对齐上限（pack 压 maxAlign，语义同 MSVC #pragma pack）。 */
export type AggOpts = { pack?: number }

/** 平铺字段表 → '#' 声明：'#'/`#pack` 由构造器写入（顶层 kind 由函数名表明，字段表本身
 *  不收指令键）。member 里混进的 '#' 前缀键在此剔除 —— 类型层已禁（fresh literal excess
 *  check），这里运行时兜底，避免用户键覆盖构造器写入的 '#'/`#pack`。 */
function buildDecl(kind: 'struct' | 'union', member: Record<string, unknown>, pack?: number): C_Struct | C_Union {
    const decl: Record<string, unknown> = { '#': kind }
    if (pack !== undefined) decl['#pack'] = pack
    for (const [k, v] of Object.entries(member))
        if (!k.startsWith('#')) decl[k] = v
    return decl as unknown as C_Struct | C_Union
}

/** decode 双态重载：有 byteLength 的 buffer 形 count 可缺省（自算）；裸地址无长度
 *  信息，count 必填（类型层拦，缺省调用编译红）。 */
type StructArrayDecode<T extends { '#': 'struct' | 'union' }, N extends string> = {
    (p: ArrayBuffer, count?: number): ShapeOfC<T>[]
    (p: Ptr<N>, count: number): ShapeOfC<T>[]
}

/** 结构/联合体的数组编解码对工厂：返回 `{ encode, decode }`。
 *  encode —— 单值 encoder 的数组版：收元素数组 → 按本布局 size 步长紧密排列
 *  （stride = size，已含尾部对齐 padding），返回带品牌 .ptr 的 PAB —— 与 C 的
 *  `const T apt[]` 同构。值域刻意收普通数组（调用方持有的 `const pts = [...]` 变量
 *  直传，非空元组会拒之）；[] / 非数组 / 单对象运行时 throw —— 任何路径都不产出
 *  PAB(0)（其 .ptr 是"非 0 的 1 字节堆指针"，会骗过 C 的 NULL 防御；空位语义由
 *  调用方显式传 NULL）。注册进 bind 的 encoders 表（`{ POINT: structArray(POINT) }`）
 *  后，普通 `<POINT>ptr` 位的值域即元素数组（值域由 encoder 推导，token/引擎/类型层
 *  零数组概念）；直接调用 `.encode(els).ptr` 亦可。
 *  decode —— 出参数组读回（与 def.decode 的 ArrayBuffer/地址双态对称）：
 *  - buffer 形（含 PAB）：count? 缺省自算 byteLength/size —— 要求整数倍，% ≠ 0
 *    throw（混合缓冲如 EnumPrinters 的"结构 + 尾部字符串"必须显式 count）；显式
 *    count 校验 count*size ≤ byteLength（写错 count → 越界读的防线，buf 形可校才
 *    校；不验品牌，与 def.decode 的 buffer 形同款）。
 *  - 裸地址形：count 必填（地址无长度信息），逐字节拷读（def.decode 的 number 形
 *    同机制）；长度不可校 → 信任 C 的 count。
 *  - count = 0 → []（读 0 个真空安全，与 encode 禁空的 PAB(0) 理由刻意不对称）。
 *  实现：encode 走纯公开 API（alloc + encode offset 循环）；decode 在本文件内复用
 *  computeStructLayout/doDecode。 */
export function structArray<T extends { '#': 'struct' | 'union' }, N extends string = ''>(
    def: StructDef<T, N>,
) {
    const { fields, size } = computeStructLayout(def.__struct)
    const readN = (dv: DataView, n: number): unknown[] => {
        const out: unknown[] = []
        for (let i = 0; i < n; i++) out.push(doDecode(dv, i * size, fields))
        return out
    }
    return {
        encode: (els: readonly EncodeIn<T>[]): PtrArrayBuffer<N> => {
            if (!Array.isArray(els) || els.length === 0)
                throw new Error(`ffi-struct: structArray(def).encode(els) requires a ` +
                    `non-empty element array (pass NULL for an empty pointer position)`)
            const out = def.alloc(els.length)
            for (let i = 0; i < els.length; i++) def.encode(els[i], out, i * def.size)
            return out
        },
        decode: ((p: ArrayBuffer | number, count?: number): unknown[] => {
            // fail-loud 校验矩阵（见 JSDoc）：显式 count 信调用方但拦越界；缺省只对
            // 有 byteLength 的 buffer 形自算；裸地址必带 count。
            if (count !== undefined && (!Number.isInteger(count) || count < 0))
                throw new Error(`ffi-struct: structArray.decode(p, count) requires a ` +
                    `non-negative integer count, got ${count}`)
            if (typeof p === 'number') {
                if (count === undefined)
                    throw new Error(`ffi-struct: structArray.decode(address, count) ` +
                        `requires an explicit count (a bare address carries no length)`)
                if (count === 0) return []
                // 逐字节拷进临时 buffer 再解码（def.decode 的 number 形同机制）。
                const total = count * size
                const buf = new ArrayBuffer(total)
                const u8 = new Uint8Array(buf)
                for (let i = 0; i < total; i++) u8[i] = ffi.readByte(p + i)
                return readN(new DataView(buf), count)
            }
            let n: number
            if (count !== undefined) {
                n = count
                // 越界防线：写错 count 是越界读的唯一入口，buf 形有 byteLength 就校死。
                if (n * size > p.byteLength)
                    throw new Error(`ffi-struct: structArray.decode: count ${n} × ` +
                        `size ${size} = ${n * size} exceeds buffer byteLength ${p.byteLength}`)
            } else {
                // 自算形态：byteLength 必须是纯元素序列（size = 0 的退化布局同样落此
                // throw —— 0 % 0 = NaN），混合缓冲显式传 count。
                if (p.byteLength % size !== 0)
                    throw new Error(`ffi-struct: structArray.decode: byteLength ` +
                        `${p.byteLength} is not a multiple of size ${size} ` +
                        `(mixed buffer? pass count explicitly)`)
                n = p.byteLength / size
            }
            if (n === 0) return []
            return readN(new DataView(p), n)
        }) as StructArrayDecode<T, N>,
    }
}

/** 平铺字段表定义结构体（token/`X[n]`/`unit:width`/`'#'` 声明均可，见 ctype.ts §4）。
 *  给 name 则 alloc().ptr 与 decode 入参带 Ptr<name> 品牌。 */
type StructOf<M, N extends string = ''> = StructDef<{ '#': 'struct', '#pack'?: number } & M, N>
type UnionOf<M, N extends string = ''> = StructDef<{ '#': 'union', '#pack'?: number } & M, N>
export function struct<const M extends SimpleMember>(member: M, opts?: AggOpts): StructOf<M>
export function struct<const N extends string, const M extends SimpleMember>(name: N, member: M, opts?: AggOpts): StructOf<M, N>
export function struct(a: string | SimpleMember, b?: SimpleMember | AggOpts, c?: AggOpts): any {
    const isNamed = typeof a === 'string'
    const raw = (isNamed ? b : a) as Record<string, unknown>
    const opts = (isNamed ? c : b) as AggOpts | undefined
    return createStruct(buildDecl('struct', raw, opts?.pack))
}

/** 平铺字段表定义联合体；布局/读写与 struct 相同，仅成员偏移重叠。 */
export function union<const M extends SimpleMember>(member: M, opts?: AggOpts): UnionOf<M>
export function union<const N extends string, const M extends SimpleMember>(name: N, member: M, opts?: AggOpts): UnionOf<M, N>
export function union(a: string | SimpleMember, b?: SimpleMember | AggOpts, c?: AggOpts): any {
    const isNamed = typeof a === 'string'
    const raw = (isNamed ? b : a) as Record<string, unknown>
    const opts = (isNamed ? c : b) as AggOpts | undefined
    return createStruct(buildDecl('union', raw, opts?.pack))
}
