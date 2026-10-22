> [English](README.en.md) · **中文**

# QuickWin

Windows 平台上的 QuickJS 运行时，支持原生 GUI、网络、WASM、FFI 等能力。

支持 Windows XP+（32/64 位），保持最小二进制体积（约 1.5MB）。32 位构建已在 QEMU Windows XP 虚拟机中通过 CI 测试。

## 快速开始

用脚手架新建一个桌面应用（[quickwin-starter](https://github.com/quickwinlabs/quickwin-starter)）：

```bash
npm create -y quickwin@latest myapp
cd myapp
npm install
npm run build        # 产出 dist\app.exe
```

默认 React 模板（JSX + 系统托盘），`-- --template=minimal` 可从更朴素的骨架起步。

## 特性

- **Win32 原生 GUI** —— 原生窗口、按钮、编辑框、列表框、托盘图标、弹出菜单
- **React 渲染器** —— 用 JSX 声明式 GUI，支持 `useState`/`useEffect`，diff 增量更新（[react-qw](lib/react-qw/)）
- **HTTP/HTTPS** —— `fetch()` API、Brotli 解压、chunked 传输、条件缓存
- **WebSocket** —— 完整的 RFC 6455 实现，支持 ws:// 与 wss://
- **WebAssembly** —— 基于 WAMR，支持标准 `WebAssembly.*` API
- **FFI** —— 内置汇编调用桩，用 `bind()` 声明式签名调用任意 DLL 函数（无第三方依赖，[使用文档](docs/usage/ffi.md)）
- **Polyfills** —— `TextEncoder`、`URL`、`URLSearchParams`、`btoa`/`atob`、`crypto.subtle`、`setTimeout`
- **动态导入** —— `import('https://esm.sh/...')`，无需安装任何依赖

## CLI

运行时本体：`npm install quickwin` 安装，或从 [Releases](https://github.com/quickwinlabs/quickwin/releases) 下载 `qwin.exe` 与 `main.js`。npm 包自带 4 个可执行文件：`qwin.exe`（64 位）/ `qwin-x86.exe`（32 位，兼容 XP）及其无 WASM 版本 `qwin-nowasm.exe` / `qwin-nowasm-x86.exe`。

```bash
npx quickwin node_modules/quickwin/main.js   # 跑包自带的示例
quickwin script.js                  # 运行脚本
quickwin -o CON script.js           # 带控制台运行（AllocConsole）
quickwin -o LOG script.js           # 自动生成日志文件运行
quickwin -e "console.log('hi')"     # 执行表达式
quickwin script.js --flag           # 槽位之后的参数全部传给脚本
```

### 选项

| Flag | Description |
|------|-------------|
| `-e <expr>` | 执行表达式而不是文件 |
| `-o CON` | 分配控制台（`AllocConsole`）；仅 GUI 子系统构建所需 |
| `-o LOG` | 将 stdout+stderr 重定向到 `log_YYYY_MM_DD_HH_MM_SS.txt`（exe 所在目录） |
| `-o <file>` | 将 stdout+stderr 重定向到指定文件 |
| `-d` | 开启 HTTP 调试日志 |

命令行按固定槽位解析：`exe [-d] [-o 目标] [-e code | 脚本文件]`；槽位之后的所有参数原样进入 `scriptArgs`，不报错、不消费。文件槽不接受 `-` 开头的文件名（用 `./-name.js` 运行这类脚本）。

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

# 打包 examples/execd/main.tsx 并 brotli 内嵌进 execd.exe
make execd

# 运行它（不需要文件参数）
_build/execd.exe
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
| `ffi` | built-in | 外部函数接口底层（`LoadLibrary`、`GetProcAddress`、`ffiCall`） |
| `lib/ffi` | `import './lib/ffi/index.js'` | `bind()` / `bindLib()` / `closure()` / `struct()` 声明式 FFI（[使用文档](docs/usage/ffi.md)） |
| `brotli` | built-in | Brotli 解压 |
| `wamr` | built-in | 底层 WAMR API |
| `fetch` | `import './lib/fetch.js'` | 向 globalThis 添加 `fetch()`、`Request`/`Response`/`Headers` 及其类型声明 |
| `websocket` | `import './lib/websocket.js'` | 向 globalThis 添加 `WebSocket` |
| `polyfill` | `import './lib/polyfill.js'` | 向 globalThis 添加 `TextEncoder`、`URL`、`btoa`/`atob`、`setTimeout` |
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

示例脚本在仓库里（**不随 npm 包发布**，包内只有 exe、main.js、lib 与类型声明）：

```bash
.\qwin.exe examples/tray_demo.js     # 系统托盘应用
.\qwin.exe examples/pdf_preview2.js  # 基于 mupdf 的 PDF 阅读器
.\qwin.exe examples/test_tab.js      # 基于 JSX 的标签页 GUI
```

## 从源码构建

### 前置依赖

- **podman**（开发容器；构建/测试/QEMU 验证都在容器内完成，与 CI 一致）
- Git（用于子模块）

### 构建

```bash
git clone --recursive https://github.com/quickwinlabs/quickwin.git
cd quickwin

./docker/dev-podman.sh up      # 启动开发容器（复用 ghcr.io/quickwinlabs/quickwin-dev）
podman exec quickwin-dev bash -lc 'cd /workspace && make js && make cc64 && make test TEST=-net'
```

`make cc64` 产出 `_build/qwin.exe`。`cc64-nowasm` 会产出更小的
`_build/qwin-nowasm.exe`，不含 WASM/WAMR（没有 `WebAssembly` 全局对象）；
对这种版本运行 `make test TEST=-wasm` 跳过 WASM 测试。

### 构建目标

| Target | Description |
|--------|-------------|
| `make cc64` | 交叉编译 x86_64 → `_build/qwin.exe`（默认目标，`BUILD=fast`） |
| `make cc32` | 交叉编译 i686/XP → `_build/qwin-x86.exe` |
| `make cc64-nowasm` / `cc32-nowasm` | 无 WASM/WAMR 版 |
| `BUILD=fast\|small\|debug` | 构建 flavor：`make cc64 BUILD=small` = `-Os`+LTO（约 1.5MB，CI 用） |
| `make js` | 通过 tsc 编译 TypeScript |
| `make wasm` | 编译 `test/*.wat` → WASM fixtures |
| `make test` | 运行全部测试 |
| `make test TEST=-net` | 跳过网络测试（快速） |
| `make test TEST=wasm` | 仅运行 WASM 测试 |
| `make execd` | 打包 `examples/execd/main.tsx` 并 Brotli 内嵌进 `_build/execd.exe` |
| `make embed-js` / `embed-js-br` | 把 JS（Brotli 压缩）内嵌进 exe |
| `make npm-pkg` | 打包到 `dist/quickwin/` |
| `make gen-const` | 重新生成 `constants.ts`（在 VM 里跑 `_build/gen_const.exe`） |
| `make clean` / `distclean` | 清理（会清掉整个 `_build/`，之后需 `make js wasm`） |

构建与排错细节见 `.agents/skills/workflow/SKILL.md`。

## 许可证

MIT