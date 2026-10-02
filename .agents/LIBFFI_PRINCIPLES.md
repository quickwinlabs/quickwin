# libffi 工作原理

> ⚠️ **本文件描述的原理仍成立，但 libffi 已不参与本项目构建**（见
> `.agents/REMOVE_LIBFFI_PLAN.md`）。`deps/libffi/` 源码仅作为 ABI 论证与对照依据保留，
> 运行时代码不再 `#include <ffi.h>`、不再链接 `libffi.a`。本仓库的实际实现是手写汇编桩 +
> JS 侧打包，见文末「手写替代实现」。

## 一句话原则

**C 的调用约定是编译期知识（烧在生成的机器码里）；libffi 把它变成运行期数据——一份预先算好的调用计划（`ffi_cif`），调用时纯查表 + 一段固定汇编。**

核心分两个阶段：
1. `ffi_prep_cif` —— 把"函数签名"算成 ABI 计划（`bytes` + `flags` 两个字段）
2. `ffi_call` —— 按计划摆参数、跳转汇编、用 `flags` 索引进跳转表收回返回值

对应代码：`deps/libffi/src/x86/`（本仓库 x86 目录合并了 ia32 与 x64 两套实现）、`quickjs-ffi.c`。

---

## 1. 数据模型：两个结构体

### `ffi_type` —— 类型的自描述

`_build/deps/x64-cross/libffi-build/include/ffi.h:129-135`

```c
typedef struct _ffi_type {
  size_t         size;         // 大小
  unsigned short alignment;    // 对齐
  unsigned short type;         // FFI_TYPE_VOID/INT/FLOAT/DOUBLE/.../STRUCT/POINTER/COMPLEX
  struct _ffi_type **elements; // 复合类型的成员表（递归）
} ffi_type;
```

- 基本类型是全局静态实例：`&ffi_type_uint8` ~ `&ffi_type_sint64`、`&ffi_type_float`、`&ffi_type_double`、`&ffi_type_pointer`、`&ffi_type_void`（`ffi.h:213-221`）。
- 结构体类型手工构造，`elements` 指向成员 `ffi_type*` 数组，以 `NULL` 结尾。
- **C 的类型系统被压成 `(size, align, tag, members)` 四元组。** 类型代码枚举见 `ffi.h:60-79`（`FFI_TYPE_COMPLEX=15` 是最后一项）。

### `ffi_cif` —— 一份完整调用计划

`ffi.h:250-260`

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

`ffi_status` 枚举（`ffi.h:243-248`）：`FFI_OK / FFI_BAD_TYPEDEF / FFI_BAD_ABI / FFI_BAD_ARGTYPE`。

---

## 2. 阶段一：`ffi_prep_cif` —— 签名 → ABI 计划

两层：
- `deps/libffi/src/prep_cif.c:110` `ffi_prep_cif_core` —— 通用层：类型表展开、参数拷贝、变参处理；`:218` 调 `ffi_prep_cif_machdep(cif)` 交给平台。
- machdep 层算出 `cif->flags` 与 `cif->bytes`。

> **本仓库 x64 交叉构建只编译 `ffiw64.c` + `win64.S`，不编译 `ffi64.c`/`unix64.S`。** `ar t _build/deps/x64-cross/libffi.a` = `prep_cif.o types.o raw_api.o java_raw_api.o closures.o tramp.o ffiw64.o win64.o`——**没有 `ffi64.o`**。ia32 对应 `ffi.o sysv.o`。所以 `ffi64.c` 里的 unix64 逻辑在这个构建里根本不存在。

### x64 Windows：几乎不用算

`deps/libffi/src/x86/ffiw64.c:53-109`，核心 15 行：

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

`deps/libffi/src/x86/ffi64.c:531-555`（x64 Linux/Unix，本构建未编译）：

```c
for (bytes = 0, i = 0, avn = cif->nargs; i < avn; i++)
{
  if (examine_argument (cif->arg_types[i], classes, 0, &ngpr, &nsse) == 0
      || gprcount + ngpr > MAX_GPR_REGS     // MAX_GPR_REGS = 6 (ffi64.c:41)
      || ssecount + nsse > MAX_SSE_REGS)    // MAX_SSE_REGS = 8 (ffi64.c:42)
    {
      long align = cif->arg_types[i]->alignment;
      if (align < 8) align = 8;
      bytes = FFI_ALIGN (bytes, align);
      bytes += cif->arg_types[i]->size;
    }
  else { gprcount += ngpr; ssecount += nsse; }
}
if (ssecount) flags |= UNIX64_FLAG_XMM_ARGS;
cif->bytes = (unsigned) FFI_ALIGN (bytes, 8);
```

需要：`classify_argument` 把每个类型拆成寄存器类别（`INTEGER / INTEGERSI / SSE / SSESF / SSEDF / SSEUP / NO_CLASS / X87`）→ `examine_argument`（`ffi64.c:351-391`）数出需要几个 GPR、几个 SSE → 循环分配，超额就转栈并对齐。

> **libffi 最漂亮的地方**：分类抽象是通用的，但具体平台可以退化到 `nargs * 8`。
> **反直觉观察**：Windows x64 把 ABI 定得越死板，libffi 就越简单。这也是为什么这个 ABI 常被批评"没有表达力"，但恰恰是 FFI 框架的最爱。

---

## 3. 阶段二：`ffi_call` —— 执行计划

### 3.1 x64 Windows

C 侧构造 `win64_call_frame`（`ffiw64.c:40-48`）：

```c
UINT64 stack;    /* 0  */  // 参数数组首地址
UINT64 fn;       /* 16 */  // 目标函数指针
UINT64 flags;    /* 24 */  // 返回值类型
UINT64 rvalue;   /* 32 */  // 返回值存放地址
```

汇编 `ffi_call_win64`（`deps/libffi/src/x86/win64.S:60-160`）做三件事：

**① 参数分发：同一个 slot 双读**（`win64.S:67-74`）

```asm
movq  (%rsp), %rcx
movsd (%rsp), %xmm0      ; 同一个 8 字节 slot，同时当整数和浮点读
movq  8(%rsp), %rdx
movsd 8(%rsp), %xmm1
movq  16(%rsp), %r8
movsd 16(%rsp), %xmm2
movq  24(%rsp), %r9
movsd 24(%rsp), %xmm3
```

**libffi 故意不区分整数参数和浮点参数**——C 侧无脑 `memcpy` 8 字节进去，汇编侧两个寄存器各读一遍，多余那个被调用方忽略，无副作用。

这个技巧能成立，**正是因为 Windows x64 参数布局是纯线性的**。unix64 做不到（SSE/GPR 独立计数会错位）。

**② 调用**（`win64.S:76`）：`call *16(%rbp)`

**③ 返回值：编译期生成的跳转表**（`win64.S:78-84`）

```asm
movl 24(%rbp), %ecx            ; flags
movq 32(%rbp), %r8             ; rvalue 地址
leaq 0f(%rip), %r10            ; 跳表基址（RIP 相对）
leaq (%r10, %rcx, 8), %r10     ; r10 = &table[flags]
ja   99f                       ; flags 越界 → abort（兜底）
jmp  *%r10
```

表项（`win64.S:97-160`），每项几字节，由 `E(0b, FLAG)` 宏生成：

```asm
E(0b, FFI_TYPE_VOID)      epilogue                       ; leaveq; ret
E(0b, FFI_TYPE_INT)       movslq %eax,%rax; movq %rax,(%r8)
E(0b, FFI_TYPE_FLOAT)     movss  %xmm0,(%r8)
E(0b, FFI_TYPE_DOUBLE)    movsd  %xmm0,(%r8)
E(0b, FFI_TYPE_UINT8)     movzbl %al,%eax; movq %rax,(%r8)
E(0b, FFI_TYPE_SINT16)    movswq %ax,%rax; jmp 98f        ; 符号扩展
E(0b, FFI_TYPE_UINT64)
98:                      movq %rax,(%r8)                  ; 64 位直接落
E(0b, FFI_TYPE_POINTER)   movq %rax,(%r8)
E(0b, FFI_TYPE_LONGDOUBLE)  call abort                     ; 不支持
```

**返回值处理不是 if/else 链，是 `flags` 索引的跳转表**——这就是第 1 节 `flags` 字段的真正用途：**ABI 元数据直接变成 CPU 可执行的常量表。**

### 3.2 ia32（Windows XP / ia32 分支）

`ffi_call_i386`（`deps/libffi/src/x86/sysv.S:92-205`）。同样的模式，但多一个关键技巧：

```asm
movl (%esp), %eax        ; 保存返回地址
movl %ebp, (%ecx)
movl %eax, 4(%ecx)
movl %ecx, %ebp          ; EBP 变成 call_frame 基址        ; :111
movl %edx, %esp          ; ESP 指向参数数组                ; :116
movl 20+R_EAX*4(%ebp), %eax   ; fastcall 寄存器参数       ; :117-119
movl 20+R_EDX*4(%ebp), %edx
movl 20+R_ECX*4(%ebp), %ecx
call *8(%ebp)            ; :121
...
movl 12(%ebp), %ecx      ; 返回类型码                      ; :123
leal L(store_table)(,%ecx, 8), %ebx      ; 跳转表          ; :134
movl 16(%ebp), %ecx
_CET_NOTRACK jmp *%ebx                          ; :137
```

**关键技巧：栈重平衡**（`sysv.S:174-176`）

```asm
movl 8(%ebp), %ebx      ; 恢复被保存的 ebx
movl %ebp, %esp         ; ← ESP = EBP，直接丢弃调用方的清理
popl %ebp
ret
```

`call` 指令把返回地址压栈，调用方（callee）如果是 stdcall 会执行 `ret N` 清理自己的参数。**libffi 在 `call` 前把 `esp` 指向了自己构造的参数数组，并在返回后把 `esp` 拉回 `ebp`** —— callee 的 `ret N` 清理被无视，栈由 libffi 自己完全掌控。

> 这就是"ia32 用 `FFI_MS_CDECL` 调 stdcall 是安全的"的根源：不是 ABI 一致，而是**libffi 根本不依赖 callee 做栈清理**。
> 注意 ia32 的参数也是纯线性数组（`movl %edx, %esp`），与 win64 的"双读"是同一个设计思想的两代演进。

---

## 4. Closure —— 反向调用（trampoline）

前三节都是"我用 C 调它"。Closure 反过来：**让外部代码（比如 `EnumWindows`、`SHBrowseForFolder` 的回调）通过函数指针回调进你的 C 函数。**

难点：C 里没有"通用函数指针"——**指针必须长得像一段真实的机器码**。

libffi 的解法是写一段**打补丁的 trampoline**（`ffiw64.c:232-264`）：

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

缓冲区布局（`FFI_TRAMPOLINE_SIZE = 32`，`deps/libffi/src/x86/ffitarget.h:144`，注释写明 "4B ENDBR64 + 7B LEA + 6B JMP + 7B NOP + 8B pointer"）：

```
偏移  0..23   机器码（24 字节，永不修改）
偏移 24..31   jmpq 的间接目标 ← 写成 ffi_closure_win64 的地址
偏移 32..39   cif 指针        ← FFI_TRAMPOLINE_SIZE
偏移 40..47   fun 指针
偏移 48..55   user_data 指针
```

**巧妙的地方**：
- `leaq -0xb(%rip), %r10` 在偏移 4、长 7 字节，执行后 RIP = 11，所以 `r10 = 11 - 0xb = 0` = **缓冲起点**。
- `jmpq *0x7(%rip)` 在偏移 11、长 6 字节，RIP = 17，目标地址 = `17 + 7 = 24`，正好指到刚写入的 8 字节。
- 中间那段 `nopl` 填充就是为了让 jmpq 的操作数能精确落到偏移 24。
- **代码本身一个字都不用改**，所有元数据都跟在代码后面。

通用 handler `ffi_closure_win64`（`win64.S:199-232`）：

```asm
movq %rcx, 8(%rsp)                  ; 保存 4 个整数寄存器到栈
movq %rdx, 16(%rsp)
movq %r8,  24(%rsp)
movq %r9,  32(%rsp)
movq FFI_TRAMPOLINE_SIZE(%r10), %rcx      ; 载入 cif
movq FFI_TRAMPOLINE_SIZE+8(%r10), %rdx    ; 载入 fun
movq FFI_TRAMPOLINE_SIZE+16(%r10), %r8    ; 载入 user_data
movsd %xmm0, ffi_clo_OFF_X(%rsp)          ; 保存 4 个 SSE
...
call ffi_closure_win64_inner               ; 把参数还原成 ffi_argument[]，调 fun
movq  ffi_clo_OFF_R(%rsp), %rax            ; 结果同时写回 rax
movsd ffi_clo_OFF_R(%rsp), %xmm0           ; 和 xmm0
ret
```

最后两行与第 3.1 节的"双读"对称：**结果一个 64 位值同时写 `rax` 和 `xmm0`**，因为调用方不知道回调返回的是整数还是浮点。

**限制**：closure 回调固定返回 64 位（`ffi_arg`）。

**代价与安全**：trampoline 需要**可写可执行内存**（`ffi_closure_alloc` 用 `mmap`/`VirtualAlloc` 分配 RWX 页）。这是 libffi **唯一真正触碰安全边界**的机制。ia32 同理，`FFI_TRAMPOLINE_SIZE = 16`（`ffitarget.h:149`，"4B ENDBR32 + 5B MOV + 5B JMP + 2B unused"）。

---

## 5. 对 quickwin 的影响

### 调用点

`quickjs-ffi.c:124-126` —— 每次 JS 调用都两阶段连跑：

```c
status = ffi_prep_cif(&cif, FFI_DEFAULT_ABI, length, ffi_types[ret_type], arg_types);
if (status != FFI_OK)
    return JS_ThrowTypeError(ctx, "ffi_prep_cif failed: %d", status);
ffi_call(&cif, func, &ret, ffi_args);
```

`status` 已检查：坏类型（如 NULL 槽）会抛 TypeError，而不是把垃圾 `flags` 送进跳表（x64 `ja 99f` abort / ia32 未对齐表项）。

理论上可以把 `ffi_cif` 按 `bind` 声明缓存（`prep_cif` 一次、`ffi_call` N 次），但 win64 的 `prep_cif` 就是几行赋值（`nargs * 8` + `flags = rtype`），**收益极小，不值得**。

### ABI 分派

- `FFI_DEFAULT_ABI = FFI_WIN64`（`ffitarget.h:92`）
- `FFI_EFI64 = FFI_WIN64`（`ffitarget.h:99`）—— 同一个值
- 所以 quickwin 的 x64 路径完全在 `ffiw64.c`/`win64.S` 内

### 体积（实测）

实际被拉入链接的只有 4 个对象：

| 对象 | 大小 |
|---|---|
| `prep_cif.o` | 3.6K |
| `types.o` | 1.9K |
| `ffiw64.o` | 3.7K |
| `win64.o` | 1.6K |
| **合计** | **10.8K**（LTO 前） |

`closures.o`(16K) / `tramp.o`(1.2K) / `raw_api.o`(2.9K) / `java_raw_api.o`(3.0K) **因无引用不拉入** —— `strings _build/qwin-nowasm.exe | grep ffi_closure` 为空可证。对比 2.0MB 的 exe，占比约 0.5%。

### 分工

- **libffi** = 机器相关的 ABI 分发（`deps/libffi/src/x86/` 约 5570 行 C/asm，29 个架构共用一套抽象）
- **`lib/ffi-bind.ts`** = 类型安全（TS 泛型重载）
- 两层互不污染。类型安全放在 DSL 层是对的，因为 ABI 层不可能做静态检查。

### 相关文档

- `FFI_ARGS_RET_SEMANTICS.md` —— 参数/返回值位宽与符号语义（传参只看宽度、f32/f64 常数宽、变参 promotion）
- `quickjs-ffi.c` 的 `ffi_types[]` 映射表

---

## 6. 已验证事实清单（不必重新推导）

**Closure 支持完备但未接线**（两个架构都完整，零汇编工作）：

| 符号 | ia32 (`_build/deps/ia32-cross/libffi.a`) | x64 (`_build/deps/x64-cross/libffi.a`) |
|---|---|---|
| prep_closure_loc | `ffi.o` (`_ffi_prep_closure_loc`) | `ffiw64.o` (`ffi_prep_closure_loc`) |
| prep_closure | `prep_cif.o` | `prep_cif.o` |
| prep_raw_closure | `raw_api.o` | `raw_api.o` |
| prep_raw_closure_loc | `ffi.o` | `ffiw64.o` |
| trampoline | `sysv.o`: `_ffi_closure_i386`(cdecl) / `_ffi_closure_STDCALL` / `_ffi_closure_raw_SYSV` / `_ffi_closure_raw_THISCALL` / `_ffi_closure_REGISTER` / `_ffi_go_closure_EAX` / `_ffi_go_closure_ECX` / `_ffi_go_closure_STDCALL` | `win64.o`: `ffi_closure_win64` / `ffi_go_closure_win64`；`ffiw64.o`: `ffi_closure_win64_inner` |
| closure_alloc / closure_free | `closures.o` / `tramp.o` | 同 |

`FFI_CLOSURES=1`、`FFI_GO_CLOSURES=1`（`ffitarget.h:132-133`）。ia32 的 8 个 closure trampoline 符号全部可解析（`nm --undefined-only -a` 逐个比对无缺失）。

**quickwin 目前完全没用回调**：
- `quickjs-ffi.c:194-199` 只导出 4 个函数：`ffiCall` / `bufferPtr` / `readByte` / `writeByte`，**无任何 closure 引用**。
- `examples/exec_server_worker.ts:461` 明文记录限制："本层 FFI 没有函数指针类型，EnumWindows 那类回调接口用不了"，`listWindows()` 用 `FindWindowExW` 链式遍历替代（先取 next 再查当前防句柄失效，`:475`）。
- `SHBrowseForFolderW` 传 `lpfn: 0`。

**quickwin 没有 64 位标量 FFI 参数**（`bind` DSL 全部类型 token 统计）：

| token | 次数 |
|---|---|
| `ptr` | 23 |
| `i32` | 14 |
| `u32` | 12 |
| `wchar_ptr` | 6 |
| `UINT` / `HDC` / `HBITMAP` / `HWND` | 别名 → ptr / u32 |

`u64` / `i64` = **0**。这使 `feat/ffi-phase0` 分支的 `qw_call`（ia32 上 `intptr_t` wrapper 无法传 64 位整型）的缺陷对 quickwin **不构成约束**，但它仍是 660 行 vs 当前 234 行的手写、每架构维护一份的汇编 —— 不是替代路线，建议保留作参考。

**libffi 是最优解的三个数字依据**：
1. 体积 ~11KB（见上）
2. 零 64 位标量参数 → `qw_call` 缺陷不触发
3. Closure 免费附带 → 将来要回调支持，零汇编工作

**libffi 确实不优的地方（且不影响结论）**：
| 维度 | 问题 | 为什么无所谓 |
|---|---|---|
| 调用开销 | `ffi_call` 走 call_frame + 参数数组间接跳转 | FFI 调用是 GUI 节拍（每秒几千次），纳秒级无关 |
| 类型安全 | 类型是运行时 int；`ffi_prep_cif` 坏类型已通过返回值检查拦截（`quickjs-ffi.c:125`） | 类型安全已上移到 `bind` 的 TS 泛型重载层 |
| 依赖体积 | deps/ 多 1.7MB 源码 | 已是 submodule，Makefile 每架构自动交叉编译 |

> 未检查 `FFI_OK` 的后果（已修复前的状态）：垃圾 `flags` 进跳转表会被 `ja 99f` 兜底 abort（x64）或落进未对齐的表项（ia32），不会静默出错；仍建议显式检查。

**历史教训：`ffi_types[]` 查找表 float/double 错位**

`quickjs-ffi.c` 的 `ffi_types[]` 指针表**下标 = FFI_TYPE_* 宏值**。曾把 FLOAT 槽写成 NULL、DOUBLE 槽写成 `&ffi_type_float`、LONGDOUBLE 槽写成 `&ffi_type_double`（各后移一位）——`f32` 调 `prep_cif` 得 `FFI_BAD_ARGTYPE`、`f64` 被按 4 字节 float 处理。因仓库无真实 f32/f64 调用从未暴露。

- 修复：`[2]=&ffi_type_float`、`[3]=&ffi_type_double`、`[4]=NULL`（注释已写清 NULL 槽语义）。
- 回归锚点：`test/test_ffi_bind.ts` `f32/f64 floating args` section——`msvcrt!sqrt/atan2` 验 f64（三平台必有）、`gdi32!AngleArc` 的 REAL 参数验 f32。
- 相关：`f32/f64` 是完整的已实现 API 面（`quickjs-ffi.c:92-105` 传参、`:129-140` 返回 read-back），不是影子的映射表。

---

## 7. 阅读清单（按顺序，4 处就够）

1. `deps/libffi/include/ffi.h:129` —— `ffi_type`（注意仓库里是 `ffi.h.in` 模板，configure 生成的在 `_build/deps/x64-cross/libffi-build/include/ffi.h`）
2. `_build/deps/x64-cross/libffi-build/include/ffi.h:250` —— `ffi_cif`
3. `deps/libffi/src/x86/ffiw64.c:53-109` —— **win64 的 `prep_cif`，全宇宙的 win64 ABI 计算就这 15 行**
4. `deps/libffi/src/x86/win64.S:60-160` —— 参数双读 + 调用 + 返回值跳转表

往深钻的两处：
- `deps/libffi/src/x86/sysv.S:92-205` —— ia32 栈重平衡（`:174-175`）
- `deps/libffi/src/x86/ffiw64.c:232-264` + `win64.S:199-232` —— trampoline 补丁与 closure handler

## 8. 目录结构说明

本仓库的 `deps/libffi/src/x86/` **同时包含 ia32 与 x64 实现**（`ffi.c`/`sysv.S` = ia32；`ffi64.c`/`unix64.S` = x64 Unix；`ffiw64.c`/`win64.S` = x64 Windows），没有独立的 `x86_64` 目录。**历史上**具体编译哪个由 Makefile 的交叉构建目标决定（现已不编译，仅作 ABI 参考）：

| 目标 | 编译 |
|---|---|
| x64 Windows (`_build/deps/x64-cross/libffi.a`) | `prep_cif.o types.o raw_api.o java_raw_api.o closures.o tramp.o ffiw64.o win64.o` |
| ia32 Windows (`_build/deps/ia32-cross/libffi.a`) | `prep_cif.o types.o raw_api.o java_raw_api.o closures.o tramp.o ffi.o sysv.o` |

`raw_api.o` 在 x64 上是 fallback（`FFI_NATIVE_RAW_API = 0`，`ffitarget.h:146`），ia32 有原生 raw API 支持（`:150` = 1）。

---

## 9. 手写替代实现（本项目现状）

S1–S6 后，运行时 FFI 由本地汇编桩实现，libffi 已移出构建。文件与职责：

| 文件 | 职责 |
|---|---|
| `quickjs-ffi-call-ia32.S` | ia32 cdecl/stdcall 调用桩：`qwin_ffi_call_ia32(func, argbuf, nstack, out_int, out_fp, ret_fp)`；从 `%ebx` 恢复栈（stdcall 平衡），`fstpl` 只在浮点返回时碰 x87 |
| `quickjs-ffi-call-win64.S` | Win64 调用桩：前 4 槽 `movq`+`movsd` 双读进 RCX/RDX/R8/R9 与 XMM0-3，溢出参数置于 32 字节影子空间之后，返回恒写 RAX+XMM0 |
| `quickjs-ffi-call.h` | `.S` 桩的声明 + `qwin_ffi_arg_size[]` 契约 |
| `quickjs-ffi.c` | 唯一入口 `ffiCall(func, argFrame, retBuf, retIsFp)`：按架构把 JS 预打包的 `argFrame` 喂给桩，取原始返回写进 `retBuf`；另有 `bufferPtr/readByte/writeByte` |
| `lib/ffi-bind.ts` | `bind()`/`bindLib()` 声明式签名解析、`DataView` 打包 `argFrame`、`readRet()` 按声明宽度截断/符号扩展 |

关键对应关系：
- libffi 的 `ffi_prep_cif`「算 `bytes`/`flags`」→ JS `ARG_SIZE[]` + 各桩的固定布局。
- libffi 的返回跳转表（`CLASS_X87_RET` 等）→ ia32 桩的 `ret_fp` 分支 + JS `readRet()`；Win64 桩恒写 RAX/XMM0，由 JS 选一个。
- libffi 的类型表 `ffi_type`/`arg_types` → `kinds` 字符串（`'ptr wchar_ptr i32 ptr -> i32'`）。
- 未支持：struct by-value、varargs（见计划 §10.4）。

回归网：`test/test_ffi.ts`、`test/test_ffi_bind.ts`、`test/test_ffi_abi.ts`（ABI 边界 31 项）、
`test/test_ffi_struct.ts`（纯 TS 布局，不过 asm）。数值锚点 `sqrt(2) = 1.4142135623730951`，
XP/Win11 全套 588/588。
