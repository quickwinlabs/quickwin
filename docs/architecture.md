# 架构：内核是事件循环 + FFI

QuickWin 是一个 Windows 平台的 QuickJS 运行时。它的设计可以概括成一句话：

> **一个 JS 运行时真正需要的只有两块——事件循环（把所有异步源收进一个等待点）和 FFI（把系统能力暴露给 JS）。其余都是上层。**

分层详解见：[事件循环](event-loop.md)、[FFI 内部设计](ffi-internals.md)、[类型推导](ffi-types.md)。

---

## 分层

```
┌────────────────────────────────────────────────────┐
│  lib/              平台无关 JS 库                    │
│    http-server / fetch / stream / websocket / url   │
├────────────────────────────────────────────────────┤
│  lib/react-qw      React 渲染器（纯 JS）             │
│  lib/windows/*     Win32 绑定（TS + FFI）            │
├────────────────────────────────────────────────────┤
│  lib/ffi/          FFI DSL                          │
│    bind()  struct()  closure()                     │
├────────────────────────────────────────────────────┤
│  C 内核                                                  │
│    quickjs-libc.c   事件循环 + os/std 模块            │
│    quickjs-gui.c    窗口类注册与窗口过程桥接            │
│    quickjs-ffi.c    调用分发                          │
│    quickjs-ffi-closure.c  闭包池                     │
│    quickjs-ffi-call-*.S   调用桩（win64 / ia32）      │
│    quickjs-ffi-closure-*.S  派发器                    │
│    quickjs-sock.c   socket                            │
│    quickjs-http.c   HTTP / TLS（wolfSSL）             │
├────────────────────────────────────────────────────┤
│  deps/quickjs / wolfssl / wamr / brotli（全部静态链入）│
└────────────────────────────────────────────────────┘
```

## 三个对比

这三个对比是这个架构最直接的论据。

| 对比 | 含义 |
|---|---|
| **GUI 的 C 侧只有 8 个函数** | `RegisterClass` / `CreateWindow` / `SetWindowProc` / `DefWindowProc` / `SendMessage` / `LoadAppIcon` 等，只做平台原语 |
| **控件、布局、React 渲染器全在 JS 层** | `lib/` 里的 JS 靠 FFI 调 Win32，不经过任何 C 包装 |
| **251 / 8256** | 已绑定的 Win32 函数占全部导出的比例（≈3%）。其余留给用户 `bind()` |

第三个对比是刻意的取舍：**不追求绑定齐全**。`lib/windows` 只维护高频、以及需要结构体描述的 API；冷门 API 交给用户按签名自己绑。

## 系统能力都是数据

绑定签名是字符串，不是代码：

```ts
const user32 = bindLib('user32.dll', {
  MessageBoxW: '<HWND>ptr <WCHAR>ptr <WCHAR>ptr u32 -> i32',
  SendMessageW: '<HWND>ptr u32@AnyMsg <>ptr <>ptr -> <>ptr',
})
```

带来的结果是：**新增一个 API 不需要改 C**。C 只负责“能调用”，不负责“调用哪些函数”。

而且每条签名都同时是 TypeScript 类型的来源——编译期就推出参数与返回类型，详见 [类型推导](ffi-types.md)。

写签名前应先对权威元数据，详见 [ffi.md](usage/ffi.md)。

## 链接策略：系统库动态链，其余静态

`qwin.exe` 的全部 DLL 依赖：

```
ADVAPI32.dll   COMCTL32.dll   CRYPT32.dll   KERNEL32.dll   msvcrt.dll
SHELL32.dll    USER32.dll     WININET.dll   WS2_32.dll
```

九个都是 Windows 系统自带，从 XP 到 Win11 都有。QuickJS、wolfSSL、WAMR、brotli 全部静态链进 exe。

**规则**：凡是所有版本系统里都存在的库就动态链接，其余一律静态。这样产物是一个单文件，没有额外运行时依赖。

## C 与 JS 的分工

C 侧只做 JS 做不到的三件事：

1. **等待事件**——`MsgWaitForMultipleObjects`
2. **发起调用**——汇编调用桩
3. **创建线程**——worker

除此之外的逻辑（协议、控件、布局、错误处理）一律在 JS。这条线的边界就是架构的边界，跨过它就会回到“什么都写在 C 里”的老路。

## 移植到新平台要动哪些层

同一套思路可以直接搬到其他平台（Linux / macOS 的落地见 [QuickX](https://github.com/quickwinlabs/quickx)）。

| 层 | 移植成本 | 说明 |
|---|---|---|
| 上层 JS 库 | 零 | 纯 JS，不依赖平台 |
| `lib/ffi/` DSL | 零 | 签名与打包逻辑与 ABI 无关 |
| 平台绑定 | 高 | 换一套 API（Win32 → libc / X11） |
| 常量 / 结构体 | 中 | 需按平台重新生成 |
| 事件循环 | 中 | `MsgWaitForMultipleObjects` → `poll` |
| FFI 调用桩 | 中 | 每个 ABI 一套汇编 |
| C 内核其余 | 低 | sock / http / worker 大多平台无关 |

关键在于：**需要重新实现的部分只占小头**。Windows 版的 `quickjs-libc.c` 大半是 Windows 专属的 `os` 模块实现，而在 POSIX 上这些全是 libc 调用，可以直接用 JS + FFI 写，不需要 C。
