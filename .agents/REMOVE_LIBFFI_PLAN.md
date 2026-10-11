# 把 libffi 移出构建流程，改用手写汇编（Win32/x64 FFI）

> 状态：**已完成** —— S1–S7 全部落地（`223076b` / `403ccfa` + win64 桩与清理若干后续 commit），双平台全绿；S4 边界用例固化为 `ffi-abi` 套件 31 项；§10 JS 侧重构已落地，旧 `ffiCall` 打包路径已删除、`ffiCallRaw` 改名 `ffiCall`
> 创建：2026-10-01 ｜ 关联：`.agents/TODO.md`「系统性优化 FFI」
> ⚠️ 术语：本计划说的是「**移出构建流程**」，**不删除 `deps/libffi` submodule 与源码**（保留作 ABI 依据，见 §3.7）
> 注：本文档 2026-10-11 精简——原约 950 行的完整执行档案（S1–S7 逐步记录、设计期草案与勘误）压缩为结论与教训；过程细节可查 `git log` 与 `deps/libffi` 源码

---

## 0. 决策摘要

| 维度 | 决策 |
|---|---|
| **目标** | libffi **不再参与构建** —— 去掉 autotools 交叉构建链（主要动机）、减小产物、完全掌控 ABI 逻辑。**submodule 与源码保留**作 ABI 依据（§3.7） |
| **覆盖范围** | 仅当前实际用到的：12 个标量类型 + 整数/浮点/指针返回；closure/回调由自建 `quickjs-ffi-closure` 提供（不依赖 libffi closures） |
| **实现形式** | asm + C 混合 —— asm 只做「装载 + call + 取回返回值」，类型分类/返回解码/校验留 C（§10 后进一步下沉到 JS） |
| **验证策略** | 跳过 libffi 对拍，改用「ia32 全绿 → Win64 全绿 → 停用 libffi」分架构验证；新增 `ffi-abi` 边界套件（§4） |
| **后续演进** | ABI 打包复杂度移到 JS 侧（`lib/ffi/bind.ts` DataView 预打包）——**已落地**（§10） |

**不做的事**（明确划界）：不实现 struct 传参/返回（by-value 入参后来以 bit-cast 方式落地，见 §10.4 与 TODO）；不实现变参（当前零绑定）；不支持 bigint 精确传参（维持 `JS_ToInt64` 现状）。closure 已自建落地：`quickjs-ffi-closure.{h,c}` + `closure()`（wrapper 派发），EnumWindows/stdcall 与 qsort/cdecl 用例双平台全绿。

---

## 1. 结论

- 构建链中 libffi 引用全部移除：Makefile 9 处（变量、include 路径、`LIBS`、整个 autotools 构建规则）、CI cache 路径与 key、`quickjs-ffi.c` 的 `#include <ffi.h>`、`ffi_types[]` / `ffi_args[]` / `arg_types[]` / `ffi_prep_cif` 分支。干净重建后链接行不含 `libffi.a`，`strings qwin.exe` 无 libffi 符号残留
- `FFI_TYPE_*` 数值的唯一权威来源收窄为 `deps/libffi/include/ffi.h.in:60-82`（源码保留的决定性理由之一）；`quickjs-ffi-type.h` 仅存为 ABI 参照
- TS 表面 API 不依赖数值（branded nominal type），逐字节不变
- 体积（strip 后）：`qwin.exe`(x64) 2108942 B / `qwin-x86.exe`(ia32) 2008078 B；asm 桩链接体积 < 1KB（libffi 原 ~11KB/8KB）

## 2. 可行性核心依据

**x64**：Win64 参数布局是纯线性的 —— 第 i 个参数的寄存器由槽位序号唯一决定（槽 0-3 → RCX/RDX/R8/R9 与 XMM0-3 **同槽双读**，槽 4+ → 栈），与前面参数类型无关，无 SSE/GPR 分类问题（libffi 免分类靠的就是 `win64.S` 的同槽双读）。调用方必须预留 32B 影子空间；`rsp` 在 `call` 处须 16 对齐。`args[]` 连续 8 字节槽与该布局零转换成本吻合。

**ia32**：cdecl 全压栈（右到左），double 按 8 字节整体压入；浮点返回走 x87 ST0。核心机制是**帧基准恢复**（源自 libffi `sysv.S:174` 的 `movl %ebp,%esp`）：`call` 后**无条件** `mov %ebx, %esp` 从自己的帧基准重建栈 —— cdecl 与 stdcall 差异只在退栈责任，被无条件重建完全吸收，故本实现也能安全调 stdcall 导出（cdecl/stdcall 参数布局本身一致）。前提：`%ebx` 必须在三次 callee-saved push **之后**取基准；调用点之后所有出参一律 `%ebp`/`%ebx` 相对寻址，禁止依赖 ESP 相对偏移 —— 否则漏恢复时故障点滞后到后续任意栈访问，排查成本极高。

**x87 陷阱**（ia32）：整数返回时 x87 栈为空，无条件 `fstpl` 属栈下溢、置 `FE_INVALID` 污染此后 `fetestexcept()`（默认掩蔽下不崩，极难发现）——故 `ret_fp` 返回类别标志必须传递（libffi 用返回跳转表 `CLASS_X87_RET` 处理同一问题）。

## 3. 实现落点

```
quickjs-ffi-type.h        # FFI_TYPE_* 本地数值 + qwin_ffi_arg_size[]（现仅作 ABI 参照）
quickjs-ffi-call.h        # qwin_ffi_call_ia32/win64 原型（含 ABI 约定完整注释）
quickjs-ffi-call-ia32.S   # ia32：C 打包 argbuf + rep movsb + call + 取回 EAX:EDX/ST0
quickjs-ffi-call-win64.S  # x64：前 4 槽双读 + 溢出区在影子空间之后 + call + 取回 RAX/XMM0
```

C/asm 分层原则：类型分类、返回值按宽度截断/扩展、错误检查全是上层逻辑；asm 只做「按 ABI 搬运 + call + 取回原始返回」这一件机器必须做的事 —— x64 真正需要 asm 的约 15 条指令。

### 3.2 统一调用约定（C ↔ asm 内部约定，非 Windows ABI）

```c
void qwin_ffi_call_ia32(void *func, const void *argbuf, uint32_t nstack_bytes,
                        uint64_t *out_int, double *out_fp, int ret_fp);

void qwin_ffi_call_win64(void *func, const uint64_t *slots, uint32_t nargs,
                         uint64_t *out_int, double *out_fp);
```

- **ia32** 走「C 侧打包成连续 `argbuf` + asm 整体 `rep movsb`」—— asm 完全不含类型信息；参数区布局（每参数 4 或 8 字节、零填充）是 C 里可读可单测的循环；`nstack_bytes=0` 时 C 侧给长度 1 的合法指针
- **x64**：内部约定直接用 Win64 ABI 本身（RCX/RDX/R8/R9，第 5 参在栈 `[rsp+0x28]`）—— 注意 mingw C 侧默认 ABI 是 Win64 而非 SysV，写成 rdi/rsi 会与 C 传参完全错位；影子空间由 C 调用方按 ABI 预留，stub 不自己 `sub $32`；`args[]` 尺寸取 `max(length,4)` 并整体清零（桩无条件双读前 4 槽，libffi `ffiw64.c:101-102` 同款）；`call` 目标必须提前存 callee-saved 寄存器（RCX/RDX 已被槽内容覆盖）
- `out_int` / `out_fp`：取回整数（RAX / EAX:EDX）与浮点（XMM0 / ST0）返回；ia32 asm 固定写满 8 字节，C 侧对 32 位返回补 `ret = (uint32_t)ret` 掩码（x64 指针返回是完整 8 字节，不截断）
- `ret_fp`（ia32 专有）：返回类别标志，不可省（见 §2 x87 陷阱）

### 3.7 其他配置改动（submodule 保留决策）

> **`deps/libffi` submodule 保留，只从构建流程中移除。** 理由：手写 stub 的正确性论证大量引用 libffi 源码作 ABI 依据（`sysv.S` 帧基准恢复、`ffi.c` 参数区布局、`ffiw64.c` 影子空间），删除后引用全部失效、后续维护者无从复核；`ffi.h.in:60-82` 是 `FFI_TYPE_*` 数值唯一权威来源；移除动机是去掉 autotools 构建链（§0），而非去掉源码本身。

已执行：Makefile 全部 libffi 引用删除；CI cache 路径与 `deps/libffi/**` key 移除（保留会掩盖「是否还在编译 libffi」）；README/docs 的 FFI 措辞改为内建汇编调用桩 + `bind()`。`.gitmodules` 与 `deps/libffi/` 内容原样。
验收：`grep -rn "LIBFFI\|libffi" Makefile` 无结果；干净容器 `make cc64 cc32 && make js` 通过；`git submodule status` 仍可见 `deps/libffi`。

## 4. 边界用例（`test/test_ffi_abi.ts`，suite `ffi-abi` 31 项，双平台全绿）

为 asm 最易错维度各绑定真实 Win32/CRT 函数（不新增测试专用导出；缺函数的平台记 SKIP）：

| 维度 | 覆盖（真实函数） |
|---|---|
| 参数个数 0/1/3/**4**/5/6/8/12 | GetTickCount / fabs / memcpy / GetLocaleInfoA / SetRect / CompareStringW / WideCharToMultiByte / SetDIBitsToDevice（4 = Win64 寄存器→栈分界；0 验证影子空间仍预留） |
| 整浮混合、前 4 全整 | ldexp(f64,i32)、frexp/modf(f64,ptr)、AngleArc(f32×2)、GetLocaleInfoA（第 4 参在 R9） |
| 窄整型负值/大值 | abs(i8 -128)、abs(u8 200)、abs(i16 -300)、abs(u16 60000)（槽内低 N 字节 2 的补码） |
| 64 位传参/返回 | InterlockedExchange64 传 2^32+1 / -1 回读；InterlockedIncrement64(-2) → -1 |
| 负数返回符号扩展 | lstrcmpW → i32/i16/i8 均 <0（解码在 `lib/ffi/bind.ts` `readRet()`） |
| 指针 NULL | GetDC(null/undefined)、IsWindow(null) = FALSE |
| 浮点返回 | sqrt(2) = 1.4142135623730951、atan2（f64）；AngleArc 覆盖 f32 相邻槽不污染 |

> 已知缺口：`(f64 f64 f64 f64 -> f64)` 无三平台通用真实函数（`fma` 仅新 CRT、`_CI*` 为编译器私有约定），由 atan2 + AngleArc 部分覆盖。varargs 不属范围。

## 5. 实现教训（原 S1–S7 过程档案提炼）

- ia32 帧偏移：i386 标准帧下第一个参数在 `8(%ebp)`（`0(%ebp)` = 保存的 ebp、`4(%ebp)` = 返回地址）——写成 +4 会直接崩
- MinGW COFF 下汇编符号必须带 `_` 前缀（`C(__USER_LABEL_PREFIX__, ...)` 宏），否则 undefined reference；`.type/.size` 是 ELF 专有，COFF 不认
- ia32 出口不得多做 `lea -4(%ebp),%esp`（`%ebx` 基准已指向保存的 edi，多做 4 字节会让 `ret` 跳到第一个入参）
- `rep movsb` 前显式 `cld`（DF 残留 1 会反向拷贝踩调用者栈且不报错；ABI 规定 DF 进/出函数均为 0）
- 返回后禁止用 `%eax` 做间接寻址（刚被 `call *func(%ebp)` 用过，取 out_int 指针改用 `%ecx`）
- 校验用查表而非枚举：`qwin_ffi_arg_size[code] == 0` 即抛异常（一表覆盖 struct/longdouble/VOID 等全部不支持类型，VOID 另提前给准确错误信息）
- 动态栈帧（`sub` 长度来自参数）无法生成 SEH unwind 描述（`.cfi_*` 对 DWARF 仍正确）；唯一被调用方是 Win32 API，实践无影响。若日后需「目标函数回调进本帧」，必须先把帧改成常量大小
- **附带发现（已排查结案，2026-10-11）**：i686-mingw 已知 ABI bug（mingw-w64#30，"known and won't be fixed"）——从 Windows 回调（WndProc/CreateThread）进入且函数体含 SSE 对齐指令时，栈可能未 16 对齐 → `movaps` GPF。**对本项目无风险**：objdump 全量反汇编 `qwin-x86.exe`（33 万行）实测 SSE/MMX 指令 **0 处**、x87 963 处——ia32 交叉编译未开 `-msse2`，浮点全走 x87（无 16 对齐要求），对齐敏感指令不存在。⚠️ 结论绑定当前构建选项：若未来 ia32 加 `-msse2`/`-march=i686+` 需重新评估（缓解手段 `-mstackrealign` 或 `force_align_arg_pointer`）

## 6. 能力对照（vs libffi）

| 能力 | libffi | 本实现 |
|---|---|---|
| 12 标量 / x64 Win64 ABI / ia32 cdecl / ia32 stdcall 被调 / 整浮返回 / closure | ✅ | ✅（stdcall 靠帧基准恢复；closure 自建） |
| 错误检查 | 需手动查 `FFI_OK` | ✅ 内建校验（净改进） |
| struct 传参/返回、变参、bigint 精确 | ✅ | ❌ 明确抛异常 / 不支持（当前零使用；by-value 入参后来以 bit-cast 落地，见 §10.4） |
| 外部构建依赖 | submodule + autotools | 无（源码保留仅作 ABI 依据，§3.7） |

---

## 10. 后续演进：把 ABI 复杂度移到 JS 侧（已落地）

> 起因：C 侧参数打包是整条链路里唯一需要同时理解「类型宽度表」与「平台 ABI」、出错时会静默传错值的热路径。下沉到 JS 后 C 退化为「memcpy + call」，ABI 知识全部收敛在 `lib/ffi/bind.ts`（TS 可读性与可测性远高于 C）。

### 10.1 接口

旧 JS 侧签名（已删除）：`ffiCall(func, argTypes[], args[], retType)`。
最终接口（`quickwin.d.ts`）：

```ts
ffiCall(func: number, argFrame: ArrayBuffer, retBuf: ArrayBuffer, retIsFp: 0 | 1): void;
```

C 侧 `js_ffi_call` 不做任何类型表/槽宽逻辑，只按架构把 argFrame 喂给 asm 桩 + 取原始返回：ia32 argFrame = 连续 cdecl 参数区（`nstack_bytes = af_size`）；x64 argFrame = 8 字节宽槽数组（`nargs = af_size / 8`）。显式校验 `af_size <= 64*8`、`retBuf >= 8`（不靠约定）。

### 10.3 关键约束

1. **`ret_is_fp` 不能省** —— x87 返回分类与参数搬到哪层无关（§2 陷阱，S3 期间实测踩过）
2. **`retBuf` 恒 8 字节并显式校验** —— ia32 桩无条件写满 8 字节
3. **`argFrame` 布局写死在 TS 并加注释**，与 `quickjs-ffi-type.h` 的宽度表保持一致（`lib/ffi/bind.ts` 的 `ARG_SIZE[]` 与 `qwin_ffi_arg_size[]` 逐项一致）
4. string / ArrayBuffer 参数编码职责不变（utf-16le + `'\0'`、`held[]` 保活，`bind.ts` 现有逻辑原样保留）

### 10.4 struct by-value（2026-10 复核：Win32 C API 场景不构成缺口）

- **传参**：≤8B struct（Win32 仅见 `WindowFromPoint(POINT)` 8B、console `COORD` 4B 系列）在 ABI 上与按位打包的 u32/u64 **等价** —— cdecl 就是把 struct 字节压栈，`writeSlot` 的 LE 内存镜像正是同一段字节，bit-cast 零改动绑定。**by-value 入参已按此落地（bare `<N>` token，`f951cfc`，见 TODO）**
- **返回**：≤8B 走 EAX(:EDX)（`GetLargestConsoleWindowSize`），恰落在现有通路；hidden pointer（>16B）场景在 Win32 C API 不存在（多在 C++/COM）
- 9–16B（MSVC 拆两个寄存器块）需实测确认 mingw caller 与 MSVC callee 分类一致
- 现有 `lib/ffi/struct.ts` 走纯 TS 布局，不经 `ffiCall`，不受影响；by-value **返回**（sret/隐藏指针）与 varargs 仍按需单独立项（见 TODO「ffi-struct 覆盖缺口」）

### 10.6 实施结果

- JS 侧 `bind.ts` `makeFn` 改走 `callPacked()`：`ARG_SIZE[]` 宽度表、DataView 打包 argFrame、x64 补齐 ≥4 槽（`X64_MIN_SLOTS`，对应桩无条件双读）、`retBuf` 恒 8 字节、`readRet()` 解码（窄整型符号扩展、ptr NULL → null）
- 旧 `js_ffi_call`（C 打包 + 返回解码）整体删除；`FFI_TYPE_*` 数值导出（`ffi_consts[]`）删除，`quickwin.d.ts` 的 `FfiType`/`FFI_TYPE_*` 声明同步移除；`KIND_TO_FFI` 表换成 `KIND_SET`（仅 kind 合法性校验）
- 全部调用方迁移 `bind()`/`bindLib()`：`test_ffi.ts`、`setres.ts`、`pdf_preview2.ts`、`PdfCanvas.tsx`、`pdf_viewer.tsx`、`ListView.tsx`、`PathPicker.tsx`
- 验证：双平台 `ffi` 88/88、全量 557/557；差分探针（0/1/2/3 参 <WCHAR>ptr、5 参 SetRect、f64 sqrt/atan2、f32+i32 混合、6 参 AngleArc、ptr 返回、u32）全过
