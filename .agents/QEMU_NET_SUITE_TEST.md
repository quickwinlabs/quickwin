# QEMU Win7 客机逐 suite 测试记录

场景：本地容器 qwa（quickwin-ci-test3）内跑 QEMU Win7 VM，guest 内 `qwin.exe test\run.js`。

## 目的

定位完整 `run.js`（不带 `-net`）在 `ipv6` suite 后 exec_server 失联的问题——逐个 net suite 跑，
找出哪个 suite 会导致 exec_server / VM 无响应。

## 环境前置（每次 VM 启动后需就绪）

- host(容器)`serve_test`：`node tools/serve_test.ts 18923`，监听 `::`（dual-stack）
- guest `portproxy`：`netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=18923 connectaddress=10.0.2.2 connectport=18923`
- `iphlpsvc`：快照中已是 RUNNING

> 注意：portproxy 规则保存在 overlay（win7_test.qcow2）中，`run.sh --fresh` 重建 overlay 后会丢失，
> 需通过 `docker/ci_share/run.bat` 每次启动时重建（已实现）。

## 结果汇总

| suite | tag | 结果 | 备注 |
|-------|-----|------|------|
| basic-fetch | - | PASS 4/4 | 依赖 serve_test+portproxy，原 273/274 失败项 |
| -net 全量 | 非 net | PASS 277/277 | 方案 B 后验收基线 |
| ipv6 | net | **HANG(exec_server)** | 完整 run 首个断点，跑两次均卡死 exec_server |
| **ipv6(win7, v6tov4后)** | net | ✅ **13/13 PASS** | 2026-09-20 补 v6tov4 转发后验证通过，不再挂 |
| net-fetch | net | PASS 50/50 | 需同时转发 18923+18924；最初 48/49 因未转 18924 的 https 失败 |
| net-websocket | net | PASS 15/15 | |
| net-event | net | PASS 2/2 | |
| http-server | net | PASS 18/18 | |
| http-import | net | PASS 6/6 | 外网 esm.sh 可达（2.37s） |
| fetch-cache | net | PASS 39/39 | |
| worker-http | net | PASS 6/6 | |
| worker-fetch | net | PASS 2/2 | |
| **全量 `-skip-ipv6`** | 全部 | **PASS 415/415** | 排除 ipv6 后完整跑，所有独立+集成都过，exec_server 不挂 |
| **全量 `run.js`(含ipv6)** | 全部 | **427/428** | v6tov4 修复后全量不挂；唯一失败 ffi OOM（win7 有真实打印机） |

## 时间线 / 日志

- 2026-09-20 07:4x —— VM 多次启动。非 `--fresh` 后台启动偶发 QEMU 静默退死（overlay 残留锁）。
  `run.sh --fresh` 干净：重建 overlay + 起 QEMU + 等 run.bat 触发，exec_server 约 10s 就绪。
- `-net` 全量 277/277 PASS（basic-fetch 4/4）。
- ipv6 suite 单独跑：exec_server 失联（`curl :8080/exec` 无响应），QEMU 仍存活。复现两次。
  推断：ipv6 suite 中某个 socket/连接路径使 guest 端 exec_server 挂起，或令 SLIRP 转发打糊。
- 2026-09-20 08:06 —— `--fresh` 干净启动，run.bat 的 portproxy 自动生效（18923）。
- 08:0x —— 逐 suite 测试：net-fetch 需 18924 转发（https），补后 50/50；
  其余 net-websocket/net-event/http-server/http-import/fetch-cache/worker-http/worker-fetch 全 PASS。
  仅 ipv6 卡死。**注意** nohup + `&` 在 podman exec 下会随 shell 退出被回收，须用 `podman exec -d` 跑 run.sh。
- 09:28 —— win7 run.bat 补 v6tov4 后 ipv6 suite 13/13 PASS；全量 run.js（含 ipv6）427/428，
  唯一失败 ffi OOM（EnumPrintersW 后 GC=777MB）。根因：test_ffi.ts `decodeWideAtPtr` 读到
  PRINTER_INFO 结构的垃圾 WCHAR 指针时无限循环（`js_ffi_read_byte` 越界返回垃圾字节，遇不到 `\0`），
  chars 数组无限增长 → OOM。win7 有 2 台真实打印机触发（XP 无打印机走 skip），属 test 代码 bug 非运行时问题。

## XP (feat/win32-xp) 逐 suite 测试记录

### XP 环境说明
- 宿主端口 **5180** → 客机 8080（win7 用 7080；NT 5.1=XP / 7=Win7 助记，docker/run.sh hostfwd。原为 8081，已改）
- XP **有 `netsh interface portproxy`**（需先 `netsh interface ipv6 install`，XP 由 IPV6MON.DLL 实现）。
  listenaddress 用 `0.0.0.0`（127.0.0.1 在 XP 上不生效）。
- ~~run.bat 直接跑测试（不依赖 exec_server，XP 上 exec_server 处理带反斜杠命令后会挂起）~~
  **2026-09-23 实测证伪**：常驻 exec_server + JSON `{"cmd":...}` 对带反斜杠命令
  （`dir Z:\quickwin` 等）全部正常返回 `{out,code}`，无挂起。见下方「反斜杠传闻复核」。
- XP 快照：`xp_ready.qcow2`，1G 内存 1CPU。

### XP 逐 suite 结果（32 位 qwin.exe，2026-09-20）

### XP 完整 `-net` = **274/275**（~40s 跑完，进程正常退出）
| suite | 结果 | 备注 |
|-------|------|------|
| basic | PASS 1/1 | |
| basic-fetch | PASS 4/4 | **portproxy 生效后**（127.0.0.1+localhost 均 200） |
| url | PASS 79/79 | |
| wasm-basic | PASS 20/20 | |
| wasm-types | PASS 41/41 | |
| wasm-import-global | PASS 6/6 | |
| wasm-sjlj | PASS 18/18 | |
| wasm-frame-encoding | PASS 26/26 | |
| mupdf-wasm | PASS 7/7 | |
| mupdf-twice | PASS 0/0 | 无 example.pdf |
| mupdf-render | PASS 0/0 | 无 example.pdf |
| ffi | **2/3 FAIL** | EnumPrintersW pcbNeeded=0（XP 无打印机），环境差异 |
| polyfill | PASS 58/58 | |
| brotli | PASS 5/5 | |
| worker | PASS 2/2 | 完整跑时不挂（单独跑 worker 时曾有退出挂起） |
| worker-wasm | PASS 5/5 | |

### 关键发现
- ~~exp_server 单独跑（带反斜杠命令）会挂起~~ → **2026-09-23 证伪**（见反斜杠复核）。
- worker 单独跑曾遇进程退出挂起 + 时钟显示负数（32 位 Date.now 溢出）；full -net 中正常。
- net-fetch 在 portproxy 未配时挂起（localhost 连不上）；配好后应可过（完整 -net 不含 net suites，待测）。

### 构建（32 位 / XP）
- 清 wolfssl/brotli/libffi 的 64 位产物后 `make cc32` 成功：
  PE32 i386 console, DLL 全为 XP 可用（无 KERNELBASE/UCRT），导入表无
  AcquireSRWLock/inet_pton/SetProcessDPIAware（WAMR/wolfSSL XP 补丁生效）。
- distclean 会清 _build JS 产物，需重跑 `make js` 和 `make wasm`。

### 反斜杠传闻复核（2026-09-23，XP 实测）

原记录（L60/L86）称「exec_server 处理带反斜杠命令后会挂起」，仅有一句话无复现步骤。
在常驻模式 XP 上（hostfwd :5180，容器内 curl）四条对照实测：

| 用例 | body | 结果 |
|------|------|------|
| 无反斜杠 | `echo hello` | `{"out":"hello\n","code":0}` ~20ms |
| JSON 转义反斜杠 | `dir Z:\\quickwin` | 正常目录列表 `code:0` ~17ms |
| 正斜杠路径 | `dir Z:/quickwin` | `out:"" code:1`（cmd `dir` 本身不认 `/`，预期） |
| exit code | `cmd /c exit 7` | `code:7`（pclose 取到 exit code） |
| 非法 JSON 转义 | `dir Z:\quickwin`（未转义） | HTTP 500，**不是挂起** |
| 健康检查 | 跑完后 GET /health | 始终 `ok` |

**结论：反斜杠挂起传闻不成立。** 疑为早期裸文本协议 + 同步 popen 阻塞事件循环
导致健康检查超时被误诊为「挂死」。新 JSON 协议 + `http_test.sh` 超时 300s 覆盖同步阻塞。

另：`dir Z:/quickwin` 失败是 cmd.exe 行为（`/` 被当开关），不是 exec_server 问题；
调用方应使用反斜杠路径。

### 关键发现（XP 全量经 HTTP，2026-09-23）
- 常驻 exec_server 下 `./http_test.sh xp` 全量：**Summary 425/426**（failed=1 = ffi 打印机环境差，容忍）。
- 与 run.bat 直跑基线 425/426 一致。

### XP net suites（portproxy 就绪后，2026-09-20）
| suite | tag | 结果 | 备注 |
|-------|-----|------|------|
| net-fetch | net | **PASS 50/50** | portproxy 生效，原挂死问题消失 |
| net-event | net | PASS 2/2 | |
| http-server | net | PASS 18/18 | |
| http-import | net | PASS 6/6 | |
| fetch-cache | net | PASS 39/39 | |
| worker-http | net | PASS 6/6 | |
| worker-fetch | net | PASS 2/2 | |
| net-websocket | net | **HANG** | 卡在 "invalid URL" 用例（WebSocket error 输出后 onclose/timer4 未触发，finishTest 未执行） |
| ipv6 | net | ✅ **13/13 PASS** | **加 v6tov4 portproxy 后恢复**（`listenaddress=::` → `10.0.2.2`） |

### ipv6 套件挂起根因（已证实，非猜测）
- serve_test 监听 `::`（dual-stack，IPv4+IPv6 都收）。
- 之前只配 `v4tov4`：guest 的 `::1` IPv6 loopback 无监听，连 `::1:18923` 落入无声黑洞 → 挂起。
- 加 `v6tov4 listenaddress=:: listenport=18923/18924 connectaddress=10.0.2.2` 后 ipv6 套件 13/13 通过。
- **结论：portproxy 必须同时配 v4tov4 + v6tov4**（已固化进 docker/ci_share/run.bat，按系统分支执行）。
- win7 的 run.bat 目前只有 v4tov4，其 ipv6 套件预计同样因缺 v6tov4 而挂。

### 挂起本质解析（重要）
- **ipv6/无效URL的"挂起"不是进程死锁**：runner（run.ts:65-76）逐 suite `await mod.suite.run(t)`，
  **没有 per-suite 超时**，某用例 Promise 永不 resolve → suite 永远不结束 → 后续 suite 全被堵住。
  事件循环仍在跑，只是测试推进不了。
- ipv6 挂起点是 `connect('::1:18923')` 异步模型（quickjs-sock.c:351, `WSAEventSelect`）：
  非阻塞 connect 返回 WSAEWOULDBLOCK 后等 FD_CONNECT 事件回调；IPv6 loopback 无监听（黑洞），
  失败回调未正确触达 JS 层 → `reject()` 永不执行。且 raw socket 用例无超时保护（test_ipv6.ts:30-60），
  故 fail 变 hang。v6tov4 转发恢复 = connect 成功回调即走通。
- net-websocket invalid URL 属**另一种**挂起：纯 JS 解析错误不触网，疑 `os.setTimeout(3000)` 兜底
  timer 在 XP 32 位时钟下未触发。未深入调查（用户要求先只记录）。

### 挂起根因调查（老，保留）
- net-websocket invalid URL 用例：与 IPv6 转发**无关**（`not-a-websocket` 是纯 JS URL 解析错误，不触网）。
  `_fireError` 只 console.error + dispatch error，`onclose` 依赖后续 `_setState(CLOSED)` → dispatch close，
  但日志停在 error 后 → 疑 3s `timer4` 兜底未触发（XP 32 位时钟问题）。未深入调查（用户要求先只记录）。

## 结论待定

- 9 个 net suite 中 **8 个独立跑全部通过**（net-fetch 50/50, net-websocket 15/15, net-event 2/2,
  http-server 18/18, http-import 6/6, fetch-cache 39/39, worker-http 6/6, worker-fetch 2/2），
  仅 `ipv6` 单独跑即卡死 exec_server。
- **完整 `run.js -skip-ipv6` = 415/415 PASS**：排除 ipv6 后全量（含所有 net 套件）一次通过，
  exec_server 不挂。确认整套的唯一断点就是 ipv6 suite。
- test/run.ts 已给 ipv6 临时加 `skip-ipv6` tag 用于排查（待用户决定去留）。
- 待办：
  - 排查 ipv6 卡死根因（sock IPv6 后端问题或 serve_test 对 ::1/WS 的处理）。
  - ipv6 属 net 标签，CI 走 `-net` 时本身不跑，不影响 CI 全绿。
  - run.bat 的 portproxy 需涵盖 18923+18924（net-fetch https 依赖 18924），已改。可重启 VM 验证 run.bat 自动建全。
  - 若让 CI 全量跑（无 -net），需先解决 ipv6 卡死。**已解决**：run.bat 配 v6tov4（win7+XP 均已固化）。
- **新失败项**：win7 全量时 ffi OOM（EnumPrintersW 打印循环读坏指针）。待修 test_ffi.ts（加读到长度上限保护）。