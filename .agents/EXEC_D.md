# execd：老系统上的命令执行端

场景：QEMU VM（Windows XP / Win7）里起 `examples/execd.exe`，测试脚本经 HTTP 下发命令并拿回输出。
它是 CI 与本地回归的"执行面"——VM 只负责跑程序，宿主机负责下命令。

相关文档：`docs/qemu-xp-automated-testing.md`（VM 怎么起、测试怎么下发）。

---

## 1. 定位

```
宿主机/容器  ── POST /exec ──►  execd(.tsx)（VM 内 8080）
   http_test.sh                     └─► os.Worker（每请求一个）
   curl                                └─► CreateProcessW + CreatePipe
                                         "system32\cmd.exe /u /c <cmd>"
```

- VM 端口 8080 由 QEMU hostfwd 映射到容器：win7 → `8007`，xp → `8005`，win11 → `8011`
- **一个 `/exec` 请求 = 一个 worker = 一棵进程树**，天然隔离，互不影响（`/screenshot`、`/window_list`、
  `/set_resolution`、`/tray_list`、`/input`、`/upload`、`/download` 是内置端点，主进程同步直跑，不起 worker）
- 命令以 `system32\cmd.exe /u /c <cmd>` 起（**恒加 `/u`**：cmd 内置输出走 UTF-16LE 绕开 ACP 编码有损，
  决策见 `.agents/CMD_ENCODING_ACP_NLS.md` §8），保留 cmd 语义（内部命令、管道、`for`）
- cmd.exe 路径由 worker 内 `GetSystemDirectoryW` 拼接——`CreateProcessW` 直接靠 PATH 解析在本环境失败
- 子进程树由 `CreateProcessW` 返回的 pid 定位，超时/断连时 `taskkill /T` 递归杀掉
- **不产生独立 session**：worker 跑在调用方进程所在的 session 内，`CreateProcessW` 直接起子进程，
  不经 agent 中转。这条对 §3 的"会话隔离"论证很关键

### 底座与体积

用 **nowasm 底座**（`qwin-nowasm[-x86].exe`，不含 WAMR）打包：`execd.js` 运行时只依赖
`os` / `sock` / `std`（GUI 日志窗另引 react-qw，与 WAMR 无关），worker 只 import `os` / `std` / `ffi`。
`BUILD=small` 时点实测（2026-10 上旬，x64 加 GUI 后未重测，勿沿用旧值）：

| 架构 | wasm 底座 | nowasm 底座 | 节省 |
|------|-----------|-------------|------|
| x64  | 1,543,168 | 1,281,536 | 261,632（-16.9%） |
| x86  | 1,562,126 | 1,265,166 | 296,960（-19.0%） |

内嵌 JS 与最终 `execd.exe`（x86，与上表同一份构建）：内嵌 JS（brotli quality 11）143,638 B、
最终 `execd.exe` **1,408,812 B**。

> ⚠️ flavor 存疑：Makefile 里 `BUILD ?= fast`（默认 fast），而本节沿用旧记的 `BUILD=small` 标签。
> `_build/obj/` 只有 `ia32-cross` / `x64-cross[-nowasm]` 这类交叉变体名，**不含 flavor 标记**，
> 无法从产物反推。下次测体积请显式 `BUILD=small make execd` 并记录，避免"flavor 汤"。

> 对比必须在**同一 BUILD flavor** 下做。make 只按源码时间戳判断 `.o` 是否过期，**换 BUILD 不会重编**，
> 本地 `_build/obj/*` 很容易混着不同 flavor 的对象（"flavor 汤"），拿它比体积会得出**相反**结论。
> 跨 flavor 时先 `rm -rf _build/obj/<variant>` 再编。

---

## 2. 接口

### 端点总览

| 端点 | 鉴权 | 说明 |
|------|------|------|
| （任意非 API 路径） | 免 | usage 文本（`HTTP 200`）——兼就绪探测（`run.sh` 轮询 `/`）；`/health` 已非专用端点 |
| `POST /exec` | 需 | 跑命令，流式输出 + trailer 退出码 |
| `POST /spawn` | 需 | 后台进程（脱离请求树）：`{"cmd","cwd"?}` → `{"pid":<cmd.exe>}` |
| `POST /set_resolution` | 需 | 改分辨率 `?w=&h=&persist=0\|1`（默认持久），成功/失败恒带 `modes32` 可用列表 |
| `GET /window_list` | 需 | 列出顶层窗口 `?title=<模糊>&class=<精确>`（由 `/windows` 改名而来，旧名已不存在） |
| `GET /screenshot` | 需 | 截屏 / 抓指定窗口（BMP + `X-Dimensions`，`?hwnd=&area=window\|client&mode=screen\|print`） |
| `GET /tray_list` | 需 | 跨进程枚举托盘图标（可见区 + 折叠区；`?probe=<hwnd>&uid=<n>` 单图标定位，Win7+） |
| `POST /input` | 需 | 批量注入鼠标/键盘事件（JSON 数组） |
| `POST /upload` | 需 | 宿主 → VM 传文件 |
| `GET /download` | 需 | VM → 宿主取文件 |

> 端点语义的**唯一权威是 usage 自描述**：`curl http://127.0.0.1:8007/`（任意非 API 路径）。
> 本表只作导览，新增端点先更新 usage（`main.tsx`），此处可滞后。

### 鉴权

`--token=x` 开启后，**所有 API 路径**（isApi 命中即检查，含上表全部端点）需带
`Authorization: Bearer x`，否则 `401` + `{"error":"unauthorized"}`。
API 之外的任意路径（含 `/`、`/health`、拼错路径/方法）统一返回 usage（`HTTP 200`、
免鉴权、不记日志）——就绪探测即打到这。

- `--token=`（空串）归一为"未配置"，即全部放行——兼容现有 CI 调用
- token 走明文 HTTP（仅 VM 内网），无过期与轮换机制
- GUI 顶栏 info 行显示 `token: on|off`，一眼可确认当前是否开启

### `POST /exec`

请求体：

```json
{ "cmd": "ping -t 127.0.0.1", "timeout": 3000 }
```

- `cmd`（必填）：要执行的命令
- `timeout`（可选，毫秒）：**不传 = 无上限**。只有 `number` 且有限且 `> 0` 才生效

响应：

| 情况 | 结果 |
|------|------|
| 有输出（命令已开跑） | `200`，流式 body，收尾 trailer `X-Exit-Code: <n>` |
| 超时且已有输出 | 同上，`X-Exit-Code: -1` |
| 超时但无任何输出 | `504`（Response 尚未发出，报"exec timeout"） |
| body 非 JSON / 解析失败 | `500`，`{"error":"setup: ..."}` |
| 其他路径 / 方法 | usage（`200`，免 token） |

`Content-Type: application/octet-stream` + `Trailer: X-Exit-Code` 由 http-server 识别为 chunked 帧并补尾。

### `POST /spawn`

后台进程。`/exec` 的响应体就是那根管道：worker 用可继承写端 + `bInheritHandles=TRUE` 起子进程，
树里任何一个还活着的进程都握着写端 → EOF 永不触发 → 响应永不结束。拉常驻 GUI 程序
（demo、被测应用）时 `/exec` 只能挂着客户端干等，且断连会 `taskkill` 掉它。`/spawn` 反着做：
不建管道、`bInheritHandles=FALSE`、`CREATE_NO_WINDOW` —— 请求毫秒级返回，子进程不继承 execd 的
任何句柄（管道 / 监听套接字都不漏），也不受本请求 timeout / 断连牵连。

```json
{ "cmd": "Z:\\quickwin\\app.exe", "cwd": "Z:\\quickwin" }
```

- `cmd`（必填，非空字符串）：命令，恒包 `cmd.exe /u /c`，shell 语义与 `/exec` 一致
- `cwd`（可选字符串）：工作目录；缺省继承 execd 的 cwd（run.bat 下即 `Z:\quickwin`）

响应：

| 情况 | 结果 |
|------|------|
| 成功 | `200`，`{"pid":<cmd.exe 的 pid>}` |
| body 非 JSON / 参数非法 | `400`，`{"error":"..."}` |
| `CreateProcess` 失败 | `500`，`{"error":"spawn: CreateProcess err=<errno> cmd=<完整 cmdline>"}` |

语义要点：

- **pid 是 `cmd.exe`（树根）**，不是被测程序。停止用 `/exec` 跑 `taskkill /F /T /PID <pid>`
  整树收口；不手动收就靠 `./run.sh <vm> --restart` 重建 overlay 清掉。
- **拿不到 stdout，也不回退出码**。两条路：让程序自己写文件（qwin 有 `-o <file>`，
  lanfile 写 `%TEMP%\lanfile.log`），或在命令里自己重定向：

  ```json
  { "cmd": "ping -n 5 127.0.0.1 > C:\\qwtmp\\p.log 2>&1" }
  ```

  `>`、`>>`、`2>&1`、`|`、`%TEMP%` 展开都由 cmd 解析，语义与 `/exec` 里一致；重定向不改变
  「不建管道、`bInheritHandles=FALSE`」这两条，句柄照样不漏。
  **编码跟程序本身有关**：`/u` 只影响 cmd 内建命令（`dir`/`type`）的 UTF-16LE 输出，
  外部程序仍写各自原生编码——实测 Win7 上 `ping -n 3 ... > log` 落盘 **GBK**。
  GUI 程序通常没有 stdout，重定向只会得到空文件。判「跑完没」只能轮询文件或进程。
- **在 `/exec` 里加重定向救不了 hang**：cmd 对常驻子进程无论是否重定向都会等（实测
  `lanfile.exe > log 2>&1` 挂满 30s timeout），而且因为一个字节都到不了管道，超时反而走
  `504 {"error":"exec timeout"}` 且**不带 trailer**，比不重定向更糟。细节见
  `.agents/CONSOLE_STDOUT_MECHANISM.md` §7.6。
- **命令本身失败不体现在 `/spawn` 的返回里** —— `200` 只代表 `cmd.exe` 起来了
  （命令里写了不存在的程序时，cmd 往隐藏控制台打印一行报错后自行退出）。
- 主进程同步直跑（与 `/set_resolution`、`/input` 同列），不进 worker —— 单次 `CreateProcess`，无阻塞。

### `GET /window_list`

列出顶层窗口，`Content-Type: application/json`。主进程同步直跑——枚举毫秒级，bug 当场 `500`，无超时层。

```json
[{ "hwnd": 32768, "title": "execd", "className": "QWindow",
   "rect": { "left": 0, "top": 0, "right": 560, "bottom": 420 },
   "visible": true, "minimized": false }]
```

> 原 `GET /windows` 已改名为 `/window_list`，旧名不存在。

### `GET /screenshot`

返回 `Content-Type: image/bmp`，body 为 BMP 字节，头部 `X-Dimensions: <宽>x<高>`。

| 参数 | 默认 | 取值 |
|------|------|------|
| `hwnd` | 缺省=全屏 | 正整数 |
| `area` | `window` | `window` \| `client` |
| `mode` | 缺省随 `hwnd` 变：带 hwnd=`print`，全屏=`screen` | `screen` \| `print` |

- `hwnd` 缺省时 `area`/`mode` 不影响行为（整屏 BitBlt，没有"让窗口自绘"一说）
- 参数非法 → `400`（`area must be ...` / `hwnd must be a positive integer`）
- 抓取失败（含 0 字节）→ `500`——主进程同步直跑（端到端实测 win7 ~70ms / XP ~300ms），bug 当场暴露，无超时层

这些内置端点是**主进程同步直跑，不进 worker**：bug 当场 throw → 500（有栈有
原因），而非 worker 静默挂掉等 timer 兜底成 504。worker 只留给 `/exec`——外部命令不可
控，popen 读循环阻塞无上界；内置端点耗时有界且低频，主循环阻塞无感。

---

## 3. 选型：为什么不用 sshd

第一反应是"装个 OpenSSH，用 `ssh host 'cmd'` 不就行了"。在老系统上不划算。

### XP 上根本没有现代 sshd

| 来源 | 最低系统 | XP 现状 |
|------|----------|---------|
| 微软官方 OpenSSH（Feature on Demand） | Win10 1809+ / Server 2019+，需 PowerShell 5.1 | 不支持 |
| Cygwin 打包的 OpenSSH（mls-software 维护） | — | XP/2003 最后能跑的是 **OpenSSH 7.3p1-2 (Cygwin 2.5.2)** |
| 同上（Win2000） | — | 最后是 **6.2p2-1 (Cygwin 1.7.18)** |

关键原因：**Cygwin 自 2.5.2 起放弃 XP 支持**，所以 XP 上的 OpenSSH 版本被永久钉在 2016 年的 7.3p1，之后没有安全补丁。
代价还要拖进整套 Cygwin（几十个 MB）+ POSIX 用户体系 + `sshd_config`/host key 配置。

结论：**XP 上装 sshd 可行但技术债很重**；Win7 反而能用现代 OpenSSH。但下面的语义差异对两端都成立。

### SSH 本身没问题，卡的是底座和语义

SSH exec channel 的语义和我们要的完全一致：

- **流式**：stdout / stderr 是两条独立 channel，边产生边传，`ssh host long_cmd | grep x` 能即时过滤
- **退出码**：协议里的 exit-status，客户端 `echo $?` 直接拿
- **断连即终止**：客户端断开 → sshd 收到 channel 关闭 → 杀命令进程
- `-T` 关 pty 给纯数据流；`-t` 开 pty 会包进终端转义序列（注：`ssh -c` 是 cipher，与输出流无关）

差异在最后一点：**SSH exec 是管道语义，拿不到真控制台**。
HTTP 方案下 worker 与子进程都跑在调用方进程所在的 session 内，命令的输出重定向由
`CreateProcessW` + `CreatePipe` 显式指定（`hStdOutput` / `hStdError`），语义确定、不依赖
sshd 的 pty 分配。加上 XP 侧 Cygwin 底座成本，HTTP + 管道更直接。

### 会话隔离：装得上 sshd 也未必能用

上面讲的是"装不装得上"，还有一层更硬的限制——**命令能不能碰到用户桌面**。这一层连"装得上 sshd"都解决不了。

| ssh 用法 | 进程跑在哪个 session | 有用户桌面吗 |
|----------|----------------------|--------------|
| `ssh host 'cmd'`（命令执行） | sshd 以 SYSTEM 身份运行，落在 **Session 0** | ❌ Session 0 无可见桌面 |
| `ssh host`（交互登录） | 微软 Windows OpenSSH 为每次登录**新建一个独立、不可见的 session**，不附着到你现有桌面 | ❌ 新桌面，是空的 |

结果：命令跑起来了，但**看不见用户桌面上开着的窗口**。要进到用户桌面 session 只能绕开 SSH：
`psexec -i -s`（Sysinternals）、计划任务指定已登录用户、`schtasks /run` 跑预建任务，或者直接上 RDP。
WinRM 的命令跑在已登录用户 session 里，但**不支持 XP**。

**实例：给桌面上的某个窗口截图**

这个场景把上面两层限制暴露得最直接：既要能找到窗口，又要在同一桌面里抓像素。

- **找窗口**：`user32.FindWindowW(title)` —— 按标题匹配，与窗口在哪个 session 无关
- **抓像素**，三种方式：

| 方式 | 特点 |
|------|------|
| `GetDC(NULL)` + `BitBlt` | 整屏抓取再按 `GetWindowRect` 裁剪；简单，但要求窗口可见且不被遮挡 |
| `PrintWindow` + `GetWindowDC` | 不要求窗口可见；但 D3D / OpenGL / 部分 UWP 窗体会拿到黑屏 |
| `magicafterburning.ScreenShotter` COM | 现成实现，`AttachToWindow` + `Capture` |

execd 在这里是通的：worker 在**用户桌面 session 内**起 `cmd.exe`
（`worker.ts` 绑定 `kernel32.dll` 的 `createPipe` / `createProcessW`；
纯 kernel32，无 `winpty.dll` / `winpty-agent.exe` 依赖，不经 agent 中转，因此不产生独立 session），
截图脚本与目标窗口同 session，直接可访问。

> 此前这里走的是 winpty（`winpty_spawn` / `winpty_free`）。换成
> `CreateProcessW` + `CreatePipe` 的原因：流式粒度更好——探针实测 XP 上逐行实时到达，
> 而 winpty 攒批约 4s；且少一层 agent 中转。**会话隔离这一层两者等价**，winpty 也不是理由。

QuickWin 侧也不用从零开始：`lib/text-measure.ts` 已经用同一套模式绑 GDI
（`bindLib('user32.dll', { GetDC, ReleaseDC, DrawTextW, ... })`），
加 `PrintWindow` / `BitBlt` / `CreateCompatibleDC` 是同一种扩展。

> **调研附注**：本小节结论基于 Windows 系统行为，未逐字引用微软文档——
> `openssh_dd_config` / `openssh_sshd_configuration` 两个候选 URL 返回 404，会话隔离部分没有官方出处可引。
> 微软官方 OpenSSH 的系统要求（Win10 1809+ / Server 2019+、PowerShell 5.1+）已在上面一节核实过。

---

## 4. 同类方案对比

| 项目 | 形态 | 关键差异 |
|------|------|----------|
| **Docker** `/containers/{id}/exec` | 容器 exec API | 语义标杆：JSON body、流式输出、exit code、**断连即终止**。容器运行时语义，非本机进程 |
| **superserve** `exec` (SSE) | HTTP/SSE | 最接近：流式 stdout/stderr 带 timestamp，收尾事件带 `exit_code`。现代 Linux 生态 |
| **`mdklatt/httpexec`** | Python ASGI REST | **非流式**：等命令跑完一次性 base64 返回。★0 |
| **`hollen9/wpf-remote-execd`** | .NET 4.0.3 | **唯一标称支持 Windows XP**，但只跑"预定义"命令、★0，基本无人用 |
| **`foxhackerzdevs/remote-execd`** | Python | 现代运行时，XP 装不了 |
| **`remote-exec/remote-exec`** | Go | "Invoke commands on remote hosts"，现代 |
| **`harish-ravichandra/RemoteExec`** | web SSH executor | 现代 |
| **`FalconOpsLLC/goexec`** | Go | Windows 远程执行，现代 Windows + SSH/SMB |
| **`tmuxp` REST** | `/sessions/x/windows/y/send-text` | 发完命令再取**快照**，非流式 |
| `hondsh`（Hondshizi）、`netcat-http` | HTTP shell / HTTP-over-TCP | 有交互式 pty / 通道反向；**仅凭记忆，未在线核验** |

结论：**接口范式早已成熟（Docker / superserve 是同一套约定），但"XP/Win7 + 任意命令 + 流式 + 断连即杀"这个组合是空的**。
唯一提到 XP 的那个是 ★0 且功能更弱（预定义命令）。自建不是重复造轮子。

---

## 5. 接口语义决策

### 5.1 为什么用 trailer 送退出码

body 一开跑就开始流，`X-Exit-Code` 只能在响应末尾给。
trailer 是唯一"既能流式、又能带完成态"的 HTTP 机制——不需要等命令结束才能开始读输出。

### 5.2 断连即 kill

以前是"客户端走了还挂到 60s 才杀"。现在断连立即终止子进程树：

- **`lib/abort.ts`**（自建，零依赖）：quickwin 没有 EventTarget/AbortSignal，补一个最小实现
  - `abort()` 在当前调用栈内**同步**派发一次，幂等
  - **迟到监听忽略**：已 aborted 后再 `addEventListener` 是 no-op
  - 因此消费侧的正确模式是**先查 `signal.aborted` 再注册**，而不是靠事件回调兜底
- **http-server**：每请求新建 `AbortController` 注入 `req.signal`；`FD_CLOSE` 或 `send()<0`（RST，FD_CLOSE 可能不及时）→ `abortConn` + `closeConn`；流式写响应时发现断连 → `reader.cancel()` 主动取消响应体
- **execd**：`req.signal` abort → `taskkill /F /T /PID <innerPid>`
  - 三道保险：正常 abort 事件；注册时 `signal.aborted` 预检（断连早于请求到达的情况）；worker 回报 `innerPid` 时若已 aborted 再补刀
  - `stream.cancel()` 兜底（断连发生在数据静默期、`reader.read()` 还挂着的场景）

### 5.3 timeout 可选，默认无限

原本有 `EXEC_TIMEOUT_MS = 60_000` 的绝对上限，一刀切——不管命令死活、不管连接在不在，到点就杀。
这和 shell 语义相悖：**命令活着是常态**，不该凭空被杀。

现在：

- 不传 `timeout` → 不设定时器，**连接活着命令就一直跑**
- 传正数 → 该请求的绝对上限；到点强杀，trailer `X-Exit-Code: -1`
- 需要全局防失控时，把超时值塞进请求即可，不改代码

### 5.4 GUI 日志窗与进程参数

**日志窗默认开**，用 `react-qw` 的 `ListBox` 渲染：

- 顶部 info 行：`token: on|off · port: N · workers: N`（`workers` 是当前活跃 `/exec` worker 数）
- 下方列表：`RequestLog(100)` 保留最近 100 条，格式
  `HH:MM:SS · <cmd> · <结果> (<耗时>ms)`，结果取值 `ok` / `exit N` / `timeout` /
  `unauthorized`
- `scrollToBottom` 自动跟底

![XP 上的 GUI 日志窗，560x420](../docs/images/exec-server-xp-gui.png)

> 图上覆盖了 §5.4 列出的全部结果取值：`ok` / `exit 0` / `exit 7`（非零退出码）/
> `timeout`（`ping -t 127.0.0.1 >nul` 带 `timeout:2000`，无输出 → 504）/ `404`（历史版本；
> 现非 API 路径统一返 usage 且不记日志，不再产生 404 行）。
> 截图命令：`GET /screenshot?hwnd=852200&area=window&mode=print`（`mode=print` 已是带 hwnd 时的默认值，这里显式写出）。
> **print 值得知道**：XP 桌面是 640x480，而窗口 rect 是 (200,200)-(760,620)
> 超出屏幕，`mode=screen` 会被裁成 440x280；`PrintWindow` 让窗口自己渲染到 DC，
> 不受屏幕裁剪影响，能拿全 560x420。

**建窗失败自动回退 headless**，不中断服务（`initGui` 包了 try/catch，失败只打
`[execd] gui init failed` 到 stderr）。XP/Win7 上必须这么兜——CI 无人值守时
建窗失败不该让 8080 挂掉。

**重渲必须离开回调栈**（踩坑点）：react-qw 的 reconciler 是同步 flush，在 HTTP /
worker 回调里直接 `setState` 会与 http-server 的状态机**重入，把事件循环锁死**。
解法是统一丢到 `os.setTimeout(..., 0)` 异步派发，并合并同一 tick 内的多次更新
（`refreshGui()` 里 `if (guiTimer !== null) return` 起到了节流作用）。

**进程参数**：

| 参数 | 含义 |
|------|------|
| `--nogui` | headless，等价于 `--gui=0` |
| `--gui=0` | 同上 |
| `--token=x` | 开启 Bearer 鉴权；**空串归一为未配置**（放行） |

> 参数经 scriptArgs 透传、由 `main.tsx` parseArgs 自行解析：
> `--nogui` 无值开关、`--gui=0`/`--token=x` 等号形式、`--gui 0`/`--token x`
> 空格分隔形式均可。C 层（`src/main.c`）按固定槽位 `[-d] [-o 目标] [-e code | 文件]`
> 消费，槽位之外的一切原样进 scriptArgs；文件槽不收 `-` 开头 token，故
> `--gui` 等服务自有选项放在槽位后天然透传（早期"裸值被 js_file 探测误当
> 脚本名"的问题已随槽位制解析修复）。

**`run.bat` 用 `start /min` 启动**；`initGui` 里以 `ShowWindow(SHOWMINNOACTIVE)` 启动即最小化、
不抢焦点（任务栏保留按钮，CI 截图不受干扰）。

---

## 6. 关键踩坑：64 位句柄 + JS 位运算 mod 32

**现象**：64 位 execd 下，子进程 stdout 全丢——`exit 0` 但 body 空。32 位一切正常。

**根因**：JS 位运算的移位量取 **mod 32**。

64 位下 `STARTUPINFO.hStdOutput` / `hStdError` 是两个 32 位句柄拼成一个数，拼接时用了 `>>> 32`：

```js
>>> 32   // 实际等于 >>> 0 —— 低 32 位被原样搬进高 32 位
```

于是句柄变成 `0x000000f4000000f4` 这种**非法 64 位句柄**，子进程把 stdout 写到不存在的句柄上，
数据静默丢失，且进程退出码照样是 0（不报错）。

**修复**：句柄一律存**两个 u32 字段**（hi / lo 分开读写），不要拼成 64 位数。

教训：JS 里凡是涉及 64 位值（句柄、指针、文件偏移）的拼接/拆分，都要绕开 `>>> 32` 这类写法。

**同一处的连带坑**：`STARTUPINFO` 的布局长度取决于**调用进程位数**，不能看 `os.arch`——
64 位 Win7 上跑 32 位 execd 时 `os.arch` 仍报 `x64`，会误选 64 位布局，
`hStdOutput`/`hStdError` 落在错误偏移，症状同样是 exit 0 但 body 全空。
必须用 `GetSystemInfo`（WOW64 下返回 `INTEL=0`）判定进程视角架构。

---

## 7. 验证方式与结果

> VM 内起 execd（不跑测试），宿主机用 curl / http_test.sh 下发。输出是混合编码：cmd 内置命令
> （echo/dir）= UTF-16LE，外部程序各自原生（qwin= UTF-8、中文系统工具= GBK），宿主按来源转
> （`iconv -f UTF-16LE` / `-f GBK`）。

**断连即 kill**

1. `POST /exec {"cmd":"ping -t 127.0.0.1"}`，客户端 `--max-time 2` 断开
2. 数秒后另起 `POST /exec {"cmd":"tasklist /FI \"IMAGENAME eq ping.exe\""}` → 无匹配 → 子进程已被杀

**timeout 生效**

- `{"cmd":"ping -t 127.0.0.1","timeout":3000}`，客户端不主动断 → **~3.1s** 服务器主动收尾，`200`

**默认无上限（旧 60s 已失效）**

- `{"cmd":"ping -t 127.0.0.1"}` 保持连接，**62s** 时 tasklist 里 `PING.EXE` 仍在；curl 断开后再查 → 已被清理

**回归**（改动 http-server 后必跑，三端 VM：win7 / xp / win11）——**结果以 `http_test.sh` 的
Summary 为准（failed≤1 即 PASS）**，绝对数字随 suite 增减漂移，勿引用旧值。

改动后构建顺序：`make js` → `make execd`（重新 brotli 内嵌），然后 `./run.sh <vm> --restart` 加载新 exe。

---

## 8. 已知缺口与后续方向

### 已解决

- ~~**无 auth**~~ → `--token=x` Bearer 鉴权已实现。残余风险：token 明文过
  HTTP（仅 VM 内网）、无过期与轮换；`--token=` 空串等于放行，CI 调用方需自行确保传入。

### 仍然缺

| 缺口 | 说明 | 风险 |
|------|------|------|
| **无输入校验** | body 非 JSON / `cmd` 非字符串 → 500；**无 body 大小上限** | 超大 payload 会一路读进内存 |
| **无并发上限** | `/exec` 每请求起一个 worker（还带一对管道） | 并发刷进来会一直起进程；GUI 顶栏 `workers` 只是观测，无上限保护 |
| **无自动用例** | 断连 kill 与 timeout 只在 VM 手工验证过 | 改 http-server 可能悄悄回退而无人发现 |
| **`innerPid` 迟到窗口** | 靠 worker `info` 到达后补刀 | worker 完全没起来时仍无兜底 |
| **worker 无显式 close** | 靠消息收尾 | 未验证过回收行为 |

**优先级**：自动用例 > 并发上限 > stdin / 环境变量 / args 数组 > stdout/stderr 分流

- **自动用例**：把上面第 7 节的三条手工步骤写成脚本（断连前后对照 + `timeout:3000` + 65s 长连），挂进 CI
- **并发上限**：加一个简单的信号量或计数上限，超了直接 `503`
- **stdin / args**：对标 httpexec / Docker 的接口面
- **stdout/stderr 分流**：对标 superserve 的双通道 + 时间戳
- **窗口控制**（移动 / 缩放 / 关闭 / 置前）：`/window_list`、`/screenshot`、`/tray_list`、`/input`
  已落地，"找到某个窗口再抓像素/注入输入"这条链已通——这正是 SSH 路径下做不到的部分
  （见第 3 节"会话隔离"）。控制类操作（移动/缩放/置前）在这套端点上扩展即可，
  `lib/text-measure.ts` 已有 GDI 绑定先例，扩展成本低

---

## 附：能力对照（我们 vs Docker）

| 语义 | Docker exec | execd |
|------|-------------|-------------|
| 传命令 | JSON body + tty 标记 | JSON body `{cmd, timeout}` |
| 输出 | 流式 | 流式 |
| 退出码 | 结构化返回 | `X-Exit-Code` trailer |
| 客户端断开 | 终止进程 | 终止进程（`taskkill /T`） |
| 底座 | Linux cgroup | Windows `cmd.exe` + `CreateProcessW` / `CreatePipe` |

约定一致，底座完全不同——这是同一件事在 Windows 老系统上的独立实现。
