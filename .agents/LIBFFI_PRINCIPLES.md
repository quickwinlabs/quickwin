# libffi 工作原理

> ⚠️ **libffi 已移出本项目构建**（2026-10，见 `.agents/REMOVE_LIBFFI_PLAN.md`——决策、执行落点与教训都在那边）。
> `deps/libffi/` 源码仅作 ABI 论证与对照依据保留；运行时不 `#include <ffi.h>`、不链接 `libffi.a`，
> 构建产物（`_build/deps/*-cross/libffi.a` 与 configure 生成的 `ffi.h`）已不存在。
> 本仓库实际实现是手写汇编桩 + JS 侧打包（见文末 §5）。本文是 libffi 两阶段设计的原理精读，
> 行文以 libffi 源码为事实依据（读源码时请以符号名定位，勿找行号）。

## 一句话原则

**C 的调用约定是编译期知识（烧在生成的机器码里）；libffi 把它变成运行期数据——一份预先算好的调用计划（`ffi_cif`），调用时纯查表 + 一段固定汇编。**

核心分两个阶段：
1. `ffi_prep_cif` —— 把"函数签名"算成 ABI 计划（`bytes` + `flags` 两个字段）
2. `ffi_call` —— 按计划摆参数、跳转汇编、用 `flags` 索引进跳转表收回返回值

对应源码：`deps/libffi/src/x86/`（本仓库 x86 目录合并了 ia32 与 x64 两套实现）。

---

## 1. 数据模型：两个结构体

### `ffi_type` —— 类型的自描述

```c
typedef struct _ffi_type {
  size_t         size;         // 大小
  unsigned short alignment;    // 对齐
  unsigned short type;         // FFI_TYPE_VOID/INT/FLOAT/DOUBLE/.../STRUCT/POINTER/COMPLEX
  struct _ffi_type **elements; // 复合类型的成员表（递归）
} ffi_type;
```

- 基本类型是全局静态实例：`&ffi_type_uint8` ~ `&ffi_type_sint64`、`&ffi_type_float`、`&ffi_type_double`、`&ffi_type_pointer`、`&ffi_type_void`。
- 结构体类型手工构造，`elements` 指向成员 `ffi_type*` 数组，以 `NULL` 结尾。
- **C 的类型系统被压成 `(size, align, tag, members)` 四元组。**（`FFI_TYPE_COMPLEX=15` 是最后一项。）

### `ffi_cif` —— 一份完整调用计划

```c
typedef struct {
  ffi_abi   abi;         // FFI_WIN64 / FFI_UNIX64 / FFI_EFI64 / FFI_GNUW64 / ia32 的 5 种
  unsigned  nargs;
  ffi_type **arg_types;
  ffi_type  *rtype;
  unsigned  bytes;       // ← 阶段一算出：栈上要给多少个字节
  unsigned  flags;       // ← 阶段一算出：返回值怎么处理（跳转表下标）
} ffi_cif;
```

**关键**：`bytes` 和 `flags` 不是描述"参数是什么"，而是描述"**怎么办**"。它们是阶段一与阶段二之间传递的计算结果，也是 libffi 整个设计的枢纽。

`ffi_status` 枚举：`FFI_OK / FFI_BAD_TYPEDEF / FFI_BAD_ABI / FFI_BAD_ARGTYPE`。

---

## 2. 阶段一：`ffi_prep_cif` —— 签名 → ABI 计划

两层：
- `deps/libffi/src/prep_cif.c` 的 `ffi_prep_cif_core` —— 通用层：类型表展开、参数拷贝、变参处理；末尾调 `ffi_prep_cif_machdep(cif)` 交给平台。
- machdep 层算出 `cif->flags` 与 `cif->bytes`。

> **本仓库旧 x64 交叉构建只编译 `ffiw64.c` + `win64.S`，不编译 `ffi64.c`/`unix64.S`**（`ar t` 可列成员验证：没有 `ffi64.o`；ia32 对应 `ffi.o sysv.o`）。所以 `ffi64.c` 里的 unix64 逻辑在这个构建里根本不存在。

### x64 Windows：几乎不用算

`deps/libffi/src/x86/ffiw64.c` 的 `ffi_prep_cif_core` 平台分支，核心就几行：

```c
cif->flags = flags;                    // 基本就是 rtype->type
...
/* Each argument either fits in a register, an 8 byte slot, or is
   passed by reference with the pointer in the 8 byte slot.  */
n = cif->nargs;
n += (flags == FFI_TYPE_STRUCT);       // 大结构体多占一个 slot 放返回缓冲
if (n < 4)
    n = 4;                             // Win64 保留前 32 字节 shadow space
cif->bytes = n * 8;
```

Windows x64 ABI 极其死板：**每个参数就占一个 8 字节 slot，顺序排**，不管它是 int、double 还是指针。8 字节以内的结构体直接塞进 slot，更大的传指针。**整个 ABI 计算就是 `nargs * 8`** —— 没有对齐填充、没有寄存器/SSE 分类、没有溢出转栈判断。

### unix64 对照：同一份抽象，复杂度差一个数量级

`deps/libffi/src/x86/ffi64.c`（x64 Linux/Unix，本构建未编译）需要：`classify_argument` 把每个类型拆成寄存器类别（`INTEGER / INTEGERSI / SSE / SSESF / SSEDF / SSEUP / NO_CLASS / X87`）→ `examine_argument` 数出需要几个 GPR、几个 SSE → 循环分配，超额（`MAX_GPR_REGS=6` / `MAX_SSE_REGS=8`）就转栈并对齐。

> **libffi 最漂亮的地方**：分类抽象是通用的，但具体平台可以退化到 `nargs * 8`。
> **反直觉观察**：Windows x64 把 ABI 定得越死板，libffi 就越简单。这也是为什么这个 ABI 常被批评"没有表达力"，但恰恰是 FFI 框架的最爱。

---

## 3. 阶段二：`ffi_call` —— 执行计划

### 3.1 x64 Windows

C 侧构造 `win64_call_frame`（`ffiw64.c`：参数数组首地址 / 目标函数指针 / 返回值类型 / 返回值存放地址四项）。汇编 `ffi_call_win64`（`deps/libffi/src/x86/win64.S`）做三件事：

**① 参数分发：同一个 slot 双读**

```asm
movq  (%rsp), %rcx
movsd (%rsp), %xmm0      ; 同一个 8 字节 slot，同时当整数和浮点读
movq  8(%rsp), %rdx
movsd 8(%rsp), %xmm1
...（共前 4 槽）
```

**libffi 故意不区分整数参数和浮点参数**——C 侧无脑 `memcpy` 8 字节进去，汇编侧两个寄存器各读一遍，多余那个被调用方忽略，无副作用。

这个技巧能成立，**正是因为 Windows x64 参数布局是纯线性的**。unix64 做不到（SSE/GPR 独立计数会错位）。

**② 调用**：`call *16(%rbp)`

**③ 返回值：编译期生成的跳转表**

```asm
movl 24(%rbp), %ecx            ; flags
movq 32(%rbp), %r8             ; rvalue 地址
leaq 0f(%rip), %r10            ; 跳表基址（RIP 相对）
leaq (%r10, %rcx, 8), %r10     ; r10 = &table[flags]
ja   99f                       ; flags 越界 → abort（兜底）
jmp  *%r10
```

表项由 `E(0b, FLAG)` 宏生成（VOID 直接 epilogue、FLOAT/DOUBLE 存 XMM0、窄整型做零/符号扩展、LONGDOUBLE 直接 abort）。

**返回值处理不是 if/else 链，是 `flags` 索引的跳转表**——这就是第 1 节 `flags` 字段的真正用途：**ABI 元数据直接变成 CPU 可执行的常量表。**

### 3.2 ia32（Windows XP / ia32 分支）

`ffi_call_i386`（`deps/libffi/src/x86/sysv.S`）。同样的模式，但多一个关键技巧：

```asm
movl (%esp), %eax        ; 保存返回地址
movl %ebp, (%ecx)
movl %eax, 4(%ecx)
movl %ecx, %ebp          ; EBP 变成 call_frame 基址
movl %edx, %esp          ; ESP 指向参数数组
movl 20+R_EAX*4(%ebp), %eax   ; fastcall 寄存器参数
movl 20+R_EDX*4(%ebp), %edx
movl 20+R_ECX*4(%ebp), %ecx
call *8(%ebp)
...
movl 12(%ebp), %ecx      ; 返回类型码
leal L(store_table)(,%ecx, 8), %ebx      ; 跳转表
movl 16(%ebp), %ecx
_CET_NOTRACK jmp *%ebx
```

**关键技巧：栈重平衡**

```asm
movl 8(%ebp), %ebx      ; 恢复被保存的 ebx
movl %ebp, %esp         ; ← ESP = EBP，直接丢弃调用方的清理
popl %ebp
ret
```

`call` 指令把返回地址压栈，callee 如果是 stdcall 会执行 `ret N` 清理自己的参数。**libffi 在 `call` 前把 `esp` 指向了自己构造的参数数组，并在返回后把 `esp` 拉回 `ebp`** —— callee 的 `ret N` 清理被无视，栈由 libffi 自己完全掌控。

> 这就是"ia32 用 `FFI_MS_CDECL` 调 stdcall 是安全的"的根源：不是 ABI 一致，而是**libffi 根本不依赖 callee 做栈清理**。
> 注意 ia32 的参数也是纯线性数组（`movl %edx, %esp`），与 win64 的"双读"是同一个设计思想的两代演进。

---

## 4. Closure —— 反向调用（trampoline）

前三节都是"我用 C 调它"。Closure 反过来：**让外部代码（比如 `EnumWindows`、`SHBrowseForFolder` 的回调）通过函数指针回调进你的 C 函数。**

难点：C 里没有"通用函数指针"——**指针必须长得像一段真实的机器码**。

libffi 的解法是写一段**打补丁的 trampoline**（`ffiw64.c`）：

```c
static const unsigned char trampoline[FFI_TRAMPOLINE_SIZE - 8] = {
  0xf3, 0x0f, 0x1e, 0xfa,                        // endbr64            4B  ← 偏移 0
  0x4c, 0x8d, 0x15, 0xf5, 0xff, 0xff, 0xff,      // leaq -0xb(%rip),%r10  7B
  0xff, 0x25, 0x07, 0x00, 0x00, 0x00,            // jmpq  *0x7(%rip)     6B
  0x0f, 0x1f, 0x80, 0x00, 0x00, 0x00, 0x00       // nopl               7B
};
memcpy(tramp, trampoline, sizeof(trampoline));
*(UINT64*)(tramp + sizeof(trampoline)) = (uintptr_t)ffi_closure_win64;
```

缓冲区布局（`FFI_TRAMPOLINE_SIZE = 32`，`ffitarget.h` 注释写明 "4B ENDBR64 + 7B LEA + 6B JMP + 7B NOP + 8B pointer"）：

```
偏移  0..23   机器码（24 字节，永不修改）
偏移 24..31   jmpq 的间接目标 ← 写成 ffi_closure_win64 的地址
偏移 32..39   cif 指针
偏移 40..47   fun 指针
偏移 48..55   user_data 指针
```

**巧妙的地方**：
- `leaq -0xb(%rip), %r10` 在偏移 4、长 7 字节，执行后 RIP = 11，所以 `r10 = 11 - 0xb = 0` = **缓冲起点**。
- `jmpq *0x7(%rip)` 在偏移 11、长 6 字节，RIP = 17，目标地址 = `17 + 7 = 24`，正好指到刚写入的 8 字节。
- 中间那段 `nopl` 填充就是为了让 jmpq 的操作数能精确落到偏移 24。
- **代码本身一个字都不用改**，所有元数据都跟在代码后面。

通用 handler `ffi_closure_win64`（`win64.S`）：先保存 4 个整数寄存器与 4 个 SSE 寄存器，从 trampoline 尾部载入 cif/fun/user_data，`call ffi_closure_win64_inner` 把参数还原成 `ffi_argument[]` 调 fun；**结果一个 64 位值同时写回 `rax` 和 `xmm0`**——与 §3.1 的"双读"对称，因为调用方不知道回调返回的是整数还是浮点。

**限制**：closure 回调固定返回 64 位（`ffi_arg`）。

**代价与安全**：trampoline 需要**可写可执行内存**（`ffi_closure_alloc` 用 `mmap`/`VirtualAlloc` 分配 RWX 页）。这是 libffi **唯一真正触碰安全边界**的机制。ia32 同理，`FFI_TRAMPOLINE_SIZE = 16`。

---

## 5. 手写替代实现（本项目现状）

libffi 移出构建后的运行时 FFI 由本地汇编桩实现（决策与执行档案见 `.agents/REMOVE_LIBFFI_PLAN.md`，性能归因见 `.agents/FFI_PERF.md`）。文件与职责：

| 文件 | 职责 |
|---|---|
| `src/quickjs-ffi-call-ia32.S` | ia32 cdecl/stdcall 调用桩：`qwin_ffi_call_ia32(func, argbuf, nstack, out_int, out_fp, ret_fp)`；从 `%ebx` 恢复栈（stdcall 平衡），`fstpl` 只在浮点返回时碰 x87 |
| `src/quickjs-ffi-call-win64.S` | Win64 调用桩：前 4 槽 `movq`+`movsd` 双读进 RCX/RDX/R8/R9 与 XMM0-3，溢出参数置于 32 字节影子空间之后，返回恒写 RAX+XMM0 |
| `src/quickjs-ffi-call.h` | `.S` 桩的声明 + `qwin_ffi_arg_size[]` 契约 |
| `src/quickjs-ffi.c` | 唯一入口 `ffiCall(func, argFrame, retBuf, retIsFp)`：按架构把 JS 预打包的 `argFrame` 喂给桩，取原始返回写进 `retBuf`；另有 `bufferPtr/readBytes/readByte/writeByte` |
| `src/quickjs-ffi-closure.{h,c}` | 自建 closure（quickwin 从未用 libffi closures）：每闭包一个 `VirtualAlloc` 可执行块（trampoline 绝对跳转 + magic/ret_kind/arg_bytes + 捕获的 wrapper/ctx），无 registry、无跨 context 全局 |
| `lib/ffi/bind.ts` | `bind()`/`bindLib()` 声明式签名解析、bind 期 `CallPlan` 打包 `argFrame`、`RET_READER` 按声明宽度截断/符号扩展 |

关键对应关系：
- libffi 的 `ffi_prep_cif`「算 `bytes`/`flags`」→ JS 槽宽表 + 各桩的固定布局（bind 期 `CallPlan`）。
- libffi 的返回跳转表（`CLASS_X87_RET` 等）→ ia32 桩的 `ret_fp` 分支 + JS `RET_READER`；Win64 桩恒写 RAX/XMM0，由 JS 选一个。
- libffi 的类型表 `ffi_type`/`arg_types` → 签名字符串 token（`'<>ptr <WCHAR>ptr i32 <>ptr -> i32'`）。
- 未支持：struct by-value 返回、varargs（见 ffi-dev skill「明确不支持」）。

**历史教训：`ffi_types[]` 查找表 float/double 错位**（libffi 时代）——`src/quickjs-ffi.c` 曾有以 `FFI_TYPE_*` 宏值为下标的 `ffi_types[]` 指针表，FLOAT/DOUBLE/LONGDOUBLE 槽各后移一位：`f32` 调 `prep_cif` 得 `FFI_BAD_ARGTYPE`、`f64` 被按 4 字节处理，因仓库无真实 f32/f64 调用从未暴露。回归锚点保留在 `test/test_ffi_bind.ts` 的 f32/f64 用例（`msvcrt!sqrt/atan2` 验 f64、`gdi32!AngleArc` 验 f32）。

## 6. 阅读清单（按顺序）

1. `deps/libffi/include/ffi.h.in` —— `ffi_type` / `ffi_cif` / `FFI_TYPE_*` 枚举（模板；configure 生成的 `ffi.h` 随构建移除已不存在）
2. `deps/libffi/src/x86/ffiw64.c` —— win64 的 `prep_cif` 平台分支，**全宇宙的 win64 ABI 计算就这几行**
3. `deps/libffi/src/x86/win64.S` —— 参数双读 + 调用 + 返回值跳转表
4. `deps/libffi/src/x86/sysv.S` —— ia32 栈重平衡
5. `deps/libffi/src/x86/ffiw64.c` + `win64.S` 的 closure 部分 —— trampoline 补丁与 handler

目录说明：本仓库 `deps/libffi/src/x86/` 同时含 ia32 与 x64 实现（`ffi.c`/`sysv.S` = ia32；`ffi64.c`/`unix64.S` = x64 Unix；`ffiw64.c`/`win64.S` = x64 Windows），没有独立 `x86_64` 目录。旧构建目标映射与成员清单已随构建移除失效，需要时按上面符号名在源码里定位。
