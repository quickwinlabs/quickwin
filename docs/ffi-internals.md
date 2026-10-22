# FFI 内部设计

QuickWin 的 FFI 不依赖 libffi，由一组手写汇编桩构成。设计要点可以归结为两条：

> **签名是数据**，以及 **调用桩和闭包派发器是两套东西**。

---

## 分层

```
bind('user32.dll', 'MessageBoxW', '<HWND>ptr <WCHAR>ptr <WCHAR>ptr u32 -> i32')
        ↓  lib/ffi/bind.ts
ctype  解析签名字符串 → 参数类型数组
callPlan 按 ABI 把参数预打包成连续 8 字节槽位的缓冲区
        ↓  src/quickjs-ffi.c
ffiCall  取出缓冲区、函数地址、返回值类型
        ↓  src/quickjs-ffi-call-*.S
汇编桩  装载寄存器 → call → 取回返回值
```

关键点在于 **ABI 细节集中在汇编桩里**。JS 侧只负责把参数排成线性缓冲区，不知道寄存器、不知道影子空间、不知道栈对齐。所以换一个 ABI，JS 侧一行不用改，只需换一个 `.S`。

同一条签名在编译期还会被推导成 TypeScript 的参数与返回类型，两层共用同一串 token，见 [类型推导](ffi-types.md)。

## 调用桩

| | x64（Win64） | ia32 |
|---|---|---|
| 整数参数 | `rcx rdx r8 r9`，第 5 个起上栈 | 全部压栈，右到左 |
| 浮点参数 | `xmm0–3` | 压栈，按 8 字节整体 |
| 影子空间 | 调用方必须预留 32 字节 | 无 |
| 栈对齐 | `call` 处 16 字节 | 无强约束 |
| 返回值 | `rax` / `xmm0` | 整数 `eax`，浮点 x87 `ST0` |

（Windows 两套 ABI 都不用 `AL`——那是 SysV x86-64 表示“用了几个向量寄存器”的约定。桩里固定写 0 只是为了确定性。）

**x64 的“同槽双读”**：槽位 0–3 是整数/浮点共用的，每个槽用 `movq`（整数）和 `movsd`（浮点）各读一次，由类型决定实际用哪个。这就是 libffi 能绕开 SysV 那套复杂分类的原因，本实现沿用同一手法。

**ia32 的“帧基准恢复”**：`call` 之后无条件 `mov %ebp, %esp` 从自己的帧基准重建栈。cdecl 与 stdcall 的唯一差异是退栈责任，被这个无条件重建吸收，所以同一个桩可以安全调用两种约定。

两个实现的布局依据都在 `deps/libffi`（源码保留以作 ABI 依据）：

- **x64**：`src/x86/ffiw64.c` 的 `ffi_call_int` 写入侧；同槽双读与 libffi 的 `win64.S` 一致
- **ia32**：`src/x86/ffi.c` 的写入侧分支；帧基准恢复的手法源自 `sysv.S`

### 一个隐蔽的陷阱

ia32 整数返回时 x87 栈本来是空的，如果无条件执行 `fstpl` 取浮点返回值，会造成栈下溢并置 `FE_INVALID`，污染此后所有 `fetestexcept()` 的结果（默认掩蔽下不崩溃，极难发现）。所以返回类别标志必须一路传到返回分支。

## 闭包：为什么必须生成代码

调用桩是静态汇编，**不需要可执行内存**。闭包不一样。

C 的调用约定里没有多余的参数可以携带“这个回调对应哪个 JS 函数”，所以只能把块地址直接编进机器码：

```c
blk = VirtualAlloc(NULL, 128, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);  // RW
write_trampoline(blk, dispatch);                                         // 写入机器码
VirtualProtect(blk, 128, PAGE_EXECUTE_READ, &old);                       // 锁成 RX
```

trampoline 只有三条指令：两条 `mov`（块地址 → `r10`、派发器地址 → `r11`，ia32 走 `eax`/`edx`）加一条 `jmp`。所有闭包共用同一个派发器，唯一的差异是块地址那个立即数。

块布局（128 字节）：

| 偏移 | 内容 |
|---|---|
| 0–31 | trampoline |
| 32–35 | magic（校验块有效性） |
| 36–39 | ret_kind（ia32 结果加载分派） |
| 40–43 | arg_bytes（ia32 stdcall 清栈字节数） |
| 48–63 | JSValue wrapper（`JS_DupValue` 强引用） |
| 64–71 | 创建该闭包的 `JSContext *` |

`ctx` 在创建时捕获进块，回调永远回到创建它的 context，因此不存在跨 context 污染。

**注意**：每个闭包实际占用一整个页（分配粒度是 4KB），128 字节的块只用掉其中很小一块。闭包数量多时可以改成“整块分配 + bump 分配槽位”，当前实现没有这么做。

## 明确不支持的边界

| 特性 | 状态 |
|---|---|
| struct by-value 传参 | 支持，走 `<N>` 按值形 |
| struct by-value 返回 | **不支持**，绑定期就 throw |
| **变参** | **不支持**，无法表达可变参数个数 |
| bigint 精确传参 | 不支持（走 `JS_ToInt64`，超出范围截断） |

by-value 入参把结构体字节直接压进槽位，ia32 按 4 字节对齐（与 libffi `ffi.c` 同规则）。返回位做不到——结构体返回需要隐藏指针 / sret 级 ABI，而返回缓冲恒 8 字节，所以绑定时直接 throw，并提示改用出参位（`<N>ptr` + 调用方缓冲）。

变参函数（`printf` / `wsprintfW` / `wvsprintf`）仍可按**固定元数**绑定，但有一条隐藏规则：C 的默认参数提升会把 `float` 提升为 `double`（4 字节 → 8 字节），所以必须按 `f64` 声明，否则栈错位。

## 绑定策略：只绑需要的

当前已绑定 **252 个** Win32 函数，而系统导出总数约 **8256 个**（≈3%）。

这是刻意的取舍：

- `lib/windows/` 只维护**高频**的、以及**需要结构体描述**的 API
- 冷门 API 交给用户按签名自己 `bind()`
- 因此“绑定不全”是正常状态，不是欠账

写签名前先对权威元数据（[win32json](https://github.com/marlersoft/win32json) 及其注意
事项——`Platform` 误标、结构体无偏移），详见 [usage/ffi.md](usage/ffi.md)。

## 验证

- `test/test_ffi_abi.ts`：调用边界回归——参数个数从 0 到 12、整数与浮点混排、窄整型与负数返回、`i64` 传参与返回、指针 NULL 位；用例全部走真实 Win32 / CRT 函数
- `test/test_ffi_struct_layout.ts`：结构体偏移与头文件一致
- `test/test_ffi_user32.ts` / `test_ffi_bind.ts`：回调（`closure()`，覆盖 stdcall 与 cdecl 两种约定）
- `test/bench_ffi_*.ts`：调用开销基准（含与 node-ffi 的对比）

libffi 已移出构建链，源码仅保留在 `deps/libffi` 作 ABI 参照，不参与链接。
