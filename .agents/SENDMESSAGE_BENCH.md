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
