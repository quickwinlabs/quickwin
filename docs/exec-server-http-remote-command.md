# 通过 HTTP 远程运行 Windows 命令：一个 1.5MB 的 exe，从 XP 到 Win11

之前用 [QEMU 搭建 Windows 自动化测试环境](qemu-xp-automated-testing.md) 这套流程，每次编译出新 exe 就从快照启动，跑完测试关机。每次都得重启一遍虚拟机，**启动加测试约 30-60 秒**，大部分时间花在等系统起来上。

所以优化了一下方案：**在 VM 里常驻一个 HTTP 服务，专门用来执行命令**。宿主机随时 POST 一条命令过去，输出流式回来，不用为了跑个测试再重启一次。

## 简介

这个服务是 `exec_server`，它监听 8080 端口，收到 HTTP 请求，解析出要运行的命令，在本机运行，把输出通过 HTTP 返回。它是一个 exe，体积约 1.5MB，用 [QuickWin](https://github.com/xna00/quickwin) 开发，Windows XP 到 Windows 11 都能跑。

链路很短：

```
外部程序
      │  POST /exec {cmd: "dir"}
      ▼
exec_server.exe  (VM 内 8080)
      │  os.Worker（每请求一个）
      ▼
CreateProcessW + CreatePipe
      │
      ▼
system32\cmd.exe /c <cmd>
```

### 设计要点

**一请求 = 一个 worker = 一棵进程树。** 每请求起一个独立 worker，用 `CreateProcessW` + `CreatePipe` 拉起子进程。互不影响，上一条崩了不拖累下一条。

**用 cmd.exe 而不是 `CreateProcessW` 直接跑目标程序**，是为了保留 cmd 语义——内部命令（`dir`、`ver`）、管道重定向、`for` 循环都能原样用。

**不产生独立 session。** worker 跑在调用方进程所在的 session 内，`CreateProcessW` 直接起子进程。这条在下面「为什么不用 SSH」里是关键。

### 进程参数

| 参数 | 作用 |
|------|------|
| `--nogui` | 无 GUI 模式，默认会弹出窗口 |
| `--token=x` | 开启 Bearer 鉴权 |

GUI 日志窗默认开着，顶栏显示 `token: on|off · port: N · workers: N`，下面是最近 100 条请求记录（`HH:MM:SS · <命令> · <结果> (<耗时>ms)`）。headless 环境用 `--nogui` 关掉。

## 为什么不用 SSH

最直接的原因：**XP 上没有可用的现代 sshd**。就算硬塞一个老版本，Windows 7 上能装的 sshd 版本也很老，配置也很麻烦。

最实际的一层是**会话隔离**。

这是 Windows 上绕不开的坑。sshd 是 Windows 服务，跑在 session 0，而 **session 0 没有交互式桌面**——没有窗口站、没有可见 GUI。sshd 装上了、能登录、能执行命令，但没法看到或操作那个 session 里的窗口。

`exec_server` 不起独立 session，运行在桌面的 session 里，所以没有这层隔阂——`/window_list` 列出顶层窗口、`/screenshot` 抓指定窗口像素，这条链在 SSH 路径下走不通，在 exec_server 下是通的。

## 原理与使用

### 端点

| 端点 | 鉴权 | 说明 |
|------|------|------|
| `GET /` | 免 | `200 ok` |
| `GET /health` | 免 | `200 ok`，VM 就绪探测用 |
| `POST /exec` | 需 | 跑命令，流式输出 + trailer 退出码 |
| `GET /window_list` | 需 | 列出顶层窗口 |
| `GET /screenshot` | 需 | 截屏 / 抓指定窗口 |

鉴权用 `--token=x` 开启，命令是标准 Bearer：`Authorization: Bearer x`，不带或不对就 `401` + `{"error":"unauthorized"}`。

`/` 和 `/health` 始终免鉴权——VM 刚起来的时候就要探活，这时候还没法保证 token 配好了。`--token=`（空串）会被归一成「未配置」即全部放行，方便兼容 CI 里已有的调用方式。

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

### 看窗口

```bash
curl http://127.0.0.1:8005/window_list \
  -H 'Authorization: Bearer s3cret'
```

```json
[{ "hwnd": 32768, "title": "exec_server", "className": "QWindow",
   "rect": { "left": 0, "top": 0, "right": 560, "bottom": 420 },
   "visible": true, "minimized": false }]
```

### 截图

```bash
# 整屏
curl -o screen.bmp http://127.0.0.1:8005/screenshot

# 指定窗口
curl -o win.bmp "http://127.0.0.1:8005/screenshot?hwnd=852200&area=window&mode=print"
```

返回 `image/bmp`，头部带 `X-Dimensions: <宽>x<高>`。三个参数：`hwnd`（缺省=全屏，正整数）、`area`（`window` 默认 / `client`）、`mode`（`screen` 默认 / `print`）。参数非法返回 `400`。

`mode=print` 值得单独说一句：它让窗口**自己渲染到一块内存 DC**，不受屏幕分辨率裁剪。XP 桌面只有 640x480，而窗口 rect 是 (200,200)-(760,620) 超出了屏幕，用 `mode=screen` 会被裁成 440x280，拿不到完整的 560x420。

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

完整实现见 [examples/exec_server.tsx](https://github.com/xna00/quickwin/blob/main/examples/exec_server.tsx)

