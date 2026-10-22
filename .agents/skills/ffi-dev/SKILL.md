---
name: ffi-dev
description: 在 quickwin 仓库增加或修改 FFI 绑定、排查 ffi 测试失败（ffi-bind / ffi-abi / ffi-struct-layout 等）、写签名 token（`<TYPE>ptr!`、`i32@Enum`、`<>ptr`、`!` 与 `@` 后缀）、处理 32/64 位指针宽与返回值符号、定义结构体布局、写闭包回调（closure）时加载。含五条不变式、明确不支持清单、VM 回归命令与期望值。
---

# FFI 绑定开发

一句话：**签名字符串是 C 声明、ABI 布局与 TypeScript 类型的唯一来源**（`lib/ffi/bind.ts`）——运行时（callPlan → 汇编桩）与编译期（`BindFn` 推 TS 类型）读同一串 token，互不干扰。改签名的那一刻，参数数量、顺序、值域、可空性全部自动跟着变，没有第二处需要人工同步。

```ts
const GetDeviceCaps = bind('gdi32.dll', 'GetDeviceCaps', '<HDC>ptr! i32@DeviceCap -> i32')
```

## 加一个绑定

1. **签名先对权威元数据，别手推栈布局**：[win32json](https://github.com/marlersoft/win32json)（win32metadata 的 JSON 投影）。注意其 `Platform` 字段是"文档最低支持版本"，会把 `Ellipse`、`SetScrollInfo` 之类误标成 Vista+；结构体只给字段顺序不给偏移，仍需自行核对
2. **已绑定 ~250 个高频 API**（`lib/windows/*.ts`，各文件内 `b('Name', '<HWND>ptr ... -> i32')` 简写把 DLL 名固定，其余与 `bind()` 相同）；冷门 API 由调用方直接 `bind()`——**"绑定不全"是正常状态，不是欠账**
3. 常量一律走 gen_const（见 workflow skill「Windows 常量」），签名里用 `i32@EnumName` 收紧值域（`EnumMap` 由 `tools/gen_const.c` 生成的 `constants.ts` 末尾 `declare global` 段预填）
4. **结构体布局用 `struct()` / `union()` 定义**（`lib/ffi/struct.ts`）；`WCHAR` / `BYTE` 是内建 codec。定义后即可在签名里用 `<N>`（按值）或 `<N>ptr`（收地址）
5. 改 `.ts` 后 `make js`，测试在 VM 里跑（见「验证」）

## 五条不变式（改完自检）

| | 规则 |
|---|---|
| **指针宽** | 句柄（`HWND`/`HDC`/`WPARAM`/`LPARAM`…）一律写 `'<TYPE>ptr'`，宽度由架构决定（ia32=4 / x64=8）；**禁手选 `u32`/`u64`**。早期"typedef 名自动归一为 ptr"的别名机制已移除（2026-10-08）：写 `'HANDLE'` 类 typedef 名会在类型层塌 `never` + bind 期抛 `Unknown token` |
| **传参** | 只按宽度走槽（ia32：≤4B 进 4 字节槽、8B 进 8 字节槽；x64 恒 8 字节），符号无关，窄类型当宽类型传安全。唯一例外：x64 寄存器 ABI 浮点走 XMM、整数走 GPR，`f64` ≠ `u64` |
| **返回值** | read-back 必须同时知道**宽度 + 符号**：同一组位 `0xFFFFFFFF` 按 `i32` 是 −1、按 `u32` 是 4294967295——所以 DSL 必须保留 `i/u` 前缀。指针位按**有符号**读：全 1 返回 `−1`（对齐 C 版 `JS_NewInt64` 的 −1 哨兵），`0` 原样返回不转 `null`。**句柄判空别用 `if (!h)`**——`NULL` 是 0，但 `INVALID_HANDLE_VALUE` 是 −1（`FindFirstFileW` 失败返它） |
| **结构体布局** | 偏移由 ABI 对齐推导，`<N>` 按值入参把字节压进槽（ia32 按 4 字节对齐）。**布局顺序 = 对象字面量写法顺序**（`Object.entries` 迭代字段），所以字段名别用数字键——`'0'`/`'1'` 会被 ES 规范按数值升序排到最前，破坏写法顺序 |
| **缓冲寿命** | 取 `.ptr` 前必须绑到 `const`：`const r = X.alloc(); Foo(hwnd, r.ptr)`。裸 `.ptr`（`Foo(hwnd, X.encode('hi').ptr)`）走快路径不进 `callPlan` 的 `held`——**`held` 是运行时唯一的缓冲寿命保证**，临时缓冲可能在 `ffiCall` 期间被 GC 收掉，native 读写落进已释放内存。有 encoder 的入参位优先**直接传对象**（encoder 在槽写器内部完成分配，返回值进 `held`）；`<BYTE>ptr` 位直接传 PAB、不取 `.ptr` |

**历史教训（x86 栈错位）**：句柄在 ia32 上按 8 字节宽传 → 被调函数（stdcall）只消费 4 字节 → 后续所有参数栈偏移错位 → DrawTextW 参数错乱、text-measure 测宽为 0。修复方式就是第一条不变式。

## 明确不支持

| 特性 | 状态 / 替代 |
|---|---|
| struct by-value **返回** | **不支持**，bind 期 throw → 改用 `<N>ptr` 出参位 + 调用方缓冲（结构体返回需要隐藏指针/sret 级 ABI，而返回缓冲恒 8 字节） |
| struct by-value **传参** | 支持，`<N>` 按值形 |
| **变参** | 不支持；固定元数仍可绑定，但 C 的 default argument promotion 会把 `float` 提升为 `double`（4→8 字节）→ **float 参数必须声明成 `f64`**，否则栈/寄存器错位 |
| bigint 精确传参 | 走 `JS_ToInt64`，超出 64 位范围截断 |

libffi 已移出构建链（`deps/libffi` 仅作 ABI 参照源码，不参与链接）；ABI 细节全集中在汇编桩 `src/quickjs-ffi-call-*.S` / `src/quickjs-ffi-closure-*.S`，所以换一个 ABI 时 JS 侧一行不用改。

## 返回值约定：两套体系相反

| 体系 | 成功 | 判定 |
|---|---|---|
| Win32 | `0`（或句柄非 0） | `if (!ret) throw ...`，失败看 `GetLastError()` |
| COM | `HRESULT` bit31 = 0 | `SUCCEEDED(hr)` / `FAILED(hr)`——`S_OK` 与 `S_FALSE` **都是**成功（`CoInitializeEx` 同线程同模型重复初始化就返 `S_FALSE`，写 `hr === 0` 会误判）。判定 helper 在 `lib/com.ts` |

`closure()` 默认收 **stdcall**（32 位传 `{ stdcall: false }` 切 cdecl）；按值结构参数不支持（C→JS 方向无该分派，创建期 fail-fast）。泄漏**只打印警告、绝不自动 free**——native API 可能已把 `ptr` 复制走，自动释放会把"泄漏"升级成"野指针崩溃"。

## 验证

VM 里跑（容器是 Linux + 交叉编译工具链、无 wine，`make test` 直接跑 Windows exe 跑不起来；命令套 workflow skill 的黄金模板）：

```bash
podman exec quickwin-dev bash -lc 'cd /workspace/docker && ./http_test.sh win7 ffi'
# XP: ./http_test.sh xp ffi（自动改用 qwin-x86.exe）
```

`ffi` 是 suite 名子串匹配，命中 8 个：ffi / ffi-bind / ffi-struct / ffi-struct-layout / ffi-array / ffi-abi / ffi-user32 / ffi-windows。**两架构都要跑**——指针宽与栈帧的差异只在对侧暴露。`http_test.sh` 按 Summary 断言：失败 ≤1 即 PASS。

期望值（`_build/ffi_only.js` 快速子集，脚本见 workflow skill）：win11 `ok=610 fail=2 skip=2`（那 2 个是已知窗口枚举失败）；XP `ok=608 fail=0 skip=3`。

回归锚点：`test/test_ffi_abi.ts`（参数个数 0–12、整数与浮点混排、窄整型与负数返回、`i64` 传参、指针 NULL 位）、`test_ffi_struct_layout.ts`（偏移与头文件一致）、`test_ffi_bind.ts`（signedness read-back、`closure()` 覆盖 stdcall 与 cdecl 两种约定）。

## 深挖

| 资料 | 内容 |
|---|---|
| `docs/usage/ffi.md` | **实操指南**：签名语法全表、`bindAt` 按地址绑定、结构体（`offsetOf`/`alloc`/`decode`）、方向与取值形（`[in]`/`[out]` 怎么取值）、字符串、回调、返回值约定、完整示例、现成绑定索引 |
| `docs/ffi-types.md` | 签名 → 类型推导链、token 规则表、`!`/`@` 担保语义、双层防线、参数位塌 `never` / 返回位塌 `unknown` 的刻意不对称 |
| `docs/ffi-internals.md` | 分层、调用桩（x64 同槽双读、ia32 帧基准恢复、x87 栈下溢陷阱）、闭包块布局与 trampoline、不支持清单、win32json 用法 |
| `.agents/FFI_ARGS_RET_SEMANTICS.md` | 宽度/符号/回读的完整论证 + 不变式 checklist |
| `.agents/LIBFFI_PRINCIPLES.md` | 与 libffi 对照的 ABI 原则 |
| `.agents/FFI_PERF.md` | 每调开销的实测归因 |
