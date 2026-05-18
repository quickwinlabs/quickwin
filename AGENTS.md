# QuickWin Agents

## 重要规则

> **遇到问题，先在网上查一下**
>
> 在尝试自行解决问题之前，应该首先通过搜索引擎查找相关的技术文档、官方示例或社区讨论。这包括但不限于：
> - 官方文档和 API 参考
> - GitHub issues 和 pull requests
> - Stack Overflow 等技术社区的讨论
> - 相关开源项目的源代码
>
> **为什么要这样做：**
> - 可以避免重复造轮子，直接使用社区验证过的解决方案
> - 能够学习到最佳实践和正确的实现方式
> - 节省大量调试时间
> - 确保使用正确的 API 和方法签名

> **禁止自动 commit：提交前必须先让用户 review**

> 每次 commit 前，先把变更内容展示给用户，获得明确确认后才执行 git commit 操作。不可在用户未确认的情况下直接提交。用户说 "commit" 时仍照常执行。

> **commit message 风格：** 保持简洁，与 `git log --oneline` 历史风格一致。

> **使用中文思考和回答**

## 1. Build Assistant (构建助手)

**功能：** 编译 TypeScript、执行构建、处理错误

**使用方法：**

```bash
:: 使用 MSYS2 make
make                   # 构建发布版本（默认，推荐）
make debug             # 构建调试版本（含 bridge 调试日志，仅在排错时使用）
make js                # 编译 TypeScript
make test              # 运行测试（默认跑所有，网络测试较慢）
make test TEST=net     # 只跑网络测试（国外 URL，可能慢/不可达）
make test TEST=-net    # 跳过网络测试（日常快速验证推荐）
make test TEST=wasm    # 只跑 wasm 测试
make clean             # 清理构建产物
make distclean         # 清理所有生成文件
make info              # 查看构建配置
make wat               # 将 WAT 文件编译为 WASM
```

> **优先使用 release 版本：** `make` 或 `make release`。遇到运行时错误需要排错时，再用 `make debug` 查看 bridge 调用日志等调试信息。`make debug` 会定义 `-DDEBUG` 开启 `DEBUG_PRINTF` 输出，release 版本中这些日志完全被编译掉。

**使用 run.ps1 在 Windows 上运行 MSYS2 命令：**

```powershell
powershell -ExecutionPolicy Bypass -File ./run.ps1 -Command "make js"
powershell -ExecutionPolicy Bypass -File ./run.ps1 -Command "./win.exe test/test_wasm_bidirectional.js"
powershell -ExecutionPolicy Bypass -File ./run.ps1 -Command "make js && ./win.exe test/test_wasm_bidirectional.js"
```

**注意：**
- 构建前确保 `win.exe` 未运行
- 需要 MSYS2 UCRT64 和 Node.js 环境
- `run.ps1` 用于在 PowerShell 中执行 MSYS2 bash 命令，支持包含 `&&` 的复杂命令

## 2. Event Loop Assistant (事件循环助手)

**功能：** 管理事件循环、处理定时器和异步操作

**特性：**
- 主线程：持续运行等待 GUI 消息
- 工作线程：无事件时自动退出

## 3. GUI Assistant (图形界面助手)

**功能：** 创建窗口、处理用户交互

**支持控件：** BUTTON、EDIT、LISTBOX、AUTOCHECKBOX、GROUPBOX

## 4. TypeScript 类型定义 (quickwin.d.ts)

**文件位置：** `quickwin.d.ts`

**功能：** 提供完整的 TypeScript 类型声明文件，包含所有可用模块和 API 的类型定义

**包含模块：**
- `fetch` - HTTP 请求 API（Request、Response、Headers）
- `std` - QuickJS 标准库（文件操作、环境变量、URL 下载等）
- `os` - 操作系统接口（文件系统、进程、定时器、Worker 线程）
- `sock` - Socket 网络编程
- `wolfssl` - TLS/SSL 加密
- `tls` - TLS 工具函数
- `win` - Windows API
- `gui` - Windows 图形界面
- `ffi` - 外部函数接口
- `wamr` - WebAssembly 模块验证
- `brotli` - Brotli 解压缩

**使用注意：**
- 使用 `std.loadFile()` 只适合读取 UTF-8 文本文件
- 读取二进制文件（如 WASM）应使用 `std.open()` + `FILE.read()`

**文档参考：** https://bellard.org/quickjs/quickjs.html

## 5. WAMR 集成注意事项

**问题：JSClassDef.call 不会使对象变成可调用函数**

在 QuickJS 中，尝试使用 `JSClassDef.call` 来使自定义类对象可调用时，虽然设置了 `.call` 回调，但 QuickJS 仍然报告 "not a function"。这是因为 `JSClassDef.call` 需要与 `JSClassExoticMethods` 配合使用才能正确工作。

**解决方案：使用 JS_NewCFunctionData 创建真正的 JavaScript 函数**

使用 `JS_NewCFunctionData` 创建带有 `magic` 参数的 C 函数包装器：

```c
// 创建全局表来存储 WASM 函数调用上下文
static WasmFuncCallData *wasm_func_call_list[1024];
static int wasm_func_call_count = 0;

static int register_wasm_func_call(wasm_exec_env_t exec_env, wasm_module_inst_t instance, const char *func_name) {
    // 存储上下文数据到全局表
    WasmFuncCallData *data = malloc(sizeof(WasmFuncCallData));
    data->exec_env = exec_env;
    data->instance = instance;
    strncpy(data->func_name, func_name, sizeof(data->func_name) - 1);
    wasm_func_call_list[wasm_func_call_count] = data;
    return wasm_func_call_count++;
}

// C 函数包装器
static JSValue js_wasm_cfunction_wrapper(JSContext *ctx, JSValueConst this_val, 
                                         int argc, JSValueConst *argv, 
                                         int magic, JSValue *func_data) {
    (void)this_val;
    (void)func_data;
    
    WasmFuncCallData *data = get_wasm_func_call(magic);
    if (!data) return JS_ThrowTypeError(ctx, "Invalid function data");
    
    // 调用 WASM 函数
    wasm_function_inst_t func_inst = wasm_runtime_lookup_function(data->instance, data->func_name);
    // ... 调用逻辑
}

// 在 js_wasm_instance_exports 中创建函数
func_id = register_wasm_func_call(inst->exec_env, inst->instance, "add");
JSValue add_func = JS_NewCFunctionData(ctx, js_wasm_cfunction_wrapper, 1, func_id, 0, NULL);
JS_SetPropertyStr(ctx, js_exports, "add", add_func);
// 注意：不要调用 JS_FreeValue(add_func)，这会导致对象被提前释放
```

**关键点：**
1. 使用 `JS_NewCFunctionData` 而不是 `JS_NewObjectClass` + `JSClassDef.call`
2. 通过 `magic` 参数传递函数 ID
3. 不要在 `JS_SetPropertyStr` 之后调用 `JS_FreeValue`

**参考项目：** txiki.js (https://github.com/saghul/txiki.js) - 成熟的 QuickJS + WAMR 集成实现
**C API 参考：** wasm-c-api (https://github.com/WebAssembly/wasm-c-api) - WebAssembly C API 官方规范及示例（hello/callback/global/memory/table/trap 等）

## 6. WAMR 构建方法

**目标：** 编译 WAMR（WebAssembly Micro Runtime）静态库 `libiwasm.a`

**命令：**

```bash
make wamr
```

等同于手动执行：

```bash
cd wamr && cmake -B build \
    -DWAMR_BUILD_PLATFORM=windows \
    -DWAMR_BUILD_TARGET=X86_64 \
    -DWAMR_BUILD_INTERP=1 \
    -DWAMR_BUILD_FAST_INTERP=1 \
    -DWAMR_BUILD_AOT=0 \
    -DWAMR_BUILD_JIT=0 \
    -DWAMR_BUILD_LIBC_BUILTIN=1 \
    -DWAMR_BUILD_LIBC_WASI=0 \
    -DWAMR_BUILD_MULTI_MODULE=0 \
    -DWAMR_BUILD_THREAD_MGR=0 \
    -DWAMR_BUILD_REF_TYPES=0 \
    -DWAMR_BUILD_GC=0 \
    -DWAMR_BUILD_SIMD=0 \
    -DWAMR_BUILD_LOG=0 \
    -DWAMR_BUILD_EXCE_HANDLING=1 \
    -DWAMR_DISABLE_HW_BOUND_CHECK=1 \
    -DWAMR_BUILD_INVOKE_NATIVE_GENERAL=1 \
    -DCMAKE_BUILD_TYPE=Release
cmake --build wamr/build --config Release
cp wamr/build/libiwasm.a wamr/lib/libiwasm.a
```

### 参数说明

| 参数 | 值 | 说明 |
|------|-----|------|
| `WAMR_BUILD_PLATFORM` | `windows` | 目标平台 |
| `WAMR_BUILD_TARGET` | `X86_64` | CPU 架构 |
| `WAMR_BUILD_INTERP` | `1` | 启用经典解释器 |
| `WAMR_BUILD_FAST_INTERP` | `1` | 启用快速解释器（比经典解释器更快） |
| `WAMR_BUILD_AOT` | `0` | 禁用 AOT（提前编译） |
| `WAMR_BUILD_JIT` | `0` | 禁用 JIT 编译 |
| `WAMR_BUILD_LIBC_BUILTIN` | `1` | 启用内置 libc（WASM 模块可用基本 C 库） |
| `WAMR_BUILD_LIBC_WASI` | `0` | 禁用 WASI（暂不需要） |
| `WAMR_BUILD_MULTI_MODULE` | `0` | 禁用多模块 |
| `WAMR_BUILD_THREAD_MGR` | `0` | 禁用线程管理器 |
| `WAMR_BUILD_REF_TYPES` | `0` | 禁用引用类型提案 |
| `WAMR_BUILD_GC` | `0` | 禁用垃圾回收提案 |
| `WAMR_BUILD_SIMD` | `0` | 禁用 SIMD 提案 |
| `WAMR_BUILD_EXCE_HANDLING` | `1` | 启用异常处理（隐含启用 TAGS，影响 WASMModule 结构体偏移） |
| `WAMR_BUILD_LOG` | `0` | 禁用日志输出 |
| `WAMR_DISABLE_HW_BOUND_CHECK` | `1` | **重要：** 禁用硬件边界检查。WAMR 默认对 Windows 启用 SEH（`__try`/`__except`），但 MSYS2 GCC 不支持 MSVC 扩展，必须关闭 |
| `WAMR_BUILD_INVOKE_NATIVE_GENERAL` | `1` | **重要：** 使用纯 C 版本的 `invokeNative` 函数。MSYS2 下 cmake 无法正确检测 MINGW，默认会试图编译 `.asm`（MSVC 汇编器）而非 `.s`（GCC 汇编器），导致链接时 `invokeNative` 符号未定义 |

### 常见问题

- **`__try`/`__except` 编译错误：** 设置 `WAMR_DISABLE_HW_BOUND_CHECK=1`
- **`invokeNative` 链接错误：** 设置 `WAMR_BUILD_INVOKE_NATIVE_GENERAL=1`
- **找不到 cmake：** 安装 `pacman -S mingw-w64-ucrt-x86_64-cmake`
- **链接 `libiwasm.a` 之前，需将产物从 `build/` 复制到 `lib/`：** `cp wamr/build/libiwasm.a wamr/lib/libiwasm.a`

## 故障排除

- **Permission denied 错误：** `taskkill /f /im win.exe` 后重新构建
- **TypeScript 错误：** 运行 `build.bat js` 检查错误
- **运行时错误：** 使用调试版本构建并检查日志
- **找不到 make 命令：** 使用 `.\build.bat <target>` 代替 `make <target>`（推荐方式）
- **wat2wasm 找不到：** 需要安装 wabt 包：`pacman -S wabt`
- **`WASMModule` 结构体偏移错位：** 如果直接 `(WASMModule *)wasm_module_t` 后读取字段得到垃圾值（如 `import_global_count=624`），说明 `WASM_ENABLE_TAGS`/`WASM_ENABLE_BULK_MEMORY` 等条件编译宏在 WAMR 库和项目代码中不一致。用 `make wamr` 重建 WAMR 库（需先 `rm -rf wamr/build` 清除 CMake cache），确保 `-DWAMR_BUILD_EXCE_HANDLING=1` 等选项生效
- **`make clean` 会删除所有 `lib/*.js`、`test/*.js` 和根目录 `*.js`：** 运行 `make clean` 后必须执行 `make js` 从 `.ts` 重新生成 JS 文件，否则测试或运行时找不到 `.js` 文件
- **控制台中文乱码：** 运行 `chcp 65001` 设置 UTF-8 编码后再执行程序

## 7. WASM 实现进度

**文件位置（待创建）：** `.agents/WASM_PROGRESS.md`

**功能：** 记录 WebAssembly JS API 实现进度，包括已完成/待完成功能、测试覆盖、已知 WAMR 限制和关键文件说明。每次迭代前查看该文件了解当前状态。

## 8. mupdf 移植进度

**文件位置：** `.agents/MUPDF_WASM_MEMORY.md`

**功能：** 记录 mupdf npm 包移植到 QuickWin 的可行性分析和逐步支持计划，包括 Emscripten WASM 胶水层分析、21 个导入函数清单、Node.js/浏览器 API 依赖、以及分阶段实施步骤。处理涉及 `mupdf.js`、`mupdf-wasm.js`、`mupdf-wasm.wasm` 时参考该文件。

## 9. HTTP Import (esm.sh 动态导入)

**核心能力：** 需要什么 JS 库，直接 `import('https://esm.sh/...')`，无需 `npm install`、无需打包配置、无需 node_modules。`win.exe` 本身就是 runtime + package manager。

例：
```js
// 不用装，直接 `win.exe -e "..."` 就能跑
import('https://esm.sh/marked').then(md => md.marked('# hello'))
```

### 关键实现

**HTTP Chunked Transfer Encoding 解码** (`quickjs-http.c:36-68`)

Cloudflare 等 CDN 对大响应使用 chunked encoding，即使 `Connection: close` 也不例外。原始响应体被 chunk 框架污染（如 `2db8\r\n...`），导致 QuickJS 解析为 `SyntaxError: invalid number literal`。

`http_get_sync` 中的解码流程：
1. 读取完整 HTTP 响应
2. 检测 `Transfer-Encoding: chunked` 头
3. 原地解码：`strtol(..., 16)` 解析块大小 → `memmove` 整理 → 跳过 `\r\n`
4. 解码后的干净数据传给 `try_cache_response`（缓存也存解码后内容）和 `extract_body`

```c
response[total] = '\0';
if (is_chunked(response))
    decode_chunked(response, &total);
try_cache_response(url, response, total);
return extract_body(response);
```

**Brotli 解压缩** (`quickjs-brotli.c:1-`)

esm.sh 等 CDN 会返回 `Content-Encoding: br`（Brotli 压缩）的响应体。`http_get_sync` 在收到完整响应后，如果检测到 `Content-Encoding: br`，调用 brotli 模块解压：

1. 读取完整 HTTP 响应
2. 检测 `Content-Encoding: br` 头
3. 提取 body 后调用 `JS_BrotliDecompress` 解压
4. 解压后的数据传给 `try_cache_response`（缓存存解码后内容）

```c
if (is_brotli_encoded(response))
    decode_brotli(response, &total);
try_cache_response(url, response, total);
return extract_body(response);
```

### 相关文件
- `quickjs-http.c` — `http_get_sync`、`decode_chunked`、`is_chunked`、`skip_crlf`
- `quickjs-brotli.c` / `quickjs-brotli.h` — Brotli 解压 JS API (`brotli.decompress`)、`JS_BrotliDecompress`
