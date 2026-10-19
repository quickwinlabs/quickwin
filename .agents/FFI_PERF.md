# FFI `bind()` 调用开销：归因与「bind 期计划表」改造

日期：2026-10-19（squash 为 1 笔合入 main，基线 `1aac1a5`）
环境：win11/win7/XP QEMU（`qwin.exe`），方法学沿 `.agents/SENDMESSAGE_BENCH.md`
（每臂自校准 ~400ms/样本、预热 1、15 轮、臂序轮转、`Date.now()`、median 主指标）。
素材：`test/bench_ffi_overhead.ts`（我方 vs `gui.SendMessage`）、`test/bench_ffi_callraw.ts`
（A bind / B 裸 `ffiCall` / C 裸+每调分配）、`test/bench_ffi_prims.ts`（**本次新增**：QuickJS
侧原语成本表）、`test/bench_nodeffi.mjs`（node:ffi 对照）。均不入 CI。

本节是 `SENDMESSAGE_BENCH.md` 第 3/4 节（node:ffi 同机对比、callPacked 拆层归因）的续篇：
那两节的结论是「JS 层是大头，要打到 μs 以下必须重写 callPacked 本体」。**本次据原语成本表
重写并实测。**

## 结论先行

| 场景（win11 同场 median） | 旧 `callPacked` | 新计划表 | 倍数（按同轮 `gui` 地板归一） |
|---|---:|---:|---:|
| S0 `nop0()` 0 参 void | 3404 ns | **895 ns** | 2.8× |
| S1 `nop1(1)` 1×i32 | 7107 ns | **1519 ns** | 3.5× |
| S2 `GetCurrentProcessId()` | 3904 ns | **1235 ns** | 2.3× |
| S3 `SendMessageW` 4 参全链 | 36094 ns | **3444 ns** | 7.7× |
| （同轮 `gui.SendMessage` C 直调地板） | 258 ns | 191 ns | — |

- **单次调用成本 90% 以上是「每调重跑 token 正则 + 字符串分派 + 每调分配」**，与 C 侧、
  与 `ffiCall` 桩无关（裸 `ffiCall` 地板 0.14~0.74 μs，`gui` 纯 C 直调 0.2 μs）。
- 归因的关键发现：**在 QuickJS 里一次 `String.test()`/`exec()` 要 0.5~2 μs、一次字符串
  相等比较 ~100 ns**。旧 `callPacked` 每调、每参数都在做这些（`isCPtrToken`/`ptrName`/
  `endsWith`/`writeSlot` 的 token switch），4 参就是 ~10 次正则 + ~40 次字符串比较。
- 消除方式是把「签名 → 槽偏移/写器/返回读法」在 `bind()` 期算成固定表（`CallPlan`），
  call 期只剩「取值 → 写槽 → `ffiCall` → 读返回」，**对外 API、语义、错误文案零变化**。
- 剩余空间：每调仍有 3~4 次堆分配（~0.5 μs）与若干闭包调用；第 5 节给出候选与预期。

## 1. 旧实现每调做了什么（静态归因）

`bind()` 本身（`parseSig` + `loadDll` + `GetProcAddress`）是**一次性**成本，与下面的账无关。
每调（旧 `callPacked`，`lib/ffi/bind.ts` 改前版本）要付：

| # | 操作 | 位置（旧） |
|---|---|---|
| 1 | rest 参数数组 `(...a)` 本身 | `makeFn` 返回的箭头函数 |
| 2 | 每调新建 `getWidth`/`widthOf` 两个闭包 | 旧 `:141`/`:154` |
| 3 | 每 token 跑正则：`isCPtrToken`（`.test`）、`isCValToken`、`ptrName`/`valName`（`.exec`，每次分配 match 数组）、`endsWith('!')` | 参数循环 |
| 4 | 槽宽/偏移重算（含 `os.arch` 属性读） | `:168-170` |
| 5 | `new ArrayBuffer(total)` + `new DataView` + `held = []` | `:172-174` |
| 6 | 每参数一个 `{ k, v }` 对象字面量喂 `writeSlot`，`writeSlot` 内再按 token 字符串 switch | `:190/:218/:247/:251` |
| 7 | `new ArrayBuffer(8)` 返回槽 + `readRet` 内再 `new DataView` | `:256/:279` |
| 8 | 返回位再跑一遍 `isCPtrToken`/`ptrName` + `endsWith('!')` | `:261-267` |

## 2. 原语成本表（`test/bench_ffi_prims.ts`，win11 x64，单位 ns，扣 noop 闭包地板 122 ns）

| 原语 | 净成本 | 原语 | 净成本 |
|---|---:|---|---:|
| `isCPtrToken('<HWND>ptr!')`（`.test`） | **553** | `writeSlot(dv,0,{k:'ptr',v})` | **1485** |
| `isCValToken('<RECT>')` | 398 | `writeSlot(dv,0,{k:'i32',v})` | 1000 |
| `ptrName('<HWND>ptr!')`（`.exec`+解构） | **516** | `readRet(ptr)`（含 `new DataView`） | 804 |
| `normToken('i32')` | 1202 | `os.arch === 'x64'` 属性读 | 66 |
| `normToken('u32@WmMsg')` | 2010 | `new ArrayBuffer(32)` | 205 |
| `strings.endsWith('!')` | 105 | `new ArrayBuffer(8)` | 168 |
| `(...a)` 4 参调用 vs 固定 4 形参 | 191 vs 79 | `new DataView(ab)` | 194 |
| 闭包调用 `f(1)` | 72 | `{k,v}` 对象字面量本身 | 172 |
| `[1,2,3,4]` 字面量 | 118 | `held.push(buf)` | 164 |

外推校验（4 参 ptr 签名）：4×(553+105+516+1485) ≈ 10.6 μs，加返回侧 ~1.9 μs 与分配
~0.4 μs ≈ 13 μs——与旧 S3（同轮 36 μs，含 VM 漂移）量级吻合，**矛头确认在正则与
`writeSlot` 字符串分派**。

## 3. 新实现：bind 期算好的调用计划（`CallPlan`）

```ts
type SlotWriter = (dv: DataView, frame: ArrayBuffer, arg: any) => ArrayBuffer | undefined
type CallPlan = { total: number; slots: SlotWriter[]; retIsFp: boolean; read: (b: ArrayBuffer) => unknown }
```

- `buildPlan(ps, encoders, decoders)`：bind 期按 token 分派一次，产出
  - `slots[i]`：闭包化的槽写器，**token 已定型**（`i32` 就是一条 `setUint32`，ptr 位是
    `typeof arg === 'number'` 快通道 + codec 编码通道），偏移闭包捕获；
  - `total`：帧字节数（含 x64 头 4 槽补零）；
  - `retIsFp` + `read`：返回位读法固化（含 `!` 非空执法与品牌 decode）。
- `callPlan(proc, plan, args)`：每调只剩 `new ArrayBuffer(total)` + `new DataView` →
  逐槽 `slots[i](dv, frame, args[i])` → `new ArrayBuffer(8)` → `ffiCall` → `read`。
  `held`（codec 编码缓冲）改为按需分配，且**必须在 `read` 之后再松手**（decode 可能顺着
  回传指针读 caller 缓冲）。
- 语义保持：懒校验（未注册布局的 `<NOPE>ptr` 仍只在调用时抛）、所有错误文案逐字不变、
  `!` 执法不变、ia32 槽宽规则不变（`IS64` 提到模块级常量）。

## 4. 实测对照（win11 同场）

`bench_ffi_overhead`（median / min，ns）：

| 场景 | 旧 median | 原型 median | 最终 median | 最终 min | 同轮 gui |
|---|---:|---:|---:|---:|---:|
| S0 0 参 void | 3404 | 1162 | **895** | 890 | — |
| S1 1×i32 | 7107 | 2304 | **1519** | 1428 | — |
| S2 `GetCurrentProcessId` | 3904 | 2041 | **1235** | 1177 | — |
| S3 4 参 | 36094 | 4974 | **3444** | 3038 | 191 |

（「原型」= 只做计划表、返回位仍走 `readScalar`；「最终」= 再补 `RET_READER`。
S2 是 0 参 u32 返回，比 S0 的差值 ~340 ns 正是返槽 `DataView`+读回+闭包的钱。）

`bench_ffi_callraw`（median，A=bind 全链 / B=裸 `ffiCall`，同一轮内可比）：

| 场景 | 旧 A | 旧 B | 最终 A | 最终 B | 旧 A/B | 最终 A/B |
|---|---:|---:|---:|---:|---:|---:|
| S0 | 4200 | 143 | 1120 | 127 | 29.5× | **8.9×** |
| S1 | 8424 | 420 | 1560 | 281 | 20.1× | **5.6×** |
| S2 | 8764 | 472 | 1391 | 229 | 18.6× | **6.1×** |
| S3 | 30578 | 1084 | 3192 | 705 | 28.2× | **4.5×** |

**Caveat**：两轮相隔 ~1 小时，VM 整体漂移（同轮 `gui` 地板 258→191、裸 `ffiCall`
地板 143→127）——跨轮只认「同轮归一化」：按 `gui` 地板归一得 2.3~7.7×，按裸
`ffiCall` 归一得 3.1~6.2×，两个独立归一器一致。**绝对 ns 跨轮不可比，倍数可信。**

定稿（删掉一行无作用的 `held.length = 0`、尾读收成直接 `return`）后同机复测：
min **863.5 / 1404.0 / 1139.3 / 2961.0**、median 949.9 / 1722.5 / 1480.5 / 3836.0
（同轮 `gui` 215.8）——与上表同档；这两处只去掉一次比较和一条 return 语句。

测试（**最终产物**三平台实跑）：win11 全量新旧均 **1350/1355**（余 5 个失败为窗口枚举
集合、打印作业、psapi 路径的环境性问题，与本次改动无关——旧代码同机复测同样 1350/1355）；
FFI 套件全绿（ffi-bind 95/95、ffi-struct 194/194、ffi-struct-layout 148/148、ffi-array
49/49、ffi-abi 42/42、ffi-windows 56/56）。win7（x64，`qwin.exe`）**1355/1355**、
XP（ia32，`qwin-x86.exe`）**1324/1324**——两平台均与历史基线一致，ia32 的槽宽/指针
分支（`IS64`、`PTR_SIZE`）验证通过。

## 5. 残余成本与已否掉的候选（扩展原语表）

第二轮原语表（每臂自校准批量；本轮机况更快，noop 地板 81 ns，只看净值）：

| 原语 | 净成本 | 含义 |
|---|---:|---|
| `dv.setUint32` ×1 / ×2 | 79 / 157 | 每次 DataView 写 ~78 ns |
| `BigInt(v)` / `BigInt.asUintN(64,b)` / `setBigUint64(bi)` | 77 / 168 / 82 | BigInt 单步都不贵 |
| `wPtr-old` = `asUintN(64,BigInt(v))`+`setBigUint64` | **234** | 现状 |
| `wPtr-2x32` = 两条 `setUint32` + `Math.floor(v/2³²)` | **290** | ❌ 比 BigInt 版还慢（除法），**不做** |
| `read-bi`（`getBigInt64`+`Number`） | 113 | 现状 |
| `read-2x32`（两条读 + 乘） | 157 | ❌ 更慢，**不做** |
| `readScalar(new DataView, 0, 'ptr')`（**旧**返回路径） | **691** | ✅ 大头：`readScalar` 的 token 字符串 switch ≈ 0.5μs/call |
| `slot-loop-4`（4 槽写器循环 + held 检查） | 1258 | 新版每调主体 |
| `typof-num` / `endsWith('!')` | 47 / 98 | 值类型判断便宜，字符串操作贵 |

同轮追加的「`held` 恒分配空数组」对照（第四轮，noop 地板 99 ns，机况比第二轮慢 ~20%）：

| 对照 | 净值 | 差值 |
|---|---:|---:|
| `arr-lit-0`（`[]` + `length`） | 66.6 | — |
| `held-lazy0` / `held-alw0`（无 codec 参） | 43.0 / 97.5 | **54.5** |
| `held-lazy1` / `held-alw1`（有 codec 参） | 153.4 / 249.8 | **96.4** |

→ `held` 保持懒分配；恒分配是纯亏，且有 codec 参时亏得更多（`[]`+`push` 比 `[h]`
字面量多一次容量增长）。占 S0 895 ns 约 5~6%，不是原先估的 10%。

两条结论：

1. **BigInt 不是问题**（单步 77~234 ns），我原先「BigInt 分配 ~1μs、应改两段 32 位」的
   猜测被实测否掉——两条 `setUint32` 的除法开销反而更贵。指针位保持 BigInt 写法，
   但 `BigInt.asUintN` 也多余（QuickJS 的 `setBigUint64` 自身按 ToBigUint64 取模，
   `-1n` 不抛错），现在只留 `BigInt(v)`——QuickJS 只收 BigInt，传 number 才 TypeError。
   同理 `setUint32/setUint8…` 前的 `>>> 0` / `Number()` 全部删掉（内部即
   ToUint32/ToNumber，逐位等价；唯一差异是给 32 位槽塞 BigInt 从静默截断变 TypeError）。
2. **「按 token 字符串分派」是唯一贯穿始终的昂贵模式**：旧 `writeSlot` 1179 ns 里真正
   写指针只占 234；旧返回路径 691 ns 里真正读指针只占 113。所以修法统一是「把分派
   提到 bind 期」：参数位 → `SlotWriter`，返回位 → `RET_READER`（新增，本机 ~0.5μs/call）。

新版 0 参 ~0.9 μs（同轮裸 `ffiCall` 0.13 μs）的构成（按原语表近似）：
`argFrame`+`DataView` 0.34 与返回位 `ArrayBuffer`+`DataView`+读回 0.45 **均已摘掉**（见下），
余下 ≈ rest 数组 0.17 + 闭包调用 0.05 + 裸 `ffiCall` 0.13。`RET_READER` 这一步单独贡献
S0 1162→895（−23%）、S2 2041→1235（−40%，0 参 u32 返回最吃这条路）。

实测追加：**复用参数帧 + 共享返回槽**（本报告采用的最终形态）——每调 4 次分配
（帧 `ArrayBuffer`+`DataView`、返回 `ArrayBuffer`+`DataView`）全部归零。

- **参数帧**：每个 `bind` 出来的函数首调分配一次 `DataView`（帧 = `dv.buffer`，长度恰为
  `total`，C 侧 `af_size` 自动正确），其后**原样重用、不逐调清零**。依据：签名固定 ⇒ 每个
  槽写器每调写入的字节区间恒定（`setUint32` 恒 4 字节、`setBigUint64`/`writePtr` 恒 8 字节、
  按值结构恒 `size` 字节），所以首分配的零填充——0 参时补齐到 4 槽的整块、`u8/u16/u32` 占的
  8 字节槽高位、ia32 结构体的 `ALIGN(size,4)` 填充——**永不被踩**，被写的字节每调被完整覆盖。
- **返回槽**：全部函数共用一个 8 字节缓冲 + 一个 `DataView`。依据是"读原子"：两个桩都在
  `call` **之后**才写 `out`（win64 `quickjs-ffi-call-win64.S:115/118`、ia32 `:96/:104-105`），
  而 JS 在 `ffiCall` 返回后立刻由 `RET_READER` 读——C 侧桩后直接 `return JS_UNDEFINED`，
  JS 侧 `DataView` 构造 + 普通对象取属性 + 内建 getter 全程无 hook，中间插不进用户代码
  （`decode` 在 `raw` 取出之后）。于是每一层"自己的桩写 → 自己的立即读"都是 LIFO 闭合的：
  native 期间回调重入即使写了同一块缓冲，外层读到的仍是本层自己的返回值。
- **唯一没覆盖的窗口**是"写槽期间的重入"（自定义 codec 的 `encode` 里回调已 bind 的函数，
  会在本层 `ffiCall` 之前抹掉已写槽）→ 按契约处理：`bind()` jsdoc 已写明 codec 的
  encode/decode 内不得回调已 bind 的函数，且 `encode(v, buf, off)` 必须写满槽宽。

同机交错 A/B（A=新形态 n=4、B=stash 回基线 n=2；该组 `gui` 地板 162.0 vs 160.6，机况等同）：

| 场景 | 基线 min（均） | 新形态 min（均） | 差 |
|---|---:|---:|---:|
| S0 0 参 void | 899.6（913.9） | **531.1**（563.8） | −368（**−41%**） |
| S1 1×i32 | 1410.0（1415.5） | **900.0**（957.1） | −510（**−36%**） |
| S2 `GetCurrentProcessId` | 1181.1（1224.9） | **695.4**（710.0） | −486（**−41%**） |
| S3 4 参 | 2662.5（2693.8） | **2082.0**（2173.3） | −580（**−22%**） |

分布完全分离（新形态最差 600.9 < 基线最好 899.6）。正确性不变：两平台 FFI 子集逐项一致
（win11 610 ok/2 已知失败、XP 608 ok/0 fail，含 ia32 按值结构体路径）；三平台全量亦与基线
一致（win11 1350/1355 = 同 5 个环境性失败、win7 1355/1355、XP 1324/1324）。

同轮收尾实测（提交后 `bench_ffi_callraw`，A=bind 全链 / B=裸 `ffiCall` / C=裸调用+那 4 次分配，
min）：A/B = **5.0× / 3.6× / 3.9× / 3.3×**（S0..S3，median 同向 5.0/3.6/4.2/3.1×），
对照「计划表 + `RET_READER`、每调仍 4 次分配」那版（8.9×/5.6×/6.1×/4.5×，median）。另两个坐标说明分配之外还剩什么：
A−B = 435 ns（S0），而 A−C 只有 **71 ns**（S1 是 217 ns）——全链已贴在「裸调用 + 那 4 次分配」
之上，其余是槽循环与 wrapper 调用。

**squash 合入 main 后复测**（`50f67cb`，2026-10-19）：S0–S3 median **530.1 / 1051.6 / 774.9 /
2142.2 ns**、min **515.9 / 893.2 / 685.7 / 2060.2 ns**，与上表同档（这轮机况略快 ~5%：`gui`
地板 166.2 / 153.0，上次 165.0 / 160.9）；同轮 `bench_ffi_callraw` A/B（min）= **5.06× / 3.67× /
3.81× / 3.39×**，拆分同向：`C−B`（旧形态那 4 次分配）= 414.9 ns、`A−C`（我们这层）= 62.9 ns（S0）。

未做的候选（留给后续，风险见右）：

| 候选 | 预期收益 | 风险 |
|---|---:|---|
| 元数/签名特化 wrapper（node:ffi 7 ns 参照） | 到 sub-μs | 需代码生成，复杂度高、可读性代价大 |

## 6. 对调用点的含义（更新 2026-10-07 节）

- 热循环仍然应走 C 直调（`gui.*`）：ListView per-item 全用 `gui.SendMessage`；
  209 处 `bind()` 绑定集中在 react-qw 非热路径与 PathPicker/PdfCanvas/pdf_preview2，
  **无 per-pixel/per-item 的 bind 调用**——改造后 4 参 **2.1~2.2 μs**（旧 36 μs），
  相对 10-07 的 10.7 μs 已减到五分之一，`gui` 与 FFI 的差距从 ~85× 降到 **~13×**
  （同轮 median 2142 vs 166 ns）。判据不变：只有 10 万+/秒级同一调用点才需要保留 C 直调。
- **但这个「倍数」必须和消息本身一起读：差距是固定的 ~2 µs，不是乘数。** 同轮
  `bench_ffi_overhead` 用同一个自有 STATIC 窗口发三种消息（2026-10-19 复测，median / min，ns）：

  | `SendMessageW` 消息（同窗口、同轮） | FFI `bind()` 全链 | `gui` 直调 | 倍数 |
  |---|---:|---:|---:|
  | `WM_NULL`（handler 基本空转） | 2142 / 2060 | 166 / 153 | 12.9× / 13.5× |
  | `WM_GETTEXT`（handler 拷 128 B 进 caller 缓冲） | 2303 / 2144 | 172 / 165 | 13.4× / 13.0× |
  | `WM_SETTEXT`（handler 真重排/重画，native ~83 µs） | 83400 / 74200 | 82600 / 72500 | **1.01× / 1.02×** |

  第三行说明一切：native 一旦真花时间，我们多的那 ~1.7 µs 就被淹没；第二行是边界反例——
  128 B 拷贝只值 ~25 ns，还看不出收敛。所以「13×」只在**发一条几乎免费的消息**时成立，
  绝对差恒为「裸 `ffiCall` ~0.66 µs（QuickJS↔C 边界 + 汇编桩）+ 我们这层 ~1.5 µs（rest 数组、
  逐槽写、返回读取）」。
- string lParam 场景 FFI 仍然反超（`WCHAR.encode` 比 gui C 侧全量编码便宜），不受影响。

## 7. 与 node:ffi 的现状对比（同场复测，2026-10-19）

node:ffi（Node v26.10.0，同一底层 libffi）多次复测很稳（0 参 7.0~7.7、1 参 13.6~15.8 ns，
S3 199~263 ns）。本节为**背靠背同场**：node 侧 `bench_nodeffi` 与 `bench_ffi_overhead`
相隔 33 秒、裸桩 `bench_ffi_callraw` 再 82 秒（日志 mtime 05:12:05Z / 05:12:38Z /
05:14:00Z）。

| 场景（win11，ns/call） | node:ffi median | 我们 median | 我们 min | 我们 / node |
|---|---:|---:|---:|---:|
| S0 `nop0()` 0 参 void | 7.1 | 1239 | **894** | 175× / **126×** |
| S1 `nop1(1)` 1×i32 | 13.6 | 2078 | **1425** | 153× / **105×** |
| S2 `GetCurrentProcessId()` | 7.7 | 1450 | **1181** | 188× / **153×** |
| S3 `SendMessageW` 4 参 | 262.5 | 3800 | **3025** | 14.5× / **11.5×** |
| （参照）裸 `ffiCall`（帧复用 + 最小写读） | — | 143 | 107 | — |
| （参照）`gui.SendMessage` C 直调地板 | — | 184 | 155 | — |

同场两法互校：`bench_ffi_callraw` 的 A 臂（就是新的 bind 全链）S0 = 914/850，与上表
min 吻合——**median 可抖 ±35%、min 稳**，所以跨轮只认 min 和同轮臂间比（与第 4 节同规则）。

三点读数：

1. **地板在运行时层级**：把 JS 层剥到最干净的裸 `ffiCall`（帧复用 + 每调 4 次最小写读 +
   汇编桩 + QuickJS C 函数边界）也是 0 参 107~143 ns，而 node:ffi 的 7.1 ns 是 V8
   intrinsic + fast trampoline。**即 JS 层做到极致也只剩 ~15~20×**，这段不是本次能动的。
2. **S3 只剩 ~12×**：node 的 262.5 ns 几乎全是真实的 `SendMessageW` 分发（同场 C 直调
   地板 184 ns，V8 全链在它之上只加 ~80 ns）；我方 3025 ns = 同一份真实分发
   + ~2.9 μs 自家链路（4 槽写 + 返槽读 + 帧/视图分配 + rest 数组）。
3. **倍数收窄**：与本节同场的 node 基准相比，现在 0~1 参 ~105~126×、S3 ~11.5×；
   旧 `callPacked` 在同会话早期（S0 3404/S1 7107/S2 3904/S3 36094，同轮 gui 地板 258）
   对应的量级约 340~500× 与 ~98×（按 gui 近似归一）——即 **0 参收窄 ~3 倍、S3 收窄
   ~8 倍**。`gui` 是纯 C 路径、对 JS 重路径不是好归一器，这一条只看量级。

实际含义：node:ffi 在 QuickJS 里不可用，本节只用来标定「JS 层还剩多少空间」；对真实
负载（UI 消息每帧几十次）3.0 μs 与 0.26 μs 都无感，本次收益的价值在热循环/批量调用。


## 可复现

```sh
podman exec quickwin-dev bash -lc 'cd /workspace && make js'

# 发 bench：端口（win11=8011 / win7=8007 qwin.exe / xp=8005 qwin-x86.exe，32 位！）只在
# 容器网络可达 —— curl 必须在容器里发。body 落文件再 --data 最稳（见教训最后一条）：
podman exec quickwin-dev bash -lc 'cd /workspace && curl -sS -m 900 -X POST \
  http://127.0.0.1:8011/exec -H "Content-Type: application/json" \
  --data @_build/exec_body_overhead.json'
# bench_ffi_overhead.js → _build/bench_ffi_overhead_log.txt（~65s；S0–S5 + gui 地板）
# bench_ffi_callraw.js  → _build/bench_ffi_callraw_log.txt（~50s；A/B/C 拆层）
# bench_ffi_prims.js    → _build/bench_ffi_prims_log.txt（原语成本表）
# 三者 body 见 _build/exec_body_{overhead,callraw,prims}.json；日志均落宿主 _build/

# node:ffi 对照（同场）：Node zip 在 _build/，nop.dll 在 _build/test/
podman exec quickwin-dev bash -lc 'cd /workspace && curl -sS -m 900 -X POST \
  http://127.0.0.1:8011/exec -H "Content-Type: application/json" \
  --data @_build/exec_body_node.json'
# 日志：_build/bench_nodeffi_log.txt
```

## 教训（VM 基准本身的坑，2026-10-19）

- **XP 必须用 32 位 exe**：`qwin.exe` 是 x64，喂给 32 位 XP 会弹
  「`Z:\quickwin\qwin.exe` 不是有效的 Win32 应用程序」模态框，且**无人点时 exec
  永久挂起**（queue 堵死，后续所有 /exec 排队超时，看起来像"卡住"）。
  正确命令是 `qwin-x86.exe`（`make cc32` 产物），`docker/http_test.sh` 已按 VM
  选 exe，手写 /exec 时要自己选对。
- **对话框在看不清时先截图**：execd 的 `/screenshot` 是 BMP，容器里没有
  PIL/ImageMagick——用 `/tmp/opencode/bmp2png.py`（纯 stdlib zlib）转 PNG 后
  可直接看窗口文字，比猜按钮位置快得多。
- **别信"窗口在屏幕上的样子"**：`#32770` 那个窗口被 execd 的 GUI 窗口压着，
  按坐标点击全打在 GUI 上（监控循环空转了 178 次）；`/window_list` 给的 rect
  是窗口自身矩形，不等于它在屏幕上可见/可点。
- **容器里没有 `procps`**（`ps`/`pkill` 都没有）：清理挂住的 curl/监控循环要
  自己扫 `/proc/*/cmdline` 再 `kill`（`kill` 是 bash 内建），匹配模式用
  `[c]url` 这类方括号写法避免误杀自己。
- **JSON body 别用 shell heredoc 写**：`\\` 会被上层（工具调用/shell 参数）先解码一次，
  落盘成了单反斜杠，JSON 再把 `\n` 解成换行——cmd 收到断成两截的命令，只回一句
  「不是内部或外部命令」（UTF-16LE 乱码）。用编辑器/write 工具直接落文件，写完
  `python3 -c "import json;print(json.load(open(f))['cmd'])"` 验一遍再发。反斜杠能免就免。
