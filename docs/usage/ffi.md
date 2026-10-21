# FFI 使用说明

QuickWin 的 `ffi` 模块提供内置汇编调用桩，用声明式签名调用任意 DLL 函数——无第三方依赖，
32/64 位与 Windows XP+ 通用。

```ts
import { bind } from './lib/ffi/index.js'

const GetCurrentProcessId = bind('kernel32.dll', 'GetCurrentProcessId', ' -> u32')
console.log(GetCurrentProcessId())
```

`bind(dll, name, sig, encoders?)` 返回一个普通 JS 函数，参数与返回值按 `sig` 转换。
`bindLib(dll, { name: sig, ... })` 一次绑一批；缺符号时 throw。

## 签名语法

签名是空格分隔的参数 token 加 `-> 返回 token`（零参写成 `' -> u32'`）。

| Token | 含义 |
|-------|------|
| `i8 i16 i32 i64 u8 u16 u32 u64 f32 f64` | 标量；`i64` / `u64` / `f64` 走浮点寄存器 |
| `<H>ptr` | 品牌指针，类型 `Ptr<'H'>`——编译期拦误传句柄（`ReleaseDC` 收 `Ptr<'HDC'>`，误传 `HWND` 直接报 tsc 错） |
| `<>ptr` | 裸指针 / 整数混合值（`WPARAM`、`LPARAM`、句柄混合），类型 `number`；指针宽度**按有符号读回**（全 1 → `-1`） |
| `<N>ptr` | 结构位 / 字符串位；该位注册 encoder 后可传对象 |
| `u32@EnumName` | 枚举值域标注（仅提示，值按 `u32` 传） |
| `!` 尾缀 | 该位禁 NULL：类型层排 NULL + 运行时传 0 throw。返回位可标 `!` |
| `-> void` | 无返回值 |

标量按 C 的 ABI 提升：`i8 = -1` 写进 4 字节槽是 `0xFFFFFFFF`，不是 `0x000000FF`。

写签名前先对一遍权威元数据：源头是微软的
[win32metadata](https://github.com/microsoft/win32metadata)（winmd 格式），社区把它转成了按命名空间
拆分的 JSON —— [marlersoft/win32json](https://github.com/marlersoft/win32json)。每个函数带
`DllImport`、参数的 `In`/`Out`/`Optional` 和返回类型；`Optional` 缺席的那一位才该加 `!`。
它没有 JSON schema，字段含义见 win32metadata 的 `docs/projections.md`。

两个坑：`Platform` 字段是「文档最低支持版本」，不是真实引入版本（`Ellipse`、`SetScrollInfo`
被标成 Vista+，XP 其实就有）——XP 可用性看 mingw 头的 `_WIN32_WINNT` 守卫；
结构体只给字段顺序、不给字段偏移，对齐自己算。

### 按地址绑定：`bindAt`

`bind()` 走 `GetProcAddress`，只能绑有导出名的函数。COM 接口方法在 vtable 里、没有导出名，
用 `bindAt(proc, sig, encoders?)` 直接按地址绑：

```ts
import * as ffi from 'ffi'
import { bindAt } from './lib/ffi/index.js'
import { PTR_SIZE } from './lib/ffi/ctype.js'

// IUnknown：对象指针 → vtable 地址 → 第 N 个单元是第 N 个方法
const vt = ffi.readPtr(pObj)                        // pObj 是对象指针（number）
const queryInterface = bindAt(ffi.readPtr(vt + 0 * PTR_SIZE), '<>ptr <>ptr <>ptr -> i32')
const addRef     = bindAt(ffi.readPtr(vt + 1 * PTR_SIZE), '<>ptr -> u32')
const release    = bindAt(ffi.readPtr(vt + 2 * PTR_SIZE), '<>ptr -> u32')
```

签名与 encoders 语义和 `bind()` 完全一致。`proc === 0` fail-loud（同 `GetProcAddress` 失败
分支），不让 0 落进参数槽。

**`bindAt` 刻意不做缓存**：每次调用都新建一份调用计划（slots 数组 + 首调分配的参数帧）。
vtable 是全类共享的静态表，热路径上应缓存**绑出来的函数**（同一条目只绑一次），
不要在循环里调 `bindAt`。

### 底层地址操作

`ffi` 内建模块还暴露几个地址级 helper，vtable 派发与无 encoder 的出参位都用得到：

| API | 说明 |
|-----|------|
| `ffi.readPtr(addr)` | 按指针宽度读一个指针（32 位读 4 字节、64 位读 8 字节）；`addr === 0` throw |
| `ffi.bufferPtr(buf)` | 取 ArrayBuffer 的底层地址（number） |
| `ffi.readByte(addr)` / `ffi.readBytes(addr, n)` | 读字节 / 读出一段为新 ArrayBuffer |
| `ffi.writeByte(addr, byte)` | 写一个字节 |

## 结构体

```ts
import { struct, union } from './lib/ffi/index.js'
import type { C_Struct } from './lib/ffi/ctype.js'

const POINT = struct('POINT', { x: 'i32', y: 'i32' })

POINT.size               // 8 —— 布局由 CType IR lower，对齐/padding 与 C 一致
POINT.alloc()            // 全新全 0 的缓冲（品牌 PtrArrayBuffer）
POINT.encode({ x: 1 })   // 缺省字段 doEncode 跳过
POINT.decode(buf)        // → { x, y }
POINT.offsetOf('y')      // 4 —— 算字段地址
```

声明形态与 C 对齐：

```ts
const DECL = {
    '#': 'struct',        // 或 'union'
    '#pack': 4,           // 可选：压缩对齐
    cbSize: 'u32',
    name: 'u16[260]@utf-16le',   // 定长字符数组
    dwSize: 'u32',
    handle: '<HFILE>ptr!',       // 字段也可标 ! 非空
} satisfies C_Struct

const MYSTRUCT = struct('MYSTRUCT', DECL)   // satisfies 保推断、不收窄成员类型
```

结构体数组位用 `structArray(POINT)`：注册进 `bind` 的 encoders 表后，`<POINT>ptr`
位的值域就是元素数组。

## 方向与取值形

各函数的 `@param` 用 `[in]` / `[out]` / `[inout]` 标方向。取值形按方向推导：

| 位型 | 写法 |
|------|------|
| `[in]` + 该位注册 encoder | 直接传对象，缺省字段为 0 |
| `[in]` + `<>ptr` 或该位无 encoder | `const b = X.encode({...})` 后传 `b.ptr` |
| `[out]` / `[inout]` + `<N>ptr`（无 encoder） | `const r = X.alloc()`（`[inout]` 用 `X.encode(初值)`）后传 `r.ptr`，`X.decode(r)` 读回 |
| `[out]` + `<BYTE>ptr` | **直接传 PAB**，不取 `.ptr`（`WCHAR.alloc(n)` / `new PtrArrayBuffer(n)`） |

`<BYTE>ptr` 位有内建 `BYTE` codec（identity 原地直通），槽写器把缓冲 return 出去、进
`callPlan` 的 `held`——不取 `.ptr` 反而更安全。它对普通 ArrayBuffer fail-loud，
须先用 `new PtrArrayBuffer(n)` 包一层。

**取 `.ptr` 前必须绑到 `const`。** 这是 FFI 最容易踩的一个坑：

```ts
// ✗ 脆形 —— 别这么写
SetWindowText(hwnd, WCHAR.encode('hi').ptr)
GetWindowRect(hwnd, RECT.alloc().ptr)

// ✓ 有 encoder 的入参位，直接传值（字符串/对象），完全不碰 .ptr
SetWindowText(hwnd, 'hi')
RegisterClassEx({ cbSize: WNDCLASSEXW.size, hInstance, ... })

// ✓ 无 encoder 的位，先绑 const 再取 .ptr
const r = RECT.alloc()
GetWindowRect(hwnd, r.ptr)
const { left, top, right, bottom } = RECT.decode(r)
```

原因：`callPlan` 的 `held` 是运行时唯一的缓冲寿命保证，且**每个槽只记槽写器 `return`
的那一块**。裸 `.ptr` 是 number，走 `mkPtrWriter` 的快路径 `return undefined`、不进 `held`；
临时缓冲在表达式求值完就不可达，GC 可能在 `ffiCall` 期间收掉它，native 读写落进已释放内存。
内联的 `A.encode({ f: B.encode(s).ptr })` 也一样脆——外层只 held 自己那块，内层 B 没有任何持有。

对象形（`f(a, X.encode({...}))`）反而是安全的：encoder 在槽写器内部完成分配，返回值进 `held`
活到 `ffiCall` 之后。所以**有 encoder 的入参位优先传对象，别取 `.ptr`**。

## 字符串

- `<WCHAR>ptr` + 该位注册 `WCHAR` encoder → 直接传 JS string（UTF-16 + NUL），空串传 `NULL`
- 文本出参位用 `<BYTE>ptr`（无 encoder）→ 自备 `WCHAR.alloc(n)` 缓冲**直接传**，返回后 `WCHAR.decode(buf)` 读回
- 语义是整数而非字符串的 `<WCHAR>ptr` 位（如 `LoadCursorW` 的光标名走 `MAKEINTRESOURCE`）
  签名里改用 `<>ptr`

```ts
const str = WCHAR.alloc(128)
const n = GetWindowText(hwnd, str, str.byteLength)
const title = WCHAR.decode(str)
```

## 回调

```ts
import { closure } from './lib/ffi/index.js'

const cb = closure('u32 -> i32', n => n * 2)
SomeApi(cb.ptr)
cb.dispose()   // 用完释放
```

签名语法同 `bind`。`closure` 收 stdcall（32 位传 `{ stdcall: false }` 切 cdecl）。
按值结构参数不支持（C→JS 方向无该分派，创建期 fail-fast）。

泄漏处理是**只打印警告、绝不自动 free**：`ptr` 会被复制进任意 native API，JS 的可达性推不出
native 是否还在用它，自动释放会把「泄漏」升级成「野指针崩溃」。代价只是滞留到进程结束。

## 返回值约定

两个体系相反，别混：

| 体系 | 成功 | 判定 |
|------|------|------|
| Win32 | `0`（或句柄非 0） | `if (!ret) throw ...`，失败看 `GetLastError()` |
| COM | `HRESULT` bit31 = 0 | `SUCCEEDED(hr)` / `FAILED(hr)` |

COM 的 `S_OK` 与 `S_FALSE` **都是**成功——`CoInitializeEx` 同线程同模型重复初始化就返
`S_FALSE`，写 `hr === 0` 会误判。判定 helper 在 `lib/com.js`。

失败哨兵按返回的读回符号分两族（常量在 `constants.ts` 的 `Sentinel`）：

| 返回 token | 常量 | 值 |
|------|------|------|
| `-> u32`（无符号读回） | `Sentinel.INVALID_FILE_ATTRIBUTES` / `INVALID_FILE_SIZE` / `INVALID_SET_FILE_POINTER` | `0xFFFFFFFF` |
| `-> <>ptr` / `<X>ptr`（有符号读回） | `Sentinel.INVALID_HANDLE_VALUE` | `-1` |

句柄判空别用 `if (!h)`：`NULL` 是 `0`，但 `INVALID_HANDLE_VALUE` 是 `-1`
（`FindFirstFileW` 失败返它）。

## 完整示例

建一个匿名管道：两个 HANDLE 出参位塞进一个结构，`alloc` 一次、`decode` 读回。

```ts
import { bind, struct } from './lib/ffi/index.js'
import { NULL } from './lib/ffi/ctype.js'

// 一个结构装两个 HANDLE 出参；字段标 ! —— 成功后必非零，decode 直出品牌 Ptr
const PIPE_HANDLES = struct('PIPE_HANDLES', { hRead: '<HFILE>ptr!', hWrite: '<HFILE>ptr!' })

const CreatePipe = bind('kernel32.dll', 'CreatePipe', '<>ptr <>ptr <>ptr u32 -> i32')
const CloseHandle = bind('kernel32.dll', 'CloseHandle', '<>ptr -> i32')

const pipe = PIPE_HANDLES.alloc()
if (!CreatePipe(pipe.ptr, pipe.ptr + PIPE_HANDLES.offsetOf('hWrite'), NULL, 0)) {
    throw new Error('CreatePipe failed')
}

const { hRead, hWrite } = PIPE_HANDLES.decode(pipe)
CloseHandle(hRead)
CloseHandle(hWrite)
```

## 现成绑定

`lib/windows/` 已按 DLL 分组绑好常用 API（`user32` / `gdi32` / `kernel32` / `advapi32` /
`winspool` / `shell32` / `comdlg32` / `psapi` / `version` / `ntdll` / `ole32` / `comctl32` /
`msimg32`），签名对照 mingw 原型手写：

```ts
import { GetWindowRect } from './lib/windows/user32.js'
import { GetDC, ReleaseDC } from './lib/windows/user32.js'
import { GetTextExtentPoint32 } from './lib/windows/gdi32.js'
import { PROCESSENTRY32W, RECT, POINT } from './lib/windows/structs.js'
```

`lib/com.js` 另有 COM 语义层：`SUCCEEDED` / `FAILED` / `guidFields`。

签名里的 encoder 注册（`bind` 第四参）决定某个位能不能传对象——**未被 import 的绑定经
esbuild 摇树不进产物**，所以按函数独立导出、按需 import，体积不受影响。

## 相关

- `lib/windows/user32.ts` 头注释 —— 方向标与取值形表的权威定义
- `lib/ffi/bind.ts` 的 `callPlan` —— 缓冲寿命保证的实现与边界
- `.agents/FFI_PERF.md` —— 参数帧复用、槽宽、回调重入等性能语义
