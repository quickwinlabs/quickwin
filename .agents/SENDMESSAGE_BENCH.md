# gui.SendMessage vs FFI bind SendMessage 性能对比

日期：2026-10-07 分支：feat/ffi-ctype-ir 环境：win7 QEMU（qwin.exe x64）、
`test/bench_sendmessage.ts`（esbuild 打 bundle 后经 /exec 直跑，不入 CI）。

## 结论先行

| 场景 | gui.SendMessage（C 直调） | FFI bind SendMessageW | ffi/gui |
|---|---|---|---|
| S1 WM_NULL 纯数字 lParam | **126 ns/次** | 10,700 ns/次 | 84.9x 慢 |
| S2 WM_SETTEXT 字符串 lParam（FFI 侧含 `WCHAR.encode`） | 85,500 ns/次 | **22,780 ns/次** | **0.27x（FFI 快 3.7 倍）** |
| S3 WM_GETTEXT 缓冲出参往返（两侧 JS 实参完全相同） | **186 ns/次** | 11,950 ns/次 | 64.3x 慢 |

- 纯调用链开销：FFI 比 gui 慢约 **10~12 μs/次**（恒定增量，与消息/参数几乎无关）。
- 但 string lParam 场景 **FFI 反超**：gui 的 C 侧 string 分支每次全量 JS string→wide 编码
  单次 85 μs，FFI 侧 `WCHAR.encode`(~12 μs) + 调用(10.7 μs) 合计仅 22.8 μs。
- 绝对量级：10 μs 级差距在 UI 消息频率（每帧几十次）下完全无感；只有单循环
  10 万+ 次/秒的高频发消息才需要在意，这种热点应保留 `gui.SendMessage`。

## 测量方法

- 消息全部发给**自有 STATIC 窗**（直调 wndproc，排除跨进程消息经纪干扰；
  跨进程 SendMessage 单次几十 μs 且是两供建共模，不作测点）。
- 每场景预热 1 轮 + 5 轮计数（S2 为 3 轮），**奇偶交叉起跑顺序**抵消温度/调度漂移，
  取各自最小值；`Date.now()` 计时；S1/S3 每轮 500k 次，S2 每轮 50k 次。
- 两侧入口均提为常量（`gSM = gui.SendMessage` / `fSM = SendMessage`），循环内
  属性查找开销对齐；`WM_SETTEXT` 的 FFI 侧把 `WCHAR.encode` 放在循环内——这是
  任务 3 迁移后调用点的真实写法。
- 每轮原始数据（ms）：

```
S1: gui=78 78 78 78 63        ffi=5788 5944 5397 6084 5350
S2: gui=5569 5803 4275        ffi=1139 1326 1419
S3: gui=94 94 93 109 94       ffi=6037 6412 5975 6552 7067
```

## 差距归因（lib/ffi/bind.ts）

`parseSig` 只在 `makeFn` 工厂解析一次（签名有缓存），**不是**每次调用解析。
每次 `callPacked` 的 JS 层成本：

1. `new ArrayBuffer(argFrame)` + `new DataView` + `new ArrayBuffer(retBuf)`——3 次堆分配；
2. 每参数一个 `{ k, v }` 字面量临时对象（SendMessage 4 参 = 4 个）；
3. `getWidth` 闭包每 call 重建；
4. QuickJS 解释器执行 `callPacked` 大函数（循环 + 分支 + writeSlot）。

以上合计 ≈ 10 μs。gui 侧是纯 C 函数入口（argc 检查 + 整数提取）≈ 76 ns，
差值即 JS 解释 + 堆分配成本。**若未来要优化，方向是 argFrame 复用、writeSlot
去对象字面量、getWidth 提为模块级**——预估可压到 1~2 μs/次（未实测）。

S2 的 85 μs 反常项：gui 侧 C 的 string lParam 分支每次全量编码（无缓存），
单次成本远超 FFI 调用本身——**string 场景迁 FFI 是净收益**。

## 对任务 3（SendMessage 61 处迁移）的含义

- react-qw 实际调用都是低频 UI 消息（挂 tooltip、取子项状态等，< 千次/秒）：
  10 μs/次的增量**无实际影响**，迁移可行性不受性能制约。
- string lParam 调用点（如 WM_SETTEXT 类）迁移后**反而快 ~3.7 倍**。
- 例外：若某调用点在热循环里发 10 万+ 次/秒（当前 61 处中未发现），保留
  `gui.SendMessage` 或先做 callPacked 优化再迁。

## 可复现

```sh
# 打 bundle（对齐 build.ts 的 external 列表）
npx esbuild test/bench_sendmessage.ts --bundle --format=esm --tree-shaking \
  --external:gui --external:os --external:std --external:sock --external:brotli \
  --external:ffi --external:wamr --external:win --external:tls --external:wolfssl \
  --external:../lib/polyfill.js --external:../vendor/mupdf-wasm/mupdf.js \
  --external:../vendor/mupdf-wasm/mupdf-wasm.js \
  --outfile=_build/test/bench_sendmessage.js --log-level=warning
# VM 内跑（exec 串行；输出在进程退出后一次性返回，期间 /exec 阻塞）
curl -sS -m 300 -X POST http://127.0.0.1:8007/exec \
  -H 'Content-Type: application/json' \
  --data '{"cmd":"qwin.exe test/bench_sendmessage.js"}'
```

## 过程教训（bench 本身的坑）

- **别跨进程发消息**：第一版 S1 用 `GetDesktopWindow()`，单次几十 μs（消息经纪
  托管），1M×6 轮超 300 s，把 exec 串行队列堵死。
- **别在紧循环里无节制分配**：S2 第一版 500k/轮，`WCHAR.encode` 每次
  TextEncoder+ArrayBuffer 分配引发 QuickJS GC 抖动，单迭代涨到 ~380 μs、单轮
  190 s+；降到 50k/轮后恢复正常量级（GC: size=346782 只在启动时打了一行）。
- **别留活窗**：脚本结束不 `DestroyWindow` + `std.exit` 会让 qwin 驻留消息循环
  等窗口关闭，exec 永不回包（输出缓冲到进程退出才返回，中途看不到任何东西）。
- **exec 是串行队列**：一个命令卡住，后续所有 /exec 全部排队超时；恢复只能
  `./run.sh <vm> --restart`。
- 挂了靠**文件日志**定位：`std.open('bench_log.txt','w')` + 每步 `flush`，
  cwd=Z:\quickwin 即宿主 `_build/bench_log.txt`，可在 curl 超时后仍读到卡点。

---

## 追加：`!` 非空标注的调用时检验成本（2026-10-08）

同环境（win7 QEMU、自有 STATIC 窗、`Date.now()`），`test/bench_sendmessage_nonnull.ts`
（`make js` 产出、不入 CI、不入 esbuild entries）。同一 `SendMessageW` 绑多份签名，
**唯一变量是 `!`**：

| 臂 | 签名 | 相对 A1 多做的事 |
|---|---|---|
| A1 | `<HWND>ptr u32 <>ptr <>ptr -> <>ptr` | —（基线） |
| A2 | 同 A1 再独立绑一次 | 无（A/A 对照 = 机器噪声底） |
| B | `<HWND>ptr! u32 <>ptr <>ptr -> <>ptr` | 参数位 `arg === 0` 检查 |
| C | `<HWND>ptr! u32 <>ptr <>ptr -> <>ptr!` | 参数位 + 返回位 `raw === 0` 检查 |

C 臂先用 A1 探各场景原始返回值再决定入列（返回 0 撞 `!` 会 throw）：实测
S1 WM_NULL=0（DefWindowProc 预期）→ C 不进 S1 是设计而非缺测；S2 WM_SETTEXT=1、
S3 WM_GETTEXT=1 → C 正常入列。

### 结论

- **单次 0 检查 = 10.45 ns**（S0 微基准：1e8 次循环，唯一差异 `flag && i === 0`
  短路与否；5 轮 median check 49.92 / base 39.47 ns/op，轮间 gap 稳定 0.9~1.1 s/1e8）。
- 推到调用层：**B ≈ +10 ns/次、C ≈ +21 ns/次**，占 12~13 μs 调用的
  **0.08% / 0.16%**——低于 FFI 层任何可测噪声，**调用层不可测**（四轮 FFI 实测
  delta 符号翻转、幅度随机，见下表）。
- `endsWith('!')` 是**共模**：A1/A2 臂同样每 token 每调用无条件执行；`!` 的真正
  边际只有非短路时的一次整数 `===` 比较 + 分支（微基准对照与此精确对应）。
- bundle：执法代码（endsWith + throw 分支）**无条件**进包（不标 `!` 也编译，
  这是 `!` 的实现方式本身），标注边际 = 签名字符串字面量字节（lib 内 35 处
  `ptr!` ≈ +35 B）；exec_worker data URL 前后均为 34760 不变（bench 不入 bundle）。
- 未测：struct decode 的 `f.nonnull` 检验（`lib/ffi/struct.ts`）、closure 检验——
  本次只测 bind 调用位（参数位 + 返回位）。绝对量级比 10-07 略高（时段/宿主
  负载差异），本实验只认臂间对照。

### FFI 层四轮迭代（为什么最终改用微基准）

| 轮 | 方法 | 观测 | 诊断 |
|---|---|---|---|
| 1 | 500k×5 轮取 min | S1 B-A=-64 ns；S3 B=-62/C=-30（B/C "更快"） | B 活严格更多却更快 → ±400~900 ns/call 调度噪声 ≫ 10 ns 效应 |
| 2 | 同上，加 median | S1 min +1062 / median +248；S3 median 反向 | S2 min 被 GC 离群轮污染（A 有一 1045 ms 离群）；**C（检查更多）反而比 B 快**，方向自相矛盾 |
| 3 | 50k×30 轮 + A/A 对照 | S1/S3 全臂 delta=0.0（含 A2-A1） | 假完美 = 量化：1 ms ÷ 50k = **20 ns/call 步长 ≥ 预测效应**，全撞同一桶 |
| 4 | + S0 微基准 | 稳定测出 10.45 ns | ✅ 把 `!` 检验从 ffiCall/调度噪声里剥离，一轮拿到稳定数 |

噪声底（A2-A1）：S1/S3 ≈ 0（量化主导，±0~150 ns；run4 S1 的 B min=+20 ns 恰为
一格量化、方向与预测一致，但单独不足为证）；**S2 单臂自身 min 与 median 可差
1500+ ns**（run4 A2 median -320、C median +1540 却 min -320）——`WCHAR.encode`
GC 主导，该场景臂间比较无意义。

### 可复现

```sh
# 前置：win7 已起（docker/ ./run.sh win7 --restart）
make js    # tsc 产出 _build/test/bench_sendmessage_nonnull.js（不入 esbuild entries）
curl -sS -m 600 -X POST http://127.0.0.1:8007/exec \
  -H 'Content-Type: application/json' \
  --data '{"cmd":"qwin.exe test/bench_sendmessage_nonnull.js"}'
# 文件日志：宿主 _build/bench_nonnull_log.txt（exec 输出在进程退出后一次性返回）
```

### 教训（追加）

- **先摆 A/A 对照再解读**：同签名绑两次的差值就是噪声底；效应没过对照带、
  或出现"检查更多的臂反而更快"，一律判噪声。
- **先算量化步长**：`Date.now()` ms 粒度 ÷ 批量 = 分辨率下限；50k 批量 =
  20 ns/call，10 ns 级效应必然全撞桶（表现为"全臂 delta=0.0"的假完美）。
- **被噪声盖住就别在噪声里捞**：FFI 层三轮互相矛盾后停止调参，改微基准直接量
  边际操作成本，再按调用结构外推。

---

## 追加：bind() vs node:ffi 同机调用开销对比（2026-10-08）

环境：**win11 QEMU**（Node 26 跑不了 win7，故整场换机；10-07/10-08 前两节的
win7 数据不与本节跨比）、Node v26.10.0 portable zip（解压进 `_build/`，
VM 内路径 `Z:\quickwin\node-v26.10.0-win-x64\node.exe`）。素材三个新文件
（均不入 CI）：`test/bench_ffi_overhead.ts`（我方侧，`make js` 产出）、
`test/bench_nodeffi.mjs`（node 侧，拷入 `_build/test/`）、`test/nop.c` →
mingw 交叉编译 `_build/test/nop.dll`（`nop0:void`/`nop1:int` 两个空导出）。

`node:ffi`：Node v26.1.0 起的实验模块（`import ffi from 'node:ffi'`），底层
**同样是 libffi**，v26.10 免 `--experimental-ffi`（仅 ExperimentalWarning）。
Win64 fast path 上限总参 ≤3：nop/pid 走 fast trampoline，`SendMessageW`（4 参）
回落 generic——两条路径本场都测到了。

### 方法（两侧同构）

- 四场景：S0 `nop0()` 0参 void（纯 JS→C 往返）/ S1 `nop1(1)` 1×i32（单标量封送）/
  S2 `GetCurrentProcessId()` 0参真实 API / S3 `SendMessageW` WM_NULL 自有 STATIC 窗
  （完整链路；我方侧加 `gui.SendMessage` C 直调地板参照）。
- **每臂自校准批量**：探针逐级放大 n0 至 dt≥20ms（`Date.now()` 1ms 量化步长 ≤5%），
  按目标 ~400ms 定批量——跨运行时单次成本差 3 个量级，固定批量必有一侧撞量化墙。
- 预热 1 + 15 轮 + 臂序轮转 + median 主指标/min；两侧循环体同形态（函数先取到
  局部 `const f`，结果不消费——QuickJS 解释器与 V8 均不消除 native 调用）。
- node 侧窗口：STATIC 预定义类免 RegisterClass，但 **`node:ffi` 的 `'string'` 是
  UTF-8 临时副本，对 `*W` API 必须传 utf16le `Buffer` 作 `'pointer'` 实参**。
- 日志：`_build/bench_ffi_overhead_log.txt`、`_build/bench_nodeffi_log.txt`。

### 结果（median，ns/call，win11 同场）

| 场景 | 我们 bind() | node:ffi | 倍数 |
|---|---:|---:|---:|
| S0 `nop0()` 0参 void | 2527.0 | **7.1** | ×356 |
| S1 `nop1(1)` 1×i32 | 4784.0 | **15.2** | ×315 |
| S2 `GetCurrentProcessId()` | 3262.5 | **7.7** | ×424 |
| S3 `SendMessageW` WM_NULL（完整链路） | 14590.5 | **199.5** | ×73 |
| （参照）`gui.SendMessage` C 直调 | 189.1 | — | 地板 |

### 解读

- **trampoline 不是瓶颈**：node:ffi 的 S3 同样走 libffi generic path，199.5ns ≈
  gui C 直调地板 189.1ns——整个 JS→native→JS 往返只比纯 C 直调多 ~10ns。
- **我们的 73~424× 全在自家链路**：S0 零参零返回也要 2.5μs 起步（callPacked 每调用
  `new ArrayBuffer`+`new DataView`+闭包，再进 `ffiCall`——归因臂未测，嫌疑就这两层）。
- 编码边际离谱：0参void 2527 → 0参u32返回 3262（返回读 +0.7μs）→ 1×i32 4784
  （**1 个 int 参数 +2.3μs**）；S3 全链 14.6μs。
- S3 的 14.6μs（win11）与 10-07 的 10.7μs（win7）是跨机数，只看同场臂间对照。
- 优化方向由本节量化：node:ffi 证明 7~200ns/call 可达；我方先做 argFrame 复用、
  writeSlot 去对象字面量、getWidth 提模块级（10-07 节已预判，本节证明不是徒劳）。

### Caveat

- 循环开销：QuickJS 解释 ~40ns/op（10-08 微基准）vs V8 ns 级——对本表我方 μs 级
  可忽略，占 node 7.1ns 的小头（±2~3ns），不改结论量级。
- node 探针冷测比热态慢 8×（S0 探针 56ns → 实测 7.1ns，V8 尚未优化调用点），
  实际样本 49~412ms 短于 400ms 目标，量化仍 ≤2%；nop0/pid 返回值虽不消费，
  但 nop1(15.2) vs nop0(7.1) 的差异证明 native 调用真实在执行。

### 可复现

```sh
# 前置：Node zip 已入 _build（curl -fL -o _build/node-v26.10.0-win-x64.zip
#   https://nodejs.org/dist/v26.10.0/node-v26.10.0-win-x64.zip && unzip 进 _build/）
podman exec quickwin-dev bash -lc \
  'cd /workspace && x86_64-w64-mingw32-gcc -shared -O2 -o _build/test/nop.dll test/nop.c'
make js && cp test/bench_nodeffi.mjs _build/test/
cd docker && ./run.sh win11 --restart
# JSON body 落文件再 --data @file（cmd 含反斜杠，多层引号嵌套必翻车）：
#   {"cmd":"node-v26.10.0-win-x64\\node.exe test\\bench_nodeffi.mjs","timeout":600000}
#   {"cmd":"qwin.exe test\\bench_ffi_overhead.js","timeout":600000}
# hostfwd:8011 只在容器网络里，curl 必须 podman exec 进容器执行
podman exec quickwin-dev curl -sS -m 600 -X POST http://127.0.0.1:8011/exec \
  -H 'Content-Type: application/json' --data @/workspace/_build/exec_body.json
./run.sh win11 --stop
```

### 教训（追加 2）

- **跨运行时对比必须每臂自校准批量**：V8 冷热差 8× 会把探针和稳态测到两个世界；
  探针只负责找"≥20ms 不撞量化墙"的下限，别拿探针均值当性能。
- **W API 是 UTF-16**：node:ffi 的自动 string 转换是 UTF-8，给 `*W` 函数传
  `'string'` 会按错编码读——必须 utf16le Buffer 传 `'pointer'`。
- **`CreateWindowExW` 是 12 参**：类型表少写一个当场 `ERR_INVALID_ARG_COUNT`——
  签名声明类错误在首次调用即炸，探针先行比跑完 15 轮再发现便宜。

---

## 追加：callPacked 归因——直调 `ffi.ffiCall` 拆层（2026-10-09）

上节结论「瓶颈在自家 callPacked + ffiCall，归因臂未测」的补测：绕过 `callPacked`
直驱 `ffi.ffiCall(func, argFrame, retBuf, retIsFp)`（4 参预打包签名，`retBuf≥8`），
同 proc 同帧布局，唯一变量是**每次调用经过哪些层**。`test/bench_ffi_callraw.ts`
（不入 CI），win11 同场、同自校准批量 + 15 轮 median 方法学。

| 臂 | 每次调用经过的层 |
|---|---|
| A bind | rest 参数 + `callPacked` 全链（每调 argFrame/DataView/retBuf/readRet-dv 分配、`getWidth` 闭包、`writeSlot` 对象字面量、`ffiCall`、`readRet`） |
| B raw | 帧复用 + 每调最小写槽/读返 + `ffiCall` → native 桩 + QuickJS C 函数边界 |
| C raw-alloc | B + 每调 `new ArrayBuffer(32)`+`DataView`+`ArrayBuffer(8)`+读返 `new DataView`（复刻 callPacked 分配面），仅 S0/S1 |

帧约定：x64 argFrame 恒 32B（4×8 槽，桩无条件读 slots[0..3]）、retBuf 8B；
S1/S2/S3 各臂消费返回值到 `sink`（同口径防 DCE 疑虑，收尾打印证活，实测 610 亿）。

### 结果（median，ns/call）

| 场景 | A bind 全链 | B 裸 ffiCall | C 裸+每调分配 |
|---|---:|---:|---:|
| S0 `nop0()` 0参 void | 2587.5 | **141.4** | 577.5 |
| S1 `nop1(1)` 1×i32 | 4450.5 | **306.0** | 842.4 |
| S2 `GetCurrentProcessId()` | 2950.8 | **231.3** | — |
| S3 `SendMessageW` 4参完整链路 | 13284.1 | **740.3** | — |

分层（S0/S1 三臂精确切）：

| 层 | S0 | S1 | 占比 |
|---|---:|---:|---|
| B native 桩 + C 边界 | 141 ns | 306 ns | 5~7% |
| C−B 每调分配（ArrayBuffer×2 + DataView） | 436 ns | 536 ns | ~17% |
| A−C **callPacked JS 层其余** | 2010 ns | 3608 ns | **78~81%** |

### 解读

- **native 桩不是问题**：裸 `ffiCall`（汇编桩，libffi 已移出构建）0 参 141ns；
  S3 的 B=740ns 含 4 槽写 + 返回读 + 真实分发（gui 纯分发地板 189ns）→ 桩本体
  ~100ns 级。即便如此仍比 node:ffi 的 7.1ns 慢 20×——差在 QuickJS C 函数边界
  vs V8 intrinsic，属运行时层级，不是本次主矛。
- **JS 层是大头且按参数放大**：0 参 JS 层 2.0μs → 4 参 ~12μs（S3 的 90%），
  每参数边际 ~1.6~2.5μs——`writeSlot` 的 `{k,v}` 对象字面量、`getWidth` 闭包、
  `isCPtrToken/endsWith` 字符串分支在 QuickJS 解释器里的账。
- **优化预估修正**（10-07 节「复用 argFrame 等可压到 1~2μs」）：只复用帧（C 臂）
  仅省 436~536ns；**要打到 μs 以下必须重写 callPacked 本体**（去对象字面量、
  去闭包、标量快路径），或走签名特化 wrapper（node:ffi 7.1ns 参照）。
- A 臂与 10-08 overhead 场交叉验证一致（2587/2527、4450/4784、2951/3262、
  13284/14590），跨运行稳定。

### 可复现

```sh
make js    # tsc 产出 _build/test/bench_ffi_callraw.js
# win11 已起，JSON body 落文件（同上节方式）：
#   {"cmd":"qwin.exe test\\bench_ffi_callraw.js","timeout":600000}
podman exec quickwin-dev curl -sS -m 600 -X POST http://127.0.0.1:8011/exec \
  -H 'Content-Type: application/json' --data @/workspace/_build/exec_body.json
# 文件日志：宿主 _build/bench_ffi_callraw_log.txt
```

### 教训（追加 3）

- **模块 import 别与局部变量同名**：`import * as win from 'win'` 之后又写
  `const win: gui.HWND`，整个模块作用域被 HWND 遮蔽，`win.LoadLibrary` 报
  「Property does not exist on type 'HWND'」——句柄一律叫 `hwnd`。
