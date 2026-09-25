> [English](README.en.md) · **中文**

# QuickWin

Windows 平台上的 QuickJS 运行时，支持原生 GUI、网络、WASM、FFI 等能力。

支持 Windows XP+（32/64 位），保持最小二进制体积（约 1.5MB）。32 位构建已在 QEMU Windows XP 虚拟机中通过 CI 测试。

项目处于早期，功能待完善，包含已知 bug。

安装方式：

```bash
# 方式一：npm 本地安装（推荐）
npm install quickwin
npx quickwin node_modules/quickwin/main.js   # 包自带 main.js 示例；用 npx quickwin script.js 运行你自己的脚本

# 方式二：直接从 GitHub Release 下载
iwr https://github.com/xna00/quickwin/releases/latest/download/qwin.exe -OutFile qwin.exe
iwr https://github.com/xna00/quickwin/releases/latest/download/main.js -OutFile main.js
.\qwin.exe main.js
```

npm 包自带 4 个可执行文件：`qwin.exe`（64 位）/ `qwin-x86.exe`（32 位，兼容 XP）及其无 WASM 版本 `qwin-nowasm.exe` / `qwin-nowasm-x86.exe`。

## 特性

- **Win32 原生 GUI** —— 原生窗口、按钮、编辑框、列表框、托盘图标、弹出菜单
- **React 渲染器** —— 用 JSX 声明式 GUI，支持 `useState`/`useEffect`，diff 增量更新（[react-qw](lib/react-qw/)）
- **HTTP/HTTPS** —— `fetch()` API、Brotli 解压、chunked 传输、条件缓存
- **WebSocket** —— 完整的 RFC 6455 实现，支持 ws:// 与 wss://
- **WebAssembly** —— 基于 WAMR，支持标准 `WebAssembly.*` API
- **FFI** —— 通过 libffi 调用任意 DLL 函数
- **Polyfills** —— `TextEncoder`、`URL`、`URLSearchParams`、`btoa`/`atob`、`crypto.subtle`、`setTimeout`
- **动态导入** —— `import('https://esm.sh/...')`，无需安装任何依赖

## CLI

```bash
quickwin script.js                  # 运行脚本
quickwin -o CON script.js           # 带控制台运行（AllocConsole）
quickwin -o LOG script.js           # 自动生成日志文件运行
quickwin -e "console.log('hi')"     # 执行表达式
quickwin -- script.js --flag        # -- 停止选项解析
```

### 选项

| Flag | Description |
|------|-------------|
| `-e <expr>` | 执行表达式而不是文件 |
| `-o CON` | 分配控制台（`AllocConsole`）；仅 GUI 子系统构建所需 |
| `-o LOG` | 将 stdout+stderr 重定向到 `log_YYYY_MM_DD_HH_MM_SS.txt`（exe 所在目录） |
| `-o <file>` | 将 stdout+stderr 重定向到指定文件 |
| `-d` | 开启 HTTP 调试日志 |
| `--` | 停止选项解析，其余参数传给脚本 |

所有未知参数都会透明转发给 `scriptArgs` —— 不报错、不消费。选项解析后的第一个非参数即脚本文件。

## 内嵌脚本

可以把一个 JS 脚本直接内嵌进 `qwin.exe` 二进制 —— 无需重新编译。

### 格式（追加到 exe 末尾）

```
[JS bytes (N)] [N: uint32 LE] [magic "QWJS"]
```

### 用法

```bash
# 内嵌一个脚本
node scripts/embed-js.mjs --exe _build/qwin.exe --js script.js

# 或通过 make
make embed-js JS_EMBED=script.js

# 内嵌 Brotli 压缩的脚本（exe 更小，运行时解压）
make embed-js-br JS_EMBED=script.js

# 打包 examples/exec_server.ts 并 brotli 内嵌进 exec_server.exe
make exec_server

# 运行它（不需要文件参数）
_build/exec_server.exe
```

不带脚本文件参数运行时，`qwin.exe` 会检查自身末尾是否有内嵌 JS：找到则执行内嵌代码，否则回退到 `main.js`。同时支持原始（`QWJS`）与 Brotli 压缩（`QWBR`）两种内嵌格式；压缩格式在启动时解压。

## 模块

| Module | Import | Description |
|--------|--------|-------------|
| `std` | built-in | 文件 I/O、环境变量、URL 下载 |
| `os` | built-in | 文件系统、进程、Worker、定时器 |
| `gui` | built-in | Win32 窗口/控件/消息/托盘 API |
| `sock` | built-in | Socket 网络（`AddrFamily`、`FdEvent` 等） |
| `wolfssl` | built-in | TLS/SSL（`VerifyMode`、`ReturnCode` 等） |
| `ffi` | built-in | 外部函数接口 |
| `win` | built-in | DLL 加载（`LoadLibrary`、`GetProcAddress`） |
| `brotli` | built-in | Brotli 解压 |
| `wamr` | built-in | 底层 WAMR API |
| `fetch` | `import './lib/fetch.js'` | 向 globalThis 添加 `fetch()`、`Response`、`Headers` |
| `websocket` | `import './lib/websocket.js'` | 向 globalThis 添加 `WebSocket` |
| `polyfill` | `import './lib/polyfill.js'` | 向 globalThis 添加 `TextEncoder`、`URL`、`btoa`/`atob`、`setTimeout` |
| `preact` | `lib/preact/...` | JSX → Win32 渲染器（`render`、`useState`、`useEffect`） |
| `react-qw` | `lib/react-qw/` | 面向 Win32 GUI 的 React 自定义渲染器（[文档](lib/react-qw/)） |

## Worker

面向 CPU 密集或 I/O 密集工作创建后台线程。Worker 运行在独立的 QuickJS runtime 中，各自拥有自己的事件循环。

### 主线程

```js
import * as os from 'os'

const worker = new os.Worker('./worker.js')

worker.onmessage = (e) => {
    console.log('received:', e.data)
    worker.onmessage = null  // 完成后清理
}

worker.postMessage({ type: 'start', value: 42 })
```

### Worker 线程

```js
// worker.js
import * as os from 'os'

const parent = os.Worker.parent

parent.onmessage = (e) => {
    if (e.data.type === 'start') {
        parent.postMessage({ type: 'result', value: e.data.value * 2 })
    } else if (e.data.type === 'done') {
        parent.onmessage = null  // 清理以允许事件循环退出
    }
}
```

### API

| API | Description |
|-----|-------------|
| `new os.Worker(specifier)` | 创建 worker。`specifier` 是文件路径或 URL（支持 `https://` 与 `data:text/javascript;base64,`） |
| `worker.postMessage(data)` | 向 worker 发送消息（JSON 可序列化） |
| `worker.onmessage = fn` | 设置来自 worker 的消息回调。完成后设为 `null` 以释放消息端口 |
| `os.Worker.parent` | （Worker 侧）父线程的引用 |

### 清理

通信完成后，双方都必须把 `onmessage` 设为 `null`。这会释放消息端口，使事件循环能够干净退出。忘记设置会导致进程挂起。

## 示例

```bash
.\qwin.exe examples/tray_demo.js     # 系统托盘应用
.\qwin.exe examples/pdf_preview2.js  # 基于 mupdf 的 PDF 阅读器
.\qwin.exe examples/test_tab.js      # 基于 JSX 的标签页 GUI
```

## 从源码构建

### 前置依赖

- MSYS2 UCRT64 或 MINGW64
- Node.js（用于通过 tsc 编译 TypeScript）
- Git（用于子模块）

### 构建

```bash
git clone --recursive https://github.com/xna00/quickwin.git
cd quickwin

.\run.ps1 "make wamr"       # 构建 WAMR 库（仅首次）
.\run.ps1 "make small"      # 构建 qwin.exe（-Os + LTO，约 1.5MB）
.\run.ps1 "make js"         # 编译 TypeScript
.\run.ps1 "make test"       # 运行全部测试
```

`make nowasm` 会产出更小的 `_build/qwin-nowasm.exe`，不含 WASM/WAMR
（没有 `WebAssembly` 全局对象）；对这种版本运行 `make test TEST=-wasm` 跳过 WASM 测试。

### 构建目标

| Target | Description |
|--------|-------------|
| `make` / `make nodebug` | 快速构建 |
| `make small` | `-Os` + LTO + strip，约 1.5MB（推荐） |
| `make minimal` | `small` + UPX 压缩 |
| `make release` | `-O2` + LTO + strip（未做 `-Os` 优化） |
| `make debug` | 带 bridge 日志的调试构建 |
| `make nowasm` | 无 WASM/WAMR 构建 → `_build/qwin-nowasm.exe`（约 1.2MB，无 `WebAssembly` 全局） |
| `make cc64-small` | 交叉编译 x86_64 `_build/qwin.exe`（`-Os`，CI 用） |
| `make cc32-small` | 交叉编译 i686 `_build/qwin-x86.exe`（`-Os`，兼容 XP，CI 用） |
| `make js` | 通过 tsc 编译 TypeScript |
| `make wasm` | 编译 WAT → WASM fixtures |
| `make test` | 运行全部测试 |
| `make test TEST=-net` | 跳过网络测试（快速） |
| `make test TEST=wasm` | 仅运行 WASM 测试 |
| `make wamr` | 重建 WAMR 库 |
| `make embed-js` | 把 `embed.js` 内嵌进 exe（用 `JS_EMBED=file.js`） |
| `make embed-js-br` | 把 Brotli 压缩的 JS 内嵌进 exe |
| `make exec_server` | 打包 `examples/exec_server.ts` 并 Brotli 内嵌进 `_build/exec_server.exe` |
| `make npm-pkg` | 打包到 `dist/quickwin/` |
| `make clean` | 清理构建产物 |

## 许可证

MIT