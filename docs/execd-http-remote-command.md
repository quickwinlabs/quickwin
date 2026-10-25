# 通过 HTTP 远程运行 Windows 命令：一个 1.5MB 的 exe，从 XP 到 Win11

之前用 [QEMU 搭建 Windows 自动化测试环境](qemu-xp-automated-testing.md) 这套流程，每次编译出新 exe 就从快照启动，跑完测试关机。每次都得重启一遍虚拟机，**启动加测试约 30-60 秒**，大部分时间花在等系统起来上。

所以优化了一下方案：**在 VM 里常驻一个 HTTP 服务，专门用来执行命令**。宿主机随时 POST 一条命令过去，输出流式回来，不用为了跑个测试再重启一次。

## 简介

这个服务是 `execd`，它监听 8080 端口，收到 HTTP 请求，解析出要运行的命令，在本机运行，把输出通过 HTTP 返回。它是一个 exe，体积约 1.5MB，用 [QuickWin](https://github.com/quickwinlabs/quickwin) 开发，Windows XP 到 Windows 11 都能跑。

链路很短：

```
外部程序
      │  POST /exec {cmd: "dir"}
      ▼
execd.exe  (VM 内 8080)
      │  os.Worker（每请求一个）
      ▼
CreateProcessW + CreatePipe
      │
      ▼
system32\cmd.exe /u /c <cmd>
```

### 设计要点

**`/exec` 一请求 = 一个 worker = 一棵进程树。** 每请求起一个独立 worker，用 `CreateProcessW` + `CreatePipe` 拉起子进程。互不影响，上一条崩了不拖累下一条。`/screenshot`、`/window_list`、`/set_resolution`、`/tray_list`、`/input`、`/upload`、`/download`、`/spawn` 是内置端点，主进程同步直跑，不起 worker。

**用 cmd.exe 而不是 `CreateProcessW` 直接跑目标程序**，是为了保留 cmd 语义——内部命令（`dir`、`ver`）、管道重定向、`for` 循环都能原样用。恒加 `/u`：cmd 内置命令的输出直接走 UTF-16LE，绕开按系统代码页（ACP）编码造成的中文丢失（XP/Win7 中文系统 GBK、英文精简镜像 1252 都不再影响输出）。

**不产生独立 session。** worker 跑在调用方进程所在的 session 内，`CreateProcessW` 直接起子进程。这条在下面「为什么不用 SSH」里是关键。

**启动即最小化。** GUI 日志窗默认开着（顶栏 `token: on|off · port: N · workers: N`，下面是最近 100 条请求记录），但以不抢焦点的方式最小化启动，自动化截图与前台窗口不受干扰；headless 场景用 `--nogui`（等价 `--gui=0`）关掉。

### 进程参数

| 参数 | 作用 |
|------|------|
| `--nogui` / `--gui=0` | 无 GUI 模式（默认开日志窗，最小化启动） |
| `--token=x` | 开启 Bearer 鉴权（空串 = 未配置，全部放行） |

## 为什么不用 SSH

最直接的原因：**XP 上没有可用的现代 sshd**。就算硬塞一个老版本，Windows 7 上能装的 sshd 版本也很老，配置也很麻烦。

最实际的一层是**会话隔离**。

这是 Windows 上绕不开的坑。sshd 是 Windows 服务，跑在 session 0，而 **session 0 没有交互式桌面**——没有窗口站、没有可见 GUI。sshd 装上了、能登录、能执行命令，但没法看到或操作那个 session 里的窗口。

`execd` 不起独立 session，运行在桌面的 session 里，所以没有这层隔阂——`/window_list` 列出顶层窗口、`/screenshot` 抓指定窗口像素，这条链在 SSH 路径下走不通，在 execd 下是通的。

## 原理与使用

### 端点

| 端点 | 鉴权 | 说明 |
|------|------|------|
| （任意非 API 路径） | 免 | usage 文本（`HTTP 200`），VM 就绪探测用（`/health` 已非专用端点） |
| `POST /exec` | 需 | 跑命令，流式输出 + trailer 退出码 |
| `POST /spawn` | 需 | 后台进程（脱离请求树），返回 `{"pid"}` |
| `POST /set_resolution` | 需 | 改分辨率 `?w=&h=&persist=0\|1`，恒带 `modes32` 可用列表 |
| `GET /window_list` | 需 | 列出顶层窗口 `?title=<模糊>&class=<精确>` |
| `GET /screenshot` | 需 | 截屏 / 抓指定窗口 |

> 完整端点清单（另有 `/tray_list`、`/input`、`/upload`、`/download` 等）以服务自描述为准：
> `curl http://127.0.0.1:<port>/`（任意非 API 路径）即返回全部端点与参数。

鉴权用 `--token=x` 开启，命令是标准 Bearer：`Authorization: Bearer x`，不带或不对就 `401` + `{"error":"unauthorized"}`。

API 之外的任意路径（含 `/` 和 `/health`）始终返回 usage 并免鉴权——VM 刚起来的时候就要探活，这时候还没法保证 token 配好了。`--token=`（空串）会被归一成「未配置」即全部放行，方便兼容 CI 里已有的调用方式。

### 跑命令

最简形式，POST 一个 JSON 就行：

```bash
curl -X POST http://127.0.0.1:8005/exec \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"ver"}'
```

```plain
Microsoft Windows [版本 5.1.2600]
```

带超时和 token：

```bash
curl -X POST http://127.0.0.1:8005/exec \
  -H 'Authorization: Bearer s3cret' \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"ping -t 127.0.0.1","timeout":3000}'
```

端口说明：VM 内的 8080 由 QEMU 的 hostfwd 映射到宿主机。下面例子用 XP 的 8005，Windows 7 是 8007。

### 起后台进程

`/exec` 是「一请求 = 一棵进程树」，响应体就是那根管道的流：进程不死，响应就不结束。所以要拉常驻程序
（GUI demo、被测应用），`/exec` 只能挂着客户端干等，而且断连会把进程 `taskkill` 掉。`/spawn` 就是为这个场景做的：
不建管道、子进程不继承任何句柄，请求毫秒级返回，进程脱离请求树独立存活。

```bash
curl -s -X POST http://127.0.0.1:8007/spawn \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"Z:\\quickwin\\app.exe"}'
```

```plain
{"pid":1844}
```

- `pid` 是 `cmd.exe`（进程树根），不是被测程序本身。停止：用 `/exec` 跑
  `taskkill /F /T /PID 1844`。不手动收，就靠 `./run.sh <vm> --restart` 重建 overlay 清掉。
- 可选 `cwd` 指定工作目录，缺省继承 execd 的 cwd（`Z:\quickwin`）。
- 命令本身失败不会体现在返回里 —— `200` 只代表 `cmd.exe` 起来了。
- 配合 `/window_list` + `/screenshot` + `/input`，就是完整的「拉起 → 观察 → 点击 → 收尾」循环。

#### 要留输出

`/spawn` 不给 stdout 流，也不回退出码。要留输出就在命令里自己重定向（由 cmd 解析），事后再取：

```bash
curl -s -X POST http://127.0.0.1:8007/spawn \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"ping -n 5 127.0.0.1 > C:\\qwtmp\\p.log 2>&1"}'

# 取日志（也可以 /exec 跑 type C:\qwtmp\p.log）
curl -s "http://127.0.0.1:8007/download?path=C:\\qwtmp\\p.log" -o p.log
```

- 编码跟程序本身有关：`/u` 只影响 cmd 内建命令（`dir`/`type`），外部程序仍写各自原生编码
  —— Win7 上实测 `ping` 落盘 **GBK**，别默认按 UTF-8 解。
- GUI 程序通常没有 stdout，重定向只会得到空文件；那种情况用程序自己的输出参数（qwin 有 `-o <file>`）。
- cmd 会等到子进程退出，所以 pid 一直有效；判「跑完没」只能轮询文件或进程。

**在 `/exec` 里加 `>` 解决不了「挂住」**：cmd 对常驻子进程无论是否重定向都会等，照样挂到超时；
而且重定向后一个字节都到不了管道，超时反而变成 `504` 且不带退出码 trailer，比不重定向更糟。

### 看窗口

```bash
curl http://127.0.0.1:8005/window_list \
  -H 'Authorization: Bearer s3cret'
```

```json
[{ "hwnd": 32768, "title": "execd", "className": "QWindow",
   "rect": { "left": 0, "top": 0, "right": 560, "bottom": 420 },
   "visible": true, "minimized": false }]
```

可选过滤参数：`title=<模糊>` 按标题模糊搜索（不区分大小写），`class=<精确>` 按类名精确匹配（区分大小写）。两者可同时使用，均返回包含匹配项的窗口子集。

```bash
# 搜索标题包含 "execd" 的窗口
curl "http://127.0.0.1:8005/window_list?title=execd" \
  -H 'Authorization: Bearer s3cret'

# 精确匹配类名 "QWindow"
curl "http://127.0.0.1:8005/window_list?class=QWindow" \
  -H 'Authorization: Bearer s3cret'
```

### 截图

```bash
# 整屏
curl -o screen.bmp http://127.0.0.1:8005/screenshot

# 指定窗口
curl -o win.bmp "http://127.0.0.1:8005/screenshot?hwnd=852200&area=window&mode=print"
```

返回 `image/bmp`，头部带 `X-Dimensions: <宽>x<高>`。三个参数：`hwnd`（缺省=全屏，正整数）、`area`（`window` 默认 / `client`）、`mode`（缺省时带 hwnd 取 `print`、全屏取 `screen`）。参数非法返回 `400`。

`mode=print` 值得单独说一句：它让窗口**自己渲染到一块内存 DC**，不受屏幕分辨率裁剪。XP 桌面只有 640x480，而窗口 rect 是 (200,200)-(760,620) 超出了屏幕，用 `mode=screen` 会被裁成 440x280，拿不到完整的 560x420。所以带 `hwnd` 时默认就是 print——遮挡、最小化、超出屏幕的窗口都能拿完整像素；代价是 print 依赖目标窗口的消息循环响应（窗口卡死时约挂 5 秒），而 `screen` 是纯 `BitBlt` 读屏、对窗口零依赖，要那种零依赖语义就显式传 `mode=screen`。

### 三个语义要点

**退出码在 trailer，不在 header。** body 一开跑就开始流，`X-Exit-Code` 只能在响应末尾给。HTTP trailer 是唯一「既能流式、又能带完成态」的机制——不用等命令跑完才能开始读输出。

```bash
# 退出码在 trailer 里，普通 header 读不到，要看完整的响应头尾
curl -s -X POST http://127.0.0.1:8005/exec \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"exit 7"}' --raw -D - -o /dev/null
# → Trailer: X-Exit-Code ...  末尾 X-Exit-Code: 7
```

**断连即 kill。** 这条主要针对长时间运行的命令——curl 发起一条 `ping -t` 之类的命令，看着它跑下去，直接按 Ctrl-C 断开连接，服务端会把对应的进程树一并 kill 掉，不用手动去 VM 里收尸。

触发点在服务端：客户端一断开，子进程树立刻 `taskkill /F /T` 递归清掉。检测有三条路——连接关闭、socket 写失败（对端 RST 时关闭事件可能来不及报）、流式写响应时发现写不出去——任意一条命中就动手。

下面用 `--max-time` 模拟断开（等价于手动按 Ctrl-C）：

```bash
curl --max-time 2 -X POST http://127.0.0.1:8005/exec \
  -d '{"cmd":"ping -t 127.0.0.1"}'   # 2 秒后 curl 主动断开

# 几秒后另起一条查
curl -X POST http://127.0.0.1:8005/exec \
  -d '{"cmd":"tasklist /FI \"IMAGENAME eq ping.exe\""}'
# → 无匹配，子进程已被杀掉
```

**timeout 默认无限。** 不传 `timeout` 就不设定时器，连接活着命令就一直跑。要卡就传正数毫秒值，到点强杀、trailer 记 `X-Exit-Code: -1`。

完整实现见 [examples/execd/main.tsx](https://github.com/quickwinlabs/quickwin/blob/main/examples/execd/main.tsx)

