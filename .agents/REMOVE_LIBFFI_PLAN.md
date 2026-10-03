# 把 libffi 移出构建流程，改用手写汇编（Win32/x64 FFI）

> 状态：**已完成** —— S1–S7 全部落地；§10 JS 侧重构已落地，旧 `ffiCall` 打包路径已删除、`ffiCallRaw` 改名 `ffiCall`；S4 边界用例已固化（`ffi-abi` 31 项，双平台全绿）；S7 文档同步 已完成（见 §5 的 S1–S7 拆分与进度表）
> 创建：2026-10-01
> 关联：`.agents/TODO.md:17`「评估移除 libffi 依赖」
> ⚠️ 术语：本计划说的是「**移出构建流程**」，**不删除 `deps/libffi` submodule 与源码**（保留作 ABI 依据，见 §3.7）

---

## 0. 决策摘要

| 维度 | 决策 |
|---|---|
| **目标** | 让 libffi **不再参与构建** —— 去掉 autotools 交叉构建链（主要动机），顺带减小产物体积、完全掌控 ABI 逻辑。**submodule 与源码保留**作 ABI 依据（§3.7） |
| **覆盖范围** | **仅当前实际用到的**：12 个标量类型 + 整数/浮点/指针返回。不做 struct 传参、不做变参；closure/回调由自建内建实现提供（不依赖 libffi closures） |
| **实现形式** | **asm + C 混合** —— 指令级只做「寄存器装载 + call + 取回返回值」，类型分类/返回值读回/错误检查全部留 C |
| **验证策略** | 现有三套件（`ffi` / `ffi-bind` / `ffi-struct`）在 xp + win11 全绿 + **新增边界用例**；**跳过双跑对拍**，改用「ia32 全绿 → Win64 全绿 → 停用 libffi」分架构验证（§9.1） |
| **落地拆分** | S1–S7 七步，按架构切开（§5）。ia32 与 Win64 的 ABI 风险点完全不同，混在一步里无法定位是哪一侧的错 |
| **后续演进** | 把 ABI 复杂度移到 JS 侧（JS 用 `DataView` 预打包 `argFrame`）——**已落地**（§10） |

**不做的事**（明确划界，避免范围蔓延）：
- ❌ 不实现 `FFI_TYPE_STRUCT` 传参/返回（当前零使用；`ffi/struct.ts` 走纯 TS 布局 + `readByte/writeByte`，不经过 `ffiCall`）
- ❌ 不实现变参函数（`printf`/`wsprintfW` 等，当前零绑定；FFI_ARGS_RET_SEMANTICS.md §3 提到的变参 promotion 坑随之不需要处理）
- ~~❌ 不实现 closure/回调~~ → **已自建落地**：`quickjs-ffi-closure.{h,c}` + `closure()`（wrapper 派发，无 libffi closure_alloc 依赖），EnumWindows/stdcall 与 qsort/cdecl 用例 + 双平台全绿；`listWindows()` 仍用 FindWindowExW 链式遍历
- ❌ 不支持 bigint 精确传参（维持现状，`JS_ToInt64` 不走 BigInt）

---

## 1. 现状盘点

### 1.1 运行时实际用到的能力（代码普查结论）

对 `lib/` `examples/` `test/` 全量 grep `bind(` 的结果：

- **被绑定的函数共 31 个**，全部是 Win32 API + 3 个 CRT（`msvcrt!sqrt` / `msvcrt!atan2` / `msvcrt!lstrcmpW`）
- **最大参数个数 = 10**（`CreateProcessW`）
- **无变参函数**
- **无 struct 传参**（`lib/ffi/struct.ts` 自算布局，用 `readByte`/`writeByte` 逐字节读写）
- **无 libffi 回调**（无 `ffi_closure_alloc` 调用点；回调功能由自建 `quickjs-ffi-closure` 提供，不经 libffi）

参数签名样例（最高频形态）：
```
'ptr <WCHAR>ptr i32 ptr i32 -> i32'  5 参数（CloseHandle 类、GetClassNameW 类）
'ptr i32 i32 u32 f32 f32 -> i32'   6 参数（gdi32!AngleArc，f32）
'<WCHAR>ptr <WCHAR>ptr ptr ptr i32 u32 ptr <WCHAR>ptr ptr ptr -> i32'   10 参数（CreateProcessW）
```

### 1.2 构建链耦合（`Makefile`，9 处）

| 行号 | 内容 |
|---|---|
| `:19` | `LIBFFI = $(LIBFFI_LIB)`（CROSS 分支） |
| `:31` | `LIBFFI = -lffi`（native 分支，链 MSYS2 系统库） |
| `:106-108` | `LIBFFI_DIR` / `LIBFFI_BUILD_DIR` / `LIBFFI_LIB` 定义 |
| `:111` | `CROSS_BUILD_LIBS = $(BROTLI_LIB) $(BROTLI_COMMON_LIB) $(LIBFFI_LIB)` |
| `:126` | `CFLAGS += -I$(LIBFFI_BUILD_DIR)/include` ← **指向 configure 生成的 ffi.h，不是子模块里的** |
| `:136` | `LIBS = ... $(LIBFFI) ...`（交叉构建时 `libffi.a` 被链两次：`:219` prereq + `:136`，无害重复） |
| `:386-397` | 整个 `$(LIBFFI_LIB)` 构建规则（`autoreconf -fiv` + `configure` + `make libffi.la` + `cp`） |
| `:219` / `:228` | `$(CROSS_BUILD_LIBS)` 作为 prereq 被消费 |
| `:126` 的间接依赖 | `quickjs-ffi.c:4` 的 `#include <ffi.h>` 依赖 configure 产物 |

### 1.3 链接进来的目标文件

```
x64-cross/libffi.a : prep_cif.o types.o raw_api.o java_raw_api.o closures.o tramp.o ffiw64.o win64.o
ia32-cross/libffi.a: prep_cif.o types.o raw_api.o java_raw_api.o closures.o tramp.o ffi.o    sysv.o
```
其中 `raw_api.o` / `java_raw_api.o` / `closures.o` / `tramp.o` **全部未被引用**（libffi 的 `ffi_closure_*` 符号在项目 C 代码中零引用；项目的 `qwin_closure_*` 属自建 quickjs-ffi-closure，不经 libffi），纯死代码——靠 `--gc-sections`（`Makefile:134`）才被丢掉。

### 1.4 其他配置耦合

| 文件 | 行 | 内容 |
|---|---|---|
| `.gitmodules` | `:18-21` | `[submodule "libffi"] url=... ignore=dirty` |
| `docker/Dockerfile.dev` | `:14-15` | `autoconf automake libtool libtool-ltdl-devel`（注释写明「libffi 干净 checkout 需要 autoreconf -fiv」） |
| `.github/workflows/ci-qemu.yml` | `:165-167` | CI cache 路径含 `_build/deps/*/libffi.a` 与 `libffi-build/include/`，cache key hash `deps/libffi/**` |
| `patches/apply-submodule-patches.sh` | — | **无 libffi 条目**（只 patch wamr/wolfssl/quickjs），移除是干净的 |
| `.agents/DEVELOPMENT_WORKFLOW.md` | `:97,105` | 构建目录说明 + 「WAMR/WolfSSL/Brotli/libffi 由 cc64/cc32 自动构建」 |
| `.agents/QEMU_NET_SUITE_TEST.md` | `:93` | 提到手工删除 64 位 libffi 产物 |
| `README.md` / `README.en.md` | `:33` | 「通过 libffi 调用任意 DLL 函数」 |
| `docs/quickwin-intro.md` | `:32` | 同上 |

### 1.5 `FFI_TYPE_*` 数值的唯一来源

`deps/libffi/include/ffi.h.in:60-82` → configure → `_build/deps/<variant>/libffi-build/include/ffi.h` → `quickjs-ffi.c:4` → `quickjs-ffi.c:208-223` 的 `DEF(FFI_TYPE_*)` 导出到 JS。

**TS 侧不依赖数值**：`quickwin.d.ts:556-587` 用 branded nominal type（`number & { __label: unique symbol }`），没有数值字面量。所以移除 libffi 后 **TS 表面可以逐字节不变**。

> ⚠️ **注意**：因为 libffi **不再参与构建**（§3.7），`ffi.h` 不再由 configure 生成，
> 「数值对齐」的核对方式随之改变：
>
> - S1 实施时用的是 `_Static_assert` 交叉核对（`quickjs-ffi-type.h` vs 构建出的 `ffi.h`）——
>   那时 libffi 还在构建，这可行。
> - S6 之后 `ffi.h` 不再生成，**核对必须回到源码**：`deps/libffi/include/ffi.h.in:60-82`
>   （该文件保留，见 §3.7）。所以 `quickjs-ffi-type.h` 的注释里应直接写明
>   「数值来源 = `deps/libffi/include/ffi.h.in:60-82`」而不是「与构建产物一致」。
> - 因此 **`deps/libffi` 源码必须保留** —— 它现在是数值的唯一权威来源。

---

## 2. 技术可行性依据

### 2.1 x64：Win64 参数布局是纯线性的，无需 SSE/GPR 分类

这是整个方案成立的核心。依据 Microsoft Learn《x64 Calling Convention》：

| 槽位 | 整数寄存器 | 浮点寄存器 | 栈位置 |
|---|---|---|---|
| 0 | RCX | XMM0L | 影子区 `rsp+0x08` |
| 1 | RDX | XMM1L | 影子区 `rsp+0x10` |
| 2 | R8 | XMM2L | 影子区 `rsp+0x18` |
| 3 | R9 | XMM3L | 影子区 `rsp+0x20` |
| 4+ | — | — | `rsp+0x28 + 8*(i-4)` |

**关键性质**：第 i 个参数的寄存器由**槽位序号**唯一决定，与前面参数的类型无关。所以不需要 libffi unix64 那套「SSE/GPR 独立计数 + 类型分类循环」（`ffi64.c:531-555`，我们的构建根本不编 `ffi64.o`）。

libffi 正是靠「同一槽读两次」实现免分类（`deps/libffi/src/x86/win64.S:67-74`）：
```asm
movq  (%rsp), %rcx    ; 槽0 → 整数视图
movsd (%rsp), %xmm0   ; 槽0 → 浮点视图（函数自己知道该读哪个）
movq  8(%rsp), %rdx
movsd 8(%rsp), %xmm1
...
```
这也是 `ffi_prep_cif_machdep` 能缩到 `n = max(nargs, 4); bytes = n * 8` 的原因（`ffiw64.c:99-103`）。

**我们的数据结构天然吻合**：`quickjs-ffi.c:51,60` 的 `args[]` 已经是低到高排列的连续 8 字节槽，`args[i]` 即槽 i，**零布局转换成本**。

**影子空间**：即使参数少于 4 个，调用方也必须预留 32 字节（MS Learn 明确：「The caller must always allocate sufficient space to store four register parameters, even if the callee doesn't take that many parameters」）。

**16 字节对齐**：`rsp` 必须在 `call` 指令处 16 对齐。`40 + 8*max(0, n-4)` 向上取整到 16 的倍数。

### 2.2 ia32：cdecl 全压栈；帧基准恢复让 cdecl/stdcall 通用

- `args[]` 从高到低 `push` 即得右到左压栈（cdecl 要求）
- **不需要 libffi 那套 1227 行跳表**：`sysv.S` 之所以复杂（store_table / load_table / `movl %ebp,%esp` 栈重平衡），是因为要同时吃 cdecl/stdcall/fastcall/thiscall 四种约定。我们只用 `FFI_MS_CDECL`（`ffitarget.h:114`）
- **double 按 8 字节整体压入**，与 `args[]` 槽布局一致
- **浮点返回走 x87 ST0**，需要 `fldl`/`fstpl` 显式搬运（EAX 与 ST0 都要取回，交由 C 分派）

#### 2.2.1 「帧基准恢复」机制详解（本方案 ia32 设计的核心依据）

**要解决的问题**：x86 栈由调用方分配，但**退栈责任**由约定决定：

| 约定 | 谁退参数 | 返回指令 | `call` 后 ESP |
|---|---|---|---|
| cdecl | 调用方事后 `add $N,%esp` | `ret`（仅弹 4 字节返回地址） | `argp-4` |
| stdcall | 被调方弹 N 字节参数 | `ret $N`（返回地址 + N 字节参数） | `argp-4-N` |

若调用方在 `call` 后**无条件**做 `add $N, %esp`：

- cdecl 被调方：`ret` 后参数仍在 → `add $N` 正好清干净 ✅
- stdcall 被调方：`ret $N` 已弹掉参数 → 再 `add $N` 就**多弹 N 字节**，ESP 冲进调用者栈帧中间 ❌

两种约定不能共用同一套事后清理动作。

**libffi 的解法：根本不做事后清理。** `deps/libffi/src/x86/ffi.c:311-313` 用 `alloca` 在自己栈帧上开参数区，且参数区地址是**绝对地址**（来自 alloca 指针），不依赖 ESP 当前值：

```c
bytes = STACK_ALIGN (cif->bytes);
stack = alloca(bytes + sizeof(*frame) + rsize);
argp  = (dir < 0 ? stack + bytes : stack);   /* cdecl/stdcall dir=+1 → argp = stack */
frame = (struct call_frame *)(stack + bytes);
```

进入 `ffi_call_i386`（`deps/libffi/src/x86/sysv.S:92`）后，**三行指令构成全部魔法**：

```asm
movl  %ecx, %ebp          /* sysv.S:107  ebp = &frame（我们自己的"栈帧基准"） */
movl  %edx, %esp          /* sysv.S:112  esp = argp（参数区底部）      */
call  *8(%ebp)            /* sysv.S:119  间接调用 fn                   */
```

`call` 压下的返回地址在 `argp-4`，参数区从 `argp` 起 —— 被调方看到 `esp+4` 起就是第一个参数，与普通 C 调用完全一致。

**返回之后的出口是全部要点**（`deps/libffi/src/x86/sysv.S:173-181`）：

```asm
L(e1):
	movl 8(%ebp), %ebx     /* 173  从我们自己的 frame 取回 callee-saved */
	movl %ebp, %esp        /* 174  ★ esp 由 ebp 无条件恢复 */
	popl %ebp
	ret                     /* 181  正常返回 ffi_call_int */
```

`movl %ebp, %esp` 是**无条件赋值**，既不读也不依赖被调方留下的 ESP 值：

- **cdecl 被调方**：`ret` 后 ESP = `argp-4` → 被整体覆盖，多余的参数区一起扔掉
- **stdcall 被调方**：`ret $N` 后 ESP = `argp-4-N` → 同样被覆盖

两条路径走**同一条出口**，栈都精确归零到 `&frame`。这就是「设 `%esp` 为自己的帧基准」的准确含义：`ebp = &frame` 是基准，`mov %ebp,%esp` 是**从基准重建**，而非增量调整。

**为什么必须这么做**：`call_frame`（`ffi.c:225-233`）存着调用所需的全部上下文，全部靠 ebp 相对寻址：

```c
struct call_frame {
  void *ebp;        /* 0  借用调用者的 ebp 做 unwind */
  void *retaddr;    /* 4  ffi_call_i386 自身的返回地址 */
  void (*fn)(void); /* 8  目标函数指针 */
  int flags;        /* 12 返回值类型码 */
  void *rvalue;     /* 16 返回值落地地址 */
  unsigned regs[3]; /* 20 thiscall 的 this 指针等 */
};
```

这对应源码注释 "black magic here to use some of the parent's stack frame"（`ffi.c:266-268`）——libffi 故意借用调用者栈帧且不遵循常规 ebp 约定，故关闭 MSVC 栈检查（`ffi.c:270-272`）。寄存器参数则从 `20(%ebp)` 取（`sysv.S:113-115`），即 `abi_params` 里 `static_chain` 的落点（`ffi.c:243-252`）。

#### 2.2.2 移植到我们的实现

我们的场景比 libffi 简单——只调 cdecl 语义、全压栈，**不需要 `abi_params` 表、不需要 `call_frame` 结构、不需要支持 4 种约定**。但可以直接复用它的关键手法（见 §3.4）：

| libffi | 我们 |
|---|---|
| `alloca` 开参数区（`ffi.c:311`） | `sub $nstack_bytes, %esp` |
| `movl %ecx, %ebp` 建立基准（`sysv.S:107`） | `mov %esp, %ebx` 保存 3 个 callee-saved 后的帧基准 |
| `movl %edx, %esp`（`sysv.S:112`） | `sub`+`and $-16` 已隐含 |
| `call *8(%ebp)`（`sysv.S:119`） | `call *func(%ebp)` |
| `movl %ebp, %esp`（`sysv.S:174`） | **`mov %ebx, %esp`** ← 机制核心 |

**净收益**：即使用户日后手工绑定了 `__stdcall` 导出的 DLL 函数也不会栈漂移——cdecl 与 stdcall 的**参数布局本身完全一致**（都是右到左压栈），差异仅在退栈责任，而该差异已被帧基准恢复完全吸收。

**必须遵守的前提**：调用点之后**不得有任何依赖 ESP 相对偏移的栈访问**，所有出参一律走 `%ebp`/`%ebx` 相对寻址。这是 §6 中「ia32 忘记 `mov %ebx,%esp` 恢复」列为高风险的原因——漏掉它，故障点会滞后到后续任意一次栈访问，排查成本极高。

### 2.3 死代码占比

移除后 `raw_api.o` / `java_raw_api.o` / `closures.o` / `tramp.o` 一并消失。当前链接体积约 x64 11KB / ia32 8KB，移除后新 asm 预计 < 2KB（x64 ~120 字节机器码，ia32 ~80 字节）。

---

## 3. 实现设计

### 3.1 新增文件

```
quickjs-ffi-type.h        # 12 个 FFI_TYPE_* 数值的本地定义 + qwin_ffi_arg_size[] 表
quickjs-ffi-call.h        # qwin_ffi_call_ia32/win64 的原型（含 ABI 约定的完整注释）
quickjs-ffi-call-ia32.S   # ia32：搬运参数区 + call + 取回 EAX:EDX/ST0   ✅ 已落地
quickjs-ffi-call-win64.S  # x64：寄存器装载 + call + 取回 RAX/XMM0       ⬜ S5
```

**为什么 C/asm 分成这样**：类型分类（决定每个参数占 4 还是 8 字节）、返回值按声明宽度截断/扩展、错误检查，全是纯 C 逻辑；asm 只做「按 ABI 搬运 + call + 取回原始返回」这一件机器必须做的事。x64 侧真正需要 asm 的只有约 15 条指令。

### 3.2 统一调用约定（C ↔ asm 内部约定，非 Windows ABI）

> ⚠️ **下列 ia32 签名是设计期草案，已被实施结果取代。**
> 实际 ia32 走的是「C 侧打包成连续 `argbuf` + asm 整体 `rep movsb`」，
> 且多一个 `ret_fp` 返回类别标志。实际签名见 `quickjs-ffi-call.h`：

```c
/* 实际 ia32 签名（S2/S3 已落地，quickjs-ffi-call.h） */
void qwin_ffi_call_ia32(void *func, const void *argbuf, uint32_t nstack_bytes,
                        uint64_t *out_int, double *out_fp, int ret_fp);

/* x64 尚未实现；S5 采用，注意事项见 §3.3.1 */
void qwin_ffi_call_win64(void *func, const uint64_t *slots, uint32_t nargs,
                         uint64_t *out_int, double *out_fp);
```

**为什么 ia32 改成了「C 打包 + 整体搬运」**（草案是传 `slots[]` 让 asm 逐槽搬运）：

- asm 里完全没有类型信息，两个架构的 `.S` 都能复用同一套「打包 ↔ 搬运」分层理念
- `rep movsb` 一条指令搞定，不需在 asm 里维护宽度表与槽偏移计算
- 参数区布局（每参数 4 或 8 字节、零填充）变成 C 里一段可读、可单测的循环

**两个架构的共同约定**：
- `out_int`：取回整数/指针返回值（RAX / EAX:EDX）
- `out_fp`：取回浮点返回值（XMM0 / ST0）
- `ret_fp`（ia32 专有）：**返回类别标志，不可省** —— 整数返回时 x87 栈为空，
  无条件 `fstpl` 属栈下溢，会置 `FE_INVALID` 并污染此后的 `fetestexcept()`。
  libffi 用返回跳转表处理同一问题（`CLASS_X87_RET`，`deps/libffi/src/x86/sysv.S`），
  我们用显式标志参数达到同样效果。

### 3.3 x64 asm 骨架

> ⚠️ **勘误（实施中发现的错误，勿照抄下面骨架）**
>
> 原骨架的内部调用约定写错了。注释里写的「用 SysV 风格内部签名最省事」是**错的**：
>
> - 本项目 x64 用 **mingw**（`x86_64-w64-mingw32-gcc`），C 侧默认 ABI 是 **Win64**，
>   不是 SysV。所以 `qwin_ffi_call_win64` 作为被 C 调用的普通函数，入参依次在
>   **`RCX` / `RDX` / `R8` / `R9`**，第 5 个及以后在栈上（`[rsp+0x28]` 起）。
>   写成 `rdi/rsi/rdx/rcx/r8` 会让 C 侧传的值和 asm 读的寄存器完全错位。
> - 原骨架 `call *%rdi` 里的 `%rdi` 已被 `lea 0x20(%rsp),%rdi` 覆盖成目标地址，
>   但 `rdi` 本应是 `func` —— 逻辑自身就不自洽。
> - 原骨架在 `rep movsq` 之后还用 `0x00(%rsi)` 读槽，但 `mov %rsi,%rsi` 是空操作，
>   源码读取的槽并未按 `overflow` 偏移。
>
> **S5 必须重写**，不能沿用。正确的 Win64 内部约定与实现要点见 §3.3.1。

#### 3.3.1 Win64 内部约定（S5 实际采用）

```c
/* C 侧声明；注意第 5 个参数 out_fp 落在栈上 */
void qwin_ffi_call_win64(void *func,          /* RCX */
                         const uint64_t *slots, /* RDX */
                         uint32_t nargs,      /* R8  */
                         uint64_t *out_int,   /* R9  */
                         double *out_fp);     /* [rsp+0x28] */
```

Win64 调用方（我们的 C 代码）在 `call` 之前已按 ABI 预留 32 字节影子空间，
故 stub **不需要自己 `sub $32`**；只需为「超过 4 个的溢出参数」额外让出栈空间：

```asm
        .text
        .globl C(qwin_ffi_call_win64)
C(qwin_ffi_call_win64):
        push  %rbp
        mov   %rsp, %rbp
        # rcx=func rdx=slots r8d=nargs r9=out_int  out_fp=[rsp+0x20](原 rsp+0x28 减 8)
        mov   %rcx, %r11            # r11 = func
        mov   %r8d, %r10d           # r10d = nargs
        sub   $4, %r10d             # 溢出参数个数
        jle   1f
        # 让出 16*n 并保持 16 字节对齐
        lea   16(%r10,%r10,1), %rax # 16*n
        and   $-16, %rax
        sub   %rax, %rsp
        lea   0x20(%rsp), %rdi      # 目标：影子区之后 = 溢出参数区
        lea   0x20(%rdx), %rsi      # src: slots+4（跳过前 4 个槽）
        mov   %r10d, %ecx
        rep movsq
1:
        # 前 4 槽双读（movq 给 GPR，movsd 给 XMM；Win64 允许两边都放）
        movq   0x00(%rdx), %rcx ;  movsd  0x00(%rdx), %xmm0
        movq   0x08(%rdx), %rdx ;  movsd  0x08(%rdx), %xmm1
        movq   0x10(%rdx), %r8  ;  movsd  0x10(%rdx), %xmm2
        movq   0x18(%rdx), %r9  ;  movsd  0x18(%rdx), %xmm3
        xor    %eax, %eax          # AL=0：非变参，但置 0 保证确定性
        call  *%r11                # ★ 用 r11，rcx/rdx 已被上面覆盖
        movq   %rax, (%r9)         # 整数/指针返回
        movsd  %xmm0, (%[原 out_fp])
        mov    %rbp, %rsp
        pop    %rbp
        ret
```

**要点**：
- **Win64 内部约定用 RCX/RDX/R8/R9**，第 5 参数在栈（与 x86-32 mingw 一样，符号要带
  `__USER_LABEL_PREFIX__`，见 §3.4.1）
- **影子空间由 C 调用方提供**，stub 不自己减 32（与 ia32 stub 自己 `sub` 参数区不同）
- **AL = 0**：虽不支持变参，但置 0 保证确定性
- **`movq`+`movsd` 双读**：即使槽 0 实际是整数，XMM0 里的垃圾值也无害（Win64 ABI 规定被调方按自己签名只读该读的视图）
- **`call` 前不能依赖 `rcx`/`rdx`**：上面已把它们覆盖成槽内容，故 `func` 必须提前存到
  callee-saved 寄存器（`r11`）或另存一份
- **⚠️ 未解问题（实施 S5 前必须先验证）**：前 4 槽双读要求 `slots[]` 至少有 4 个元素。
  当前 C 侧是 `uint64_t args[length]`，`length < 4` 时读 `slots[0..3]` 会越界。
  S5 必须二选一：把 C 侧数组长度改成 `max(length, 4)`，或让 asm 按 `nargs` 条件装载。
  这是 x64 特有的坑（ia32 路径按 `nstack_bytes` 搬运，`length=0` 时 `n=0`，不读任何槽）
  → **已解决**：采用 libffi 同款策略（`ffiw64.c:101-102`），C 侧 `args[]` 尺寸改 `max(length,4)`
  并整体清零，asm 无条件双读。见 §5 的 S5 实施结果。

### 3.4 ia32 asm 骨架

> ⚠️ **下方骨架是设计期草案，已被实施结果取代，勿照抄。**
>
> 实际实现（`quickjs-ffi-call-ia32.S`）在 4 处做了修正，见 §3.4.1。

```asm
qwin_ffi_call_ia32:                     # ← 实际实现用 C(__USER_LABEL_PREFIX__, ...)
        push  %ebp
        mov   %esp, %ebp
        push  %ebx
        push  %esi
        push  %edi
        mov   %esp, %ebx                # ★ 帧基准，必须在三次 push 之后取

        sub   nstack_bytes(%ebp), %esp
        and   $-16, %esp
        cld                             # ← 实施时补的防御
        mov   argbuf(%ebp), %esi
        mov   %esp, %edi
        mov   nstack_bytes(%ebp), %ecx
        rep movsb                      # ← 实施选了「C 打包 + 整体搬运」

        call  *func(%ebp)

        # --- 返回后一律走 ebp/ebx 相对寻址 ---
        mov   out_int(%ebp), %ecx       # 用 ecx 而非 eax（eax 刚当过寻址寄存器）
        mov   %eax, (%ecx)
        mov   %edx, 4(%ecx)             # ← 实施补的 64 位返回取回
        cmpl  $0, ret_fp(%ebp)          # ← 实施补的返回类别分支
        je    .Lno_fp
        mov   out_fp(%ebp), %ecx
        fstpl (%ecx)
.Lno_fp:
        mov   %ebx, %esp                # ★ 无条件从帧基准重建
        pop   %edi
        pop   %esi
        pop   %ebx
        pop   %ebp
        ret
```

**要点**：
- **不用 `push` 传参**，而是先对齐 `esp` 再用 store 写入 —— 这样能精确控制 16 字节对齐（`push` 会破坏对齐）
- **`mov %ebx, %esp` 强制恢复**：这是「cdecl 也能安全调 stdcall」的关键 —— **无条件赋值，不读被调方留下的 ESP**。被调方若是 stdcall 会 `ret $N` 多弹 N 字节，整个参数区连同其后的栈空间被 `%ebx` 一次性覆盖掉。完整机制与源码依据见 **§2.2.1**
- **`%ebx` 取帧基准的时机**：必须在 `push %ebx/%esi/%edi` **之后**取，否则基准指向 callee-saved 区块，会把这 12 字节一起当成参数区扔掉（看起来"能跑"，实际参数区少 12 字节 → 参数错位）
- **返回后禁止用 `%eax` 存间接寻址结果**：紧接 `call` 之后 `%eax` 已被用作 `call *func(%ebp)` 的寻址寄存器，故取 `out_int` 指针时改用 `%ecx`（libffi 在 `sysv.S:122` 用 `ecx` 是同类原因）
- **x87 搬运**：浮点返回从 ST0 落到 `out_fp`，**必须由 C 侧告知返回类别**（`ret_fp`），无条件 `fstpl` 会在整数返回时对空栈下溢并置 `FE_INVALID`
- **参数宽度由 C 计算** `nstack_bytes`，asm 只做一次 `rep movsb`

#### 3.4.1 实施结果与对草案的修正

设计期骨架与实际落地有 4 处差异，全部是实现/实测阶段发现并修正的：

| # | 草案的问题 | 实际做法 | 发现方式 |
|---|---|---|---|
| 1 | 帧偏移写成 `func=+4(%ebp)` | **`+8(%ebp)`** —— 标准 i386 帧里 `0(%ebp)`=保存的 ebp、`4(%ebp)`=返回地址，第一个参数在 `+8` | XP VM 跑边界用例直接崩 |
| 2 | 标签写死 `qwin_ffi_call_ia32:` | 用 `C(__USER_LABEL_PREFIX__, ...)` 宏 —— MinGW COFF 下 gcc 给 C 标识符加 `_` 前缀，汇编符号必须跟着加，否则链接报 undefined reference | 链接期报错 |
| 3 | 出口多了一句 `lea -4(%ebp), %esp` | **删掉** —— `ebx` 是三次 push 之后取的，此时 `esp` 已恰好指向保存的 `edi`，多做 4 字节会让 `ret` 跳到第一个入参而不是返回地址 | XP VM 崩 |
| 4 | 返回只写 `mov %eax,(%ecx)` | 补 `mov %edx, 4(%ecx)` —— 64 位返回走 `EDX:EAX`，否则 `sint64`/`uint64` 返回全错 | 边界用例（实施 S4 时补上） |
| 5 | 无条件 `fstpl` | 加 `ret_fp` 形参做分支 —— 整数返回时 x87 栈为空，`fstpl` 属栈下溢，会置 `FE_INVALID` 并污染此后 `fetestexcept()` | 数值对拍发现返回分类异常 |
| 6 | 无 DF 处理 | 显式 `cld` —— 若 DF 被上一段代码留成 1，`rep movsb` 会反向拷贝，直接踩坏调用者栈帧且不报错。ABI 规定 DF 进/出函数均为 0，清它不破坏任何调用者预期 | 代码审查（`rep movsb` 的经典坑） |

另有两点实现注记：

- **参数搬运选了「C 打包 + 整体 `rep movsb`」**（而非草案里的 asm 逐槽 store）：C 侧用
  `uint8_t argbuf[nstack ? nstack : 1]` VLA 逐槽 `memcpy` 出连续参数区，asm 只搬运。
  好处是 asm 完全不含类型信息，两个架构的 `.S` 能共用同一套内部约定。
  `nstack=0` 时 VLA 长度取 1，给 asm 一个合法可读指针（asm 侧 `n=0` 不会真的读）。
- **不用 `.type`/`.size`**：`@function` 语法是 ELF 专有，mingw 的 COFF 后端不认；
  PE 导出表由链接器自行生成，不需要它们。
- **栈帧大小是动态的**（`sub` 的长度来自参数），SEH 的 stackalloc 只能表达常量，
  故 gas 无法生成正确的 unwind 描述。实践无影响（唯一被调用方是 Win32 API，
  不向本帧抛异常，本调用链无 C++ 异常），`.cfi_*` 对 DWARF 消费者仍然正确。
  **若日后要支持「目标函数回调回到本帧」，必须先把帧改成常量大小。**

### 3.5 C 侧改动（`quickjs-ffi.c`）

> ⚠️ 下方是设计期草案。**实际实现见 §3.5.1** —— 落地时改用编译期开关分派，
> 且校验是「按参数逐个查 `qwin_ffi_arg_size[]` 是否为 0」而非显式列举类型。

**保留不动**：
- `:62-124` JS 值 → 8 字节槽的转换（这是业务逻辑，与 ABI 无关）
- `:134-170` 返回值读回（`switch(ret_type)` 显式截断/扩展 —— **ia32 上 libffi 不做符号扩展，这段逻辑正是为此存在，新实现继续依赖它**）
- `:208-223` 常量导出（改为 include 本地头）

**替换** `:126-132`：
```c
/* 旧 */
ffi_cif cif; ffi_status status; uint64_t ret = 0;
status = ffi_prep_cif(&cif, FFI_DEFAULT_ABI, length, ffi_types[ret_type], arg_types);
if (status != FFI_OK) return JS_ThrowTypeError(...);
ffi_call(&cif, func, &ret, ffi_args);

/* 新 */
uint64_t ret = 0; double fret = 0;
int rc = qwin_ffi_call_prepare(func, args, arg_types, length, ret_type, &ret, &fret);
if (rc != 0) return JS_ThrowTypeError(ctx, "ffi call unsupported: rc=%d", rc);
```

**新增校验**（把 UB 变成明确异常，这是相对 libffi 的净改进）：
```c
if (ret_type == FFI_TYPE_STRUCT || ret_type == FFI_TYPE_LONGDOUBLE)
    return JS_ThrowTypeError(ctx, "unsupported return type: %d", ret_type);
for (i...) if (arg_types_raw[i] == FFI_TYPE_STRUCT)
    return JS_ThrowTypeError(ctx, "struct argument not supported");
if (length > 64) return JS_ThrowTypeError(ctx, "too many arguments: %d", length);
```

**`ffi_types[]` 表退役**：换成 `size`/`align` 数值表：
```c
/* quickjs-ffi-type.h */
static const uint8_t qwin_ffi_size[] = { 0,0,4,8,0, 1,1,2,2,4,4,8,8, 0, sizeof(void*) };
static const uint8_t qwin_ffi_align[]= { 1,1,4,8,0, 1,1,2,2,4,4,8,8, 0, sizeof(void*) };
/* 下标 = FFI_TYPE_* 数值，0 = 不支持 */
```

#### 3.5.1 实施结果与对草案的修正

| # | 草案 | 实际 | 原因 |
|---|---|---|---|
| 1 | 抽出 `qwin_ffi_call_prepare()` 做统一入口 | **不抽**，在 `JS_CFUNC_DEF` 内部用 `#if defined(QW_FFI_BUILTIN_CALL)` / `#else` 就地分派 | 这个函数体只有一处调用点，包一层反而多一次间接；x64 路径将来直接换成汇编桩即可，分派点在原地更好读 |
| 2 | 显式 `if (arg_types_raw[i] == FFI_TYPE_STRUCT)` | **改成查表**：`if (qwin_ffi_arg_size[arg_codes[i]] == 0)` 抛异常 | 表里已经是「0 = 不支持」，查表同时覆盖 struct/longdouble/complex，新增类型时不必再补 if 分支 |
| 3 | 返回类型单独校验 | **只在参数侧查表；返回侧靠下方解码逻辑**处理 | 返回侧 `switch` 已有兜底，显式校验会重复 |
| 4 | 无 VOID 参数校验 | **新增** `VOID is not a valid argument type` | 宽度表里 VOID 是 0，会被当成「不支持」抛错，但错误信息会误导（用户只是写错了类型），故提前给出准确信息 |
| 5 | 宽度表同时给 `size`/`align` | **只保留 `qwin_ffi_arg_size[]`** | ia32 参数区零填充（每参数 4 或 8 字节前缀和），`align` 在本实现里没有消费者；S5 Win64 槽宽恒为 8 也不需要。留着会误导后人以为有对齐逻辑 |
| 6 | 32 位返回无处理 | **新增** `ret = (uint32_t)ret`（排除 DOUBLE/UINT64/SINT64） | 汇编固定写满 8 字节（否则拿不到 64 位返回的 `EDX:EAX`），32 位返回时高 4 字节是 EDX 垃圾。libffi 只写低 4 字节，不需要这一步 |

另外两点：
- **`ffi_args` / `arg_types` 数组在 builtin 路径上是死代码**（只服务 libffi 的
  `ffi_call`），当前用 `(void)` 显式抑制警告，S6 停用 libffi 时连同上面的槽赋值一起删除。
- **`QW_FFI_BUILTIN_CALL` 目前只在 `#if defined(__i386__)` 下由 Makefile 定义**，
  x64 仍走 libffi。S5 后改为按架构切换。

### 3.6 Makefile 改动

| 行号 | 改动 |
|---|---|
| `:19`, `:31` | 删除 `LIBFFI =` 两分支 |
| `:106-108` | 删除 `LIBFFI_DIR` / `LIBFFI_BUILD_DIR` / `LIBFFI_LIB` |
| `:111` | `CROSS_BUILD_LIBS` 去掉 `$(LIBFFI_LIB)` |
| `:126` | 删除 `-I$(LIBFFI_BUILD_DIR)/include` |
| `:136` | `LIBS` 去掉 `$(LIBFFI)` |
| `:386-397` | **删除整个 `$(LIBFFI_LIB)` 规则** |
| `:146` | 注释 `deps（wolfssl/brotli/ffi）` → 去掉 ffi |
| `:151-165` | `SRCS` 按 `ARCH_TAG` 加入 `quickjs-ffi-call-win64.S` 或 `quickjs-ffi-call-ia32.S` |
| `:167` | `OBJS` 加入对应 `.o` |
| `:228` 之后 | **新增** `$(OBJ_DIR)/%.o: %.S` 规则（项目当前零先例） |

新增的 `.S` 规则草案：
```make
$(OBJ_DIR)/%.o: %.S | $(WOLFSSL_LIB_STATIC)
	@echo "Assembling $<..."
	mkdir -p $(OBJ_DIR)
	$(CC) $(CFLAGS) -c -o $@ $<
```
> 注意：`$(CFLAGS)` 含 `-I$(LIBFFI_BUILD_DIR)/include` 需先删；`.S` 走 gcc 预处理需要 `.S` 大写扩展名（`.s` 不预处理）。还需确认 `-flto`（`BUILD=small`，`Makefile:132`）对 `.S` 的处理 —— 汇编不走 LTO，但 `-flto` 传给 gcc 汇编阶段通常无害（必要时给 `.S` 规则加 `-fno-lto`）。

### 3.7 其他配置改动

> ⚠️ **重要决策：`deps/libffi` submodule 保留，只从构建流程中移除。**
>
> 实施中明确决定：**不删 submodule**。理由：
>
> - 手写汇编 stub 的正确性论证大量引用 libffi 源码作为 ABI 依据
>   （`deps/libffi/src/x86/sysv.S:112/:174` 的帧基准恢复、`ffi.c:341-402` 的
>   参数区布局、`ffiw64.c` 的 Win64 影子空间）。删掉源码后这些引用全部失效，
>   后续维护者无从复核。
> - S5 实施 Win64 时仍需反复对照 `deps/libffi/src/x86/win64.S` / `ffiw64.c`。
> - 「移除 libffi」的主要动机是**去掉 autotools 交叉构建链**（见 §0），
>   而非去掉源码本身。submodule 只是 checkout，不参与构建，不影响这个动机。
>
> 因此 S6 的范围收窄为「**停止构建 libffi**」，而非「删除 libffi」。
> `.gitmodules` 保留条目，`deps/libffi/**` 保留内容，但：
> Makefile 不再引用、CI 不再 cache、Dockerfile 不再装 autotools（若确认无其他使用）。

| 文件 | 改动 |
|---|---|
| **`.gitmodules:18-21`** | **保留条目不变** —— libffi 源码继续作为 ABI 参考（见上方决策） |
| `Makefile:19,31,106-108,111,126,136,386-397` | 删除 `LIBFFI` 变量、`LIBFFI_DIR`/`LIBFFI_BUILD_DIR`/`LIBFFI_LIB`、`CROSS_BUILD_LIBS` 中的 `$(LIBFFI_LIB)`、`-I$(LIBFFI_BUILD_DIR)/include`、`LIBS` 中的 `$(LIBFFI)`、整个 `$(LIBFFI_LIB)` 规则 |
| `docker/Dockerfile.dev:14-15` | `autoconf automake libtool libtool-ltdl-devel` 暂时**保留** —— libffi 源码虽不构建，但若要手工跑对拍（§4.3）仍需它的 autotools 链。等对拍彻底不再需要时再删。**已验证：autotools 仅 libffi 使用**（brotli 走 cmake `Makefile:370-384`，wolfssl 走 cmake `:359-368`，quickjs 直接编 C `:201-210`） |
| `.github/workflows/ci-qemu.yml:165-167` | 删除 libffi cache 路径与 `deps/libffi/**` cache key —— 停止构建后不该再有 `.a` 产物；保留 cache key 会掩盖「是否真的还在编译 libffi」 |
| `README.md:33` / `README.en.md:33` / `docs/quickwin-intro.md:32` | 「通过 libffi 调用任意 DLL 函数」→ 改为描述内建 FFI |
| `.agents/DEVELOPMENT_WORKFLOW.md:97,105` | 构建目录说明 + deps 列表（注明 libffi 源码保留但不再构建） |
| `.agents/QEMU_NET_SUITE_TEST.md:93` | libffi 清理提示改为「libffi 已不参与构建，源码仅作参考」 |
| `.agents/TODO.md:17` | 标记完成 |
| `.agents/LIBFFI_PRINCIPLES.md` | 顶部加「**已不参与构建，本文档与 `deps/libffi` 源码仅作原理/ABI 参考保留**」横幅；新增一节「手写替代实现的设计与踩坑」 |

**验收（S6）**：
- `grep -rn "LIBFFI\|libffi" Makefile` 无结果
- `grep -rn "autotools\|autoconf" .github/workflows/ci-qemu.yml` 无结果
- 干净容器（submodule 已 checkout）`make cc64 cc32 && make js && make exec_server` 通过
- XP/Win11 全套测试全绿
- `git submodule status` 仍能看到 `deps/libffi`（**未删除**）

---

## 4. 测试计划

### 4.1 现有套件（必须全绿，xp + win11）

| 套件 | 文件 | 与新实现的关系 |
|---|---|---|
| `ffi` | `test/test_ffi.ts` | 经 `bind()` DSL 调 `EnumPrintersW`（7 参）+ `GetDC`（ptr 直通/NULL）→ **参数搬运的主要回归网**；早期版本直呼 `ffi.ffiCall`，已随旧 API 删除而迁移 |
| `ffi-bind` | `test/test_ffi_bind.ts` | 11 项，经 `bind()` DSL；含 f32/f64 锚点（`msvcrt!sqrt/atan2`、`gdi32!AngleArc`） |
| `ffi-struct` | `test/test_ffi_struct.ts` | 纯 TS 布局 + `readByte/writeByte`，**不经过 asm**，但 API 表面不能破 |

基线：改动前 win11/xp 全套 `-net` **367/367**。

> **win7 已从计划中移除**：现有 QEMU 测试环境只提供 xp(ia32) 与 win11(x64)，
> 没有 win7 镜像。Win64 ABI 由 win11 x64 覆盖，win7 无独立价值。

**实施后实测基线**（S3 完成后）：

| 平台 | 后端 | `ffi` 套件 | 全套 |
|---|---|---|---|
| XP (ia32) | **内建汇编** | 88/88 | **557/557** |
| Win11 (x64) | libffi（未切） | 88/88 | **557/557** |

数值锚点：`sqrt(2) = 1.4142135623730951`。

> **最终**（S4 后）：XP / Win11 双平台全套 **588/588**（`ffi`+`ffi-bind`+`ffi-struct`+`ffi-abi`）。
> 其中 `ffi-abi` 31 项为 §4.2 的 ABI 边界网，双平台 31/31。

### 4.2 新增边界用例（针对 asm 最易错维度）

> 已固化为 `test/test_ffi_abi.ts`（suite `ffi-abi`，31 项，XP + Win11 全绿）。实现方式：
> 为每个维度找真实存在的 Win32/CRT 函数（不新增测试专用导出）；缺函数的平台记 SKIP。

| 维度 | 用例 | 为什么关键 | 覆盖（真实函数） |
|---|---|---|---|
| **参数个数分界线** | 0 / 1 / 3 / **4** / **5** / 6 / 8 / 12 参数 | 4 是 Win64「寄存器→栈」分界；0 参数验证影子空间仍然预留 | `GetTickCount`(0)/`fabs`(1)/`memcpy`(3)/`GetLocaleInfoA`(4)/`SetRect`(5)/`CompareStringW`(6)/`WideCharToMultiByte`(8)/`SetDIBitsToDevice`(12，内存 DC) ✅ |
| **整浮混合** | `(f64, i32)` / `(f64, ptr)` | 验证「同槽双读」后 GPR/XMM 各自就位，且不互相污染 | `ldexp`(f64,i32)、`frexp`/`modf`(f64,ptr)、`AngleArc`(f32×2) ✅ |
| **前 4 全浮点** | `(f64 f64 f64 f64 -> f64)` | 只走 XMM0-3，GPR 全空 | ⚠️ 无三平台通用 4-double CRT 函数；由 `atan2`(XMM0-1) + `AngleArc f32×2` 部分覆盖，缺口已记录 |
| **前 4 全整数/混整** | 4 个参数填满 RCX-R9 | 只走 GPR | `GetLocaleInfoA(u32 u32 ptr i32)` ✅（第 4 参在 R9） |
| **负数返回** | `sint32/16/8` 返回负值；`sint64` 负值 | 解码在 `lib/ffi/bind.ts` 的 `readRet()`（旧 C 截断逻辑已迁走） | `lstrcmpW -> i32/i16/i8` 均 <0；`InterlockedIncrement64(-2) -> i64 = -1` ✅ |
| **窄整型传参** | `u8/i8/u16/i16` 传负值/大值 | 验证槽内低 N 字节按 2 的补码填、高位语义正确 | `abs(i8 -128/-5)`、`abs(u8 200)`、`abs(i16 -300)`、`abs(u16 60000)` ✅ |
| **指针 NULL** | `ptr` 参数传 `null` / `undefined` | `slotPtr()` 归一化为 0 | `GetDC(null/undefined)` 非空、`IsWindow(null)=FALSE` ✅ |
| **大 64 位** | `i64/u64` 传 `2^32+1` 与全 1 | 验证 8 字节槽（ia32 占两槽） | `InterlockedExchange64` 传 `2^32+1`/`-1` 后取回原值 ✅ |
| **float→double promotion** | f32 vs f64 槽宽 | 验证 f32 只写 4 字节不污染邻槽 | `AngleArc`(f32×2 相邻) + `sqrt`(f64) ✅；变参 promotion 不支持（变参 ABI 未实现） |

> **已知缺口**：`(f64 f64 f64 f64 -> f64)` 无通用真实函数（`fma` 仅新 CRT、`_CI*` 用编译器私有约定）。
> 其余维度均有真实函数覆盖；变量参数（varargs）不属本次范围。


### 4.3 对拍验证 —— **已决定跳过**

原设计是保留 libffi 构建路径 + 编译期开关（`QW_FFI_BACKEND=libffi|builtin`），
用同一批 bind 同时走两条实现、逐项比对返回值。

**决定跳过**，改为「ia32 全绿 → Win64 全绿 → 停用 libffi」分架构验证（§5）。
理由：对拍需要同时构建两套后端并维护对拍 harness，成本高；而现有三套件本身
就在调真实的 `msvcrt` / `user32` / `gdi32` / `kernel32` 函数，**返回值本身就是
标准答案**（`sqrt(2)` 必须是 `1.4142135623730951`），对拍的增量价值有限。

⚠️ 前提是 §4.1 三套件必须真全绿 —— 若哪一项因环境原因被 skip，对拍网就不成立。

> 附带好处：因为 `deps/libffi` 源码保留（§3.7），将来若仍想做对拍，
> 随时可以把 `QW_FFI_BUILTIN_CALL` 打开/关掉跑一轮，源码和 autotools 链都还在。

---

## 5. 执行步骤（S1–S7，每步独立可验证）

> 原始的 4 步划分在实施中调整为 7 步。原因是「asm 实现」必须按架构切开落地：
> 先把 ia32 单独跑通并全绿，确认手写 stub 的 ABI 推导无误，再做 Win64 ——
> Win64 的参数布局风险点（影子空间、寄存器/栈分界）完全不同，与 ia32 混在一步里
> 出问题时无法定位是哪一侧的错。
>
> 已确认**跳过对拍**（§9 第 1 条）：改为「先 ia32 全绿 → 再 Win64 全绿 → 再停用 libffi」，
> 每一步都有真实 Win32 API 调用做回归网，等价于对拍但成本低得多。

| 步骤 | 内容 | 状态 |
|---|---|---|
| **S1** | `quickjs-ffi-type.h`（本地 `FFI_TYPE_*` + `qwin_ffi_arg_size[]`）、`quickjs-ffi-call.h` 声明、与 libffi 的 `_Static_assert` 交叉核对 | ✅ `223076b` |
| **S2** | `quickjs-ffi-call-ia32.S` 汇编桩落地（**不接线**，先验证能汇编/链接/符号正确） | ✅ `403ccfa` |
| **S3** | ia32 接线：C 侧打包 `argbuf` + `#if __i386__` 分派；Makefile 加 `.S` 规则 | ✅ `403ccfa` |
| **S4** | 新增边界用例（§4.2） | ✅ `test/test_ffi_abi.ts`（`ffi-abi` 31 项，XP+Win11 全绿） |
| **S5** | `quickjs-ffi-call-win64.S` + x64 接线（**必须用 Win64 内部约定，见 §3.3.1**；原 §3.3 骨架有错，勿照抄） | ✅ 已落地 |
| **S6** | 把 libffi **移出构建流程**（Makefile 9 处 + CI cache）。**submodule 与源码保留作 ABI 参考**，见 §3.7 | ✅ 已落地 |
| **S7** | 文档同步（原 Step 4，从 S6 拆出） | ✅ 已落地 |

> S2/S3 合并进了同一个 commit `403ccfa`：`403ccfa` 同时包含汇编桩与接线。
> 合并原因是 stub 必须接线才能在 XP VM 里跑出真值 —— 单独提交一个不可达代码路径
> 的汇编文件没有验证价值。分步的价值在于「ia32 与 Win64 切开」，这个仍然保留。

### S1 — 基础设施（已完成，`223076b`）
1. 新建 `quickjs-ffi-type.h`：12 个导出常量（**数值与 `ffi.h.in:60-82` 逐一对齐**）
   + `qwin_ffi_arg_size[]`（只保留宽度，`align` 无消费者，见 §3.5.1）
2. `quickjs-ffi.c` include 本地头；`ffi_types[]` 表退役
3. 修 `ffi_types[]` FLOAT/DOUBLE 槽位错位 + 补 `ffi_prep_cif` 状态检查
4. 新增 `quickjs-ffi-call.h` 声明 + 与 libffi 的 `_Static_assert` 交叉核对
5. **验收**：`make cc64 cc32` 通过；XP/Win11 全套 367/367

### S2+S3 — ia32 汇编桩与接线（已完成，`403ccfa`）
1. 写 `quickjs-ffi-call-ia32.S`（修正草案的 6 处问题，见 §3.4.1）
2. C 侧在 builtin 分支里打包 `argbuf` VLA + 调用汇编桩；x64 仍走 libffi
3. Makefile 加 `$(OBJ_DIR)/%.o: %.S` 规则 + 按 `ARCH_TAG` 挂 `.S` 到 `SRCS`/`OBJS`
4. **验收**：XP `ffi` 88/88、全套 557/557；Win11 同上（未切后端，行为不变）

### S4 — 边界用例（已完成）
1. 覆盖 §4.2 的维度，落到新增的 `test/test_ffi_abi.ts`（suite `ffi-abi`，31 项）
2. **验收**：XP / Win11 全套 **588/588** 保持（原 557 + 新增 31），`ffi-abi` 双平台 31/31

**S4 关键疑点已澄清（本轮结论）**：`user32!FillRect` 探针在 XP VM 上超时，
**是探针自身的入参错误，不是 ia32 汇编的问题**。
探针当时传的是 `FillRect(dc, 0, 0, 10, 10)` —— 即 `NULL RECT*` + `NULL HBRUSH`，
却用在一个 `GetDC(0)` 得到的真实 DC 上，GDI 在 QEMU（无交互桌面）里挂死。
用有效句柄重测返回 `1`（成功）。

同一轮用「纯内存、可回读」的真实函数隔离了参数个数维度，全部落位正确：

| 用例 | 签名 | 验证点 |
|---|---|---|
| `SetRect` | `ptr i32 i32 i32 i32 -> void`（5 参,20B） | 回读 4 个 int 全对 → **5 参 cdecl 搬运正确** |
| `CreateRectRgn` + `PtInRegion` | `i32*4 -> ptr` + `ptr i32 i32 -> u32` | 区域句柄 + `PtInRegion(0,0)=1` → 句柄 ID 正确（非崩溃巧合） |
| `FillRect` | `ptr ptr ptr -> i32`（有效 hdc/rct/br） | 返回 1（成功） → GDI 真实调用正常 |
| `AngleArc` | `ptr i32 i32 u32 f32 f32 -> i32`（6 参,含 f32） | 返回 1（成功） → 整/浮混合多参正确 |

结论：**「多参数汇编搬运」维度已通过真实函数验证**，S4 无汇编阻塞。
本轮已把这些维度连同其余边界（窄整型传参、大 64 位、负数返回、NULL 指针、0/1/3/4/8/12
参数分界、整浮混合）固化为 `test/test_ffi_abi.ts`，XP/Win11 双平台 `ffi-abi` 31/31 全绿。

### S5 — Win64 汇编桩与接线
1. 按 **§3.3.1** 写 `quickjs-ffi-call-win64.S`（**不要用 §3.3 的原骨架**）
2. **先解决 §3.3.1 标出的 `slots[0..3]` 越界问题**（`length < 4` 时读越界）
3. C 侧按架构切到 `qwin_ffi_call_win64()`；`QW_FFI_BUILTIN_CALL` 的定义从 `__i386__`
   改为无架构限定
4. **验收**：Win11 `ffi` 88/88、全套 557/557（此时后端才是真正全量内建）

**S5 已落地（本轮结论）**：

- **`slots[0..3]` 越界已解决**：采取 libffi 同款策略（`ffiw64.c:101-102` 的 `n<4 → n=4`），
  C 侧把 `args[]` 尺寸改为 `max(length,4)` 并整体清零。ia32 路径按 `nstack` 搬运不受影响。
- **`quickjs-ffi-call-win64.S`**：与 libffi `win64.S` 逐点对齐——前 4 槽 `movq+movsd` 双读、
  溢出参数区在 32 字节影子空间之后、`call` 用 callee-saved `r12`（RCX/RDX/R8/R9 已被槽覆盖）、
  `AL=0` 保确定性、返回恒写 `RAX`+`XMM0`（等效 libffi 的返回跳转表）。
- **C 侧接线**：`QW_FFI_BUILTIN_CALL` 改为 `__i386__ || __x86_64__`；
  内建块按架构二选一（ia32 打包 argbuf / x64 直传 8 字节槽数组）；
  `ret=(uint32_t)ret` 掩码只留 ia32（x64 指针返回是完整 8 字节，不能截断）。
- **验证**（真实 Win32 API 探针 + 全量回归）：
  - Win11 x64：`ffi` 88/88、全量 **557/557**（已走内建桩，libffi 仅链接未调用）
  - XP ia32：全量 **557/557**（共享 C 路径改动未回归）
  - 探针覆盖 `length<4` 路径：0/1/2/3 参、f64 返回（`sqrt`/`atan2`）、5 参混合、7 参 `EnumPrintersW` 全过
- **遗留**：`libffi.a` 仍被链接（`_build/deps/*/libffi.a`），S6 清理。

### S6 — 把 libffi 移出构建流程（**不删 submodule/源码**，见 §3.7）
1. Makefile 9 处 libffi 引用全删（`:19,:31,:106-108,:111,:126,:136,:386-397`）
2. `.github/workflows/ci-qemu.yml` 删 cache 路径与 `deps/libffi/**` cache key
3. `quickjs-ffi.c` 删掉 `ffi_args`/`arg_types` 与 libffi 分支
4. `.gitmodules` **不动**；`deps/libffi/` 源码**不动**（保留作 ABI 依据，见 §3.7 决策）
5. `Dockerfile.dev` 的 autotools 包**暂时保留**（手工对拍可能还要用，见 §4.3）
6. **验收**：
   - `grep -rn "LIBFFI\|libffi" Makefile` 无结果
   - 干净容器 `make cc64 cc32 && make js && make exec_server` 通过
   - XP/Win11 全套全绿
   - `git submodule status` 仍显示 `deps/libffi`（确认未误删）
7. 体积对比记录（新旧 exe 大小）

**S6 已落地（本轮结论）**：

- **Makefile**：9 处 libffi 引用全删——`LIBFFI` 两处变量、`LIBFFI_DIR/BUILD_DIR/LIB` 定义、
  `CROSS_BUILD_LIBS` 依赖、`-I$(LIBFFI_BUILD_DIR)/include`、`LIBS` 里的 `$(LIBFFI)`、
  以及 `$(LIBFFI_LIB)` 构建规则（autotools/configure/make 整块删除）。
- **CI**：`ci-qemu.yml` cache path 删掉 `libffi.a` 与 `libffi-build/include/`，
  cache key 的 `deps/libffi/**` hash 一并移除。
- **quickjs-ffi.c**：删掉 `#include <ffi.h>`、`QW_FFI_REF_*` enum + `_Static_assert` 交叉核对、
  `ffi_types[]` 表、`arg_types[]`/`ffi_args[]` 数组及其填充循环、`ffi_prep_cif`/`ffi_call` else 分支。
  `FFI_TYPE_*` 数值来源收窄为 `quickjs-ffi-type.h`（注释已更新）。
- **干净重建验证**：删掉 `_build/obj`、libffi 的 `libffi-build/` 与 `libffi.a` 后，
  `make cc64`/`cc32` 全程无 libffi 编译/链接；最终 exe 链接行不含 `libffi.a`。
- **产物符号**：`strings qwin.exe | grep ffi_...` 无 `ffi_prep_cif`/`ffi_call_win64` 等 libffi 残留。
- **回归**：Win11 x64 全量 **557/557**、XP ia32 全量 **557/557**。
- **保留**：`.gitmodules` 与 `deps/libffi/` 源码原样（submodule 状态、`ffi.h.in`、`win64.S` 均在）。
- **体积对比**（本次干净重建后，strip 过）：`qwin.exe`(x64) = 2108942 B、`qwin-x86.exe`(ia32) = 2008078 B。
  （上一轮 `403ccfa` 后的旧产物基线未留存，故只记本次数值；体积主要由链接体积决定，
   libffi 内建化在 ia32 侧从 commit 403ccfa 起就生效，x64 侧自 S5 起生效。）

### S7 — 文档同步（已完成）
1. ✅ `LIBFFI_PRINCIPLES.md` 标题下加横幅「已不参与构建，源码仅作 ABI 参考保留」，
   文末新增「9. 手写替代实现（本项目现状）」：文件职责表 + libffi 概念到本地实现的对应关系。
2. ✅ `FFI_ARGS_RET_SEMANTICS.md` 全篇改为通用 ABI 描述：传参/返回值代码指向
   `lib/ffi/bind.ts`（`ARG_SIZE`/`writeSlot`/`readRet`），历史 `FFI_TYPE_*` 教训保留但
   修复描述改为 `'ptr'`；测试锚点补 `test_ffi_abi.ts`；win7 表述改为 xp/win11。
3. ✅ README / `README.en.md` / `docs/quickwin-intro.md` 的 FFI 条目改为「内置汇编调用桩 + `bind()`」；
   `DEVELOPMENT_WORKFLOW.md` 去掉 deps 产物与构建库清单里的 `libffi.a`；
   `QEMU_NET_SUITE_TEST.md` 历史清产日志去掉 libffi。
4. **验收（修订）**：`grep -rn -i libffi --include='*.md' --include='*.c' --include='*.h' --include='Makefile' .`
   的**非 `deps/libffi/`** 命中仅剩：
   - 本计划文档、`LIBFFI_PRINCIPLES.md`（原理/历史，明示已不参与构建）；
   - `quickjs-ffi-type.h`（不编译，ABI 数值出处即为 libffi 源码，属保留依据）；
   - 各文件里指向本计划文件名的链接 `REMOVE_LIBFFI_PLAN.md`；
   - `.agents/FFI_ARGS_RET_SEMANTICS.md` / `.agents/TODO.md` 的历史提交/完成记录。
   构建侧（`Makefile`、CI）已确认 0 命中。

---

## 6. 风险与缓解

| 风险 | 后果 | 缓解 |
|---|---|---|
| **Win64 栈对齐算错** | 运行时崩溃（被调函数用 `movaps` 等 16 对齐指令） | asm 内统一按 16 对齐，公式在代码里写死并加注释；所有 Win32 API 调用都过此路径，测试必然覆盖 |
| **Win64 影子空间不足 32B** | 被调函数 spill 寄存器时踩坏栈 | 影子空间由 C 调用方按 ABI 自动提供，stub 无需自己 `sub $32`（§3.3.1） |
| **Win64 前 4 槽越界读** | `length < 4` 时读 `slots[0..3]` 越界，行为未定义 | **S5 前必须解决**：C 侧数组长度改 `max(length,4)`，或 asm 按 `nargs` 条件装载（§3.3.1 末尾） |
| **ia32 忘记 `mov %ebx,%esp` 恢复** | 调 stdcall Win32 API 后栈漂移，**崩溃点滞后难查** | 恢复语句与 `call` 相邻，注释直接引用 **§2.2.1** 的机制说明；S4 首次跑边界用例时先用 stdcall 导出的 DLL 函数验证。✅ 已实际发生并修复（§3.4.1 #1） |
| **ia32 `%ebx` 帧基准取值时机错** | 基准指向 callee-saved 区块，参数区少 12 字节 → 参数静默错位（不崩、结果错） | `mov %esp,%ebx` 必须在三次 `push` **之后**；代码评审重点项 |
| **ia32 浮点返回 ST0 漏取** | 返回值读回垃圾（`sqrt` 返回 0） | asm 用 `fstpl` 落地 `double`；`msvcrt!sqrt`/`atan2` 已覆盖 f64，f32 走 `AngleArc`。✅ 已实测 `sqrt(2)=1.4142135623730951` |
| **ia32 整数返回时无条件 `fstpl`** | x87 空栈下溢，置 `FE_INVALID` 污染 `fetestexcept()`；默认掩蔽下**不崩**，故极易漏测 | asm 加 `ret_fp` 形参做分支，只在真的是浮点返回时碰 x87。libffi 用返回跳转表处理同一问题（`CLASS_X87_RET`） |
| **`--gc-sections` 误删 asm 段** | 链接失败 undefined symbol | C 侧取 asm 函数地址（存入静态 volatile 指针）即可防优化删除 |
| **`-flto`（`BUILD=small`）干扰 `.S`** | 汇编阶段报错 | 必要时 `.S` 规则加 `-fno-lto`；`make BUILD=small` 必测 |
| **Dockerfile 删 autotools 过度** | 容器构建失败 | 已验证 autotools 仅 libffi 使用；但 brotli/wolfssl 的 cmake 依赖需保留。**且当前决定保留 autotools**（libffi 源码虽不构建，手工对拍可能还要用，§3.7） |
| **CI cache 残留旧 libffi 产物** | 掩盖构建问题（用了旧 `.a`） | cache key 移除 `deps/libffi/**` 后，cache 失效重建 |
| **误删 `deps/libffi` 源码** | 后续失去 ABI 依据：stub 正确性论证、S5 实现、手工对拍都依赖它 | submodule 与源码一律保留，S6 只改构建流程（§3.7）；验收里显式检查 `git submodule status` 仍能看到它 |
| **P1 未决问题叠加** | `ListView.tsx:67-72` dwItemSpec 布局 bug 与本改动无关但会一起进 CI | 建议先提交已验证的 ffi 修复，再开本改动，避免混淆回归来源 |

---

## 7. 附带发现（与本计划独立，但需单独排查）

调研中发现 **i686 mingw 的已知 ABI bug**（mingw-w64/mingw-w64#30，标记「known and won't be fixed」）：

> i686-w64-mingw32-gcc 假定入栈时栈已 16 字节对齐（沿用 i386 SysV ABI 习惯），但 Win32 ABI 只要求 4 字节对齐。当程序从 Windows 回调（`WndProc` / `CreateThread`）进入且回调函数体含 SSE 对齐指令时，会因栈未对齐触发 `movaps` → **General Protection Fault**。

- **与本改动无直接关系**（我们只主动调 Win32 API，不做回调）
- 但 **`quickjs-gui.c` 的 WndProc 等回调入口是否受影响，需要单独排查** —— 这是潜在存量问题，不是本次引入
- 若确认存在，缓解手段：`-mstackrealign`（给每个函数序言加对齐代码）或给回调加 `__attribute__((force_align_arg_pointer))`
- **另需确认本项目是否已用 `-mstackrealign` 或 `-mpreferred-stack-boundary=2`**

---

## 8. 附：手写实现与 libffi 的能力对照

| 能力 | libffi 现状 | 新实现 | 说明 |
|---|---|---|---|
| 标量 12 类型 | ✅ | ✅ | 对等 |
| x64 Win64 ABI | ✅ | ✅ | 对等 |
| ia32 cdecl | ✅ | ✅ | 对等 |
| ia32 stdcall 被调 | ✅（栈平衡） | ✅（`mov %ebx,%esp`） | 对等 |
| 整数/浮点返回 | ✅ | ✅ | 对等 |
| struct 传参/返回 | ✅ | ❌ 明确抛异常 | 当前零使用 |
| 变参函数 | ✅ | ❌ | 当前零使用 |
| closure/回调 | ✅ | ✅ 自建（quickjs-ffi-closure） | 不依赖 libffi closure_alloc |
| bigint 精确 | 需 `JS_ToInt64Ext` | ❌ 同现状 | 不在范围内 |
| 错误检查 | 需手动查 `FFI_OK` | ✅ 内建校验 | 净改进 |
| 链接体积（x64） | ~11KB | < 1KB | |
| 外部**构建**依赖 | submodule + autotools | 无 | 核心目标 |
| 外部**源码**依赖 | — | `deps/libffi` 保留 | 不参与构建，仅作 ABI 依据（§3.7） |

---

## 9. 待确认事项

> 已全部拍板，逐条结论见 §9.1。

1. ~~**Step 2 的对拍阶段是否保留？**~~ → **跳过对拍**。改为分架构落地：ia32 全绿 → Win64 全绿 → 停用 libffi。每一步都有真实 Win32 API 调用做回归网，等价覆盖但成本低得多。
2. **文件命名**：已定 —— `quickjs-ffi-call.h` / `quickjs-ffi-call-ia32.S` / `quickjs-ffi-call-win64.S` / `quickjs-ffi-type.h`，分类逻辑留在 `quickjs-ffi.c`。
3. ~~**是否先提交上一轮已验证的 ffi 修复？**~~ → **已提交**（`223076b`，win11/xp 367/367）。
4. **§7 的 i686 栈对齐问题** → **单独立项**，不并入本计划。
5. **参数个数上限 64** → **维持 64**（当前最大用到 10；ia32 下 64×8=512 字节栈区仍安全）。
6. **struct by-value 传参/返回** → **暂不支持**，见 §10.4 的后续设计。
7. **是否把 ABI 复杂度整体移到 JS 侧** → **已落地**（§10）。
8. ~~**是否删除 `deps/libffi` submodule？**~~ → **不删。只移出构建流程**。理由见 §3.7：手写 stub 的 ABI 论证大量引用 libffi 源码（`sysv.S:112/:174`、`ffi.c:341-402`、`ffiw64.c`），删掉后无法复核，S5 也失去对照依据。

### 9.1 已确认的决策摘要

| 事项 | 结论 |
|---|---|
| 对拍 | 跳过，用「分架构全绿」替代 |
| 文件命名 | `quickjs-ffi-call-{ia32,win64}.S` + `.h` + `quickjs-ffi-type.h` |
| 参数上限 | 64 |
| struct | 不支持 |
| libffi submodule | **保留**，只移出构建流程 |
| JS 侧重构 | **已落地**（§10） |

---

## 10. 后续演进：把 ABI 复杂度移到 JS 侧（已落地）

> **状态：已落地（§10 重构完成）。**
> 起因：实施过程中发现 C 侧的参数打包逻辑（§3.4.1 的 VLA + `memcpy` 逐槽）虽然只有
> 几十行，但它是整条链路里**唯一需要同时理解「类型宽度表」和「平台 ABI」**的地方，
> 也是唯一一处出错时会静默传错值的热路径。把它下沉到 JS 后，C 侧退化成纯粹的
> 「memcpy + call」，ABI 知识全部集中在 `lib/ffi/bind.ts`（TS，可读性远高于 C）。

### 10.1 目标接口

旧 JS 侧签名（**已删除**）：
```ts
ffiCall(func: number, argTypes: FfiType[], args: (number|null|ArrayBuffer)[], retType: FfiType): ...
```

最终接口（`quickwin.d.ts`）：
```ts
ffiCall(func: number, argFrame: ArrayBuffer, retBuf: ArrayBuffer, retIsFp: 0 | 1): void;
```

C 侧对应 `js_ffi_call`（`quickjs-ffi.c`）：
```c
/* argFrame 是 JS 预先打包好的连续参数区；retBuf 是 JS 分配的返回缓冲区。
   两者真实大小即所需大小（JS 总是 new ArrayBuffer(total) 后原样传入）。 */
static JSValue js_ffi_call(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv);
```

> 迁移期曾用 `ffiCallRaw` 作为新导出的临时名，全绿后改名 `ffiCall` 并删除旧同名打包函数。

### 10.2 收益

| 项 | 说明 |
|---|---|
| C 侧简化 | `quickjs-ffi.c` 删掉 VLA + 逐槽 `memcpy`；只保留 `memcpy(out, argFrame, n)` + 一次 `call` |
| ABI 知识收敛 | 宽度表 / 槽对齐 / string 编码全部只在 `lib/ffi/bind.ts` 一处 |
| 可测试性 | 参数打包变成纯 TS 函数，可直接单测（当前 C 侧打包只能靠真实 Win32 调用间接验证） |
| 调试成本 | 出错时可以在 JS 侧 `DataView` dump 整个 `argFrame`，而不用 gdb 看 C 的栈 |

### 10.3 关键约束

1. **`ret_is_fp` 不能省。** 即使改成 JS 传 `retBuf`，x87 返回分类仍必须传递 ——
   整数返回时 x87 栈为空，无条件 `fstpl` 会置 `FE_INVALID`（S3 期间实测踩过）。
   这一点和 libffi 用返回跳转表处理 `CLASS_X87_RET` 是同一个道理，
   即便把参数全搬到 JS 也不会消失。
2. **`retBuf` 长度由 JS 决定。** 但当前 ia32 stub 无条件写 8 字节（`movl %eax` 写 4 字节到
   `uint64_t` 槽的完整宽度），所以 JS 侧必须保证 `retBuf.byteLength >= 8`，
   或者后续给 stub 增加「返回宽度」参数。**这一点在实现时必须显式校验，不能靠约定。**
3. **`argFrame` 布局必须写死在 TS 里并加注释**，且与 `quickjs-ffi-type.h` 的宽度表
   做一致性断言（可在构建期或启动期 `assert`）。
4. **string / ArrayBuffer 参数的编码保持不变** —— 那是 `lib/ffi/bind.ts` 现有职责，
   本次重构只是把编码结果从 C 的 VLA 搬到 TS 的 `DataView`。

### 10.4 struct by-value（尚未设计）

- 传参：TS 侧按平台 ABI 算好 struct 的对齐/填充，写进 `argFrame`。
- **返回：这是真问题。** IA32 与 Win64 都用 hidden return pointer（caller 在 ESI/RCX
  传指针给 callee），且 SysV x64 走 `RDI` + `AL=0`/1 分类。要在 asm 里通用实现就得
  处理三种不同的寄存器/栈位置 + hidden pointer 的所有权（谁分配、谁释放）。
- **结论：暂不支持。** 触发这个需求时再单独立项，不在本次范围内。
- 现有 `test/test_ffi_struct.ts` 走的是纯 TS 布局 + `readByte/writeByte`，
  **不经过 `ffiCall`**，所以不受影响。

**Win32 C API 现状核对（2026-10 复核）：按值 struct 参数存在但极少，且全是 ≤8B 小 struct。**

- 传参按值的真例子：`WindowFromPoint(POINT)` / `ChildWindowFromPoint(Ex)`（8B）、
  console 系列 `SetConsoleCursorPosition` / `SetConsoleScreenBufferSize` /
  `FillConsoleOutputCharacter(A/W)` / `FillConsoleOutputAttribute`（`COORD`，4B）。
- 返回按值的真例子：`COORD GetLargestConsoleWindowSize(HANDLE)` —— Win32 下 ≤8B struct
  走 `EAX(:EDX)`，恰落在现有 `EAX:EDX → out` 通路上，不需要 hidden pointer。
- 绝大多数 API 传 `RECT*`/`MSG*` 等**指针** → 走现有 `ptr` + `ffi/struct.ts` 已覆盖；
  项目与测试中按值 struct 用量为零（`rg WindowFromPoint|COORD|POINT` 在 test/、lib/ 无匹配）。

**关键结论：≤8B struct by-value 在 ABI 上与「按位打包的 u32/u64」等价，现有 FFI 可
bit-cast 零改动绑定。** cdecl 就是把 struct 字节压栈；`writeSlot` 的
`setUint32/setBigUint64(…, true)` 写的正是同一段 LE 内存镜像（`lib/ffi/bind.ts`）。
x64 ≤8B 同理（单槽整块 INTEGER 或 SSE，桩本来就双读 GPR+XMM）。
分档注意：
- 9–16B（MSVC 拆两个寄存器块）在 x64 上**需实测**确认 mingw caller 与 MSVC callee 分类一致；
- >16B（MSVC 走 hidden pointer）才是真要动桩的场景 —— 但那类 Win32 C API 不存在
  （多在 C++/COM，超范围）。

因此：**Win32 C API 场景下 struct by-value 不构成缺口**，遇到 `WindowFromPoint` 这类
直接 bit-cast 打包即可；触发 >16B 或返回 struct 真需求时，仍按本节结论单独立项。

### 10.5 与本计划的关系

- **不阻塞 S1–S7。** 当前 C 侧打包实现是正确的、已全绿的，不重构也能交付。
- 落地时机：S6 完成（libffi 移出构建流程）之后，作为独立 commit 组。
- 重构期间仍可参考 `deps/libffi` 源码（§3.7 保留），对照它验证 JS 侧布局与 libffi 一致。
- 迁移期曾保留 C 侧打包路径作为对照；JS 侧 argFrame 在 x64/ia32 全绿后，**该路径已删除**（见 §10.6）。

### 10.6 实施结果（最终）

**落地内容**：

- **C 侧 `js_ffi_call`**（`quickjs-ffi.c`）：收 `(func, argFrame, retBuf, retIsFp)`，不再传
  字节数——`JS_GetArrayBuffer` 返回的真实大小即所需大小（JS 总是 `new ArrayBuffer(total)`
  后原样传入）。不做任何类型表/槽宽逻辑，只负责按架构把 argFrame 喂给 asm 桩 + 取原始返回：
  - ia32：argFrame = 连续 cdecl 参数区，`nstack_bytes = af_size`
  - x64：argFrame = 8 字节宽槽数组，`nargs = af_size / 8`
  - `retIsFp` 恒传递（ia32 需要避免整数返回时碰空 x87；x64 无此问题但接口一致）
  - 显式校验 `af_size <= 64*8`、`retBuf >= 8`（§10.3 #2）
  - 上限与 `retBuf >= 8` 错误信息统一为 `ffiCall:` 前缀
- **JS 侧 `lib/ffi/bind.ts`**：`makeFn` 改走 `callPacked()`——
  - `ARG_SIZE[]` 宽度表（与 `quickjs-ffi-type.h` 的 `qwin_ffi_arg_size[]` 逐项一致）
  - `DataView` 打包 `argFrame`；x64 补齐到 ≥4 槽（`X64_MIN_SLOTS`，对应桩无条件双读）
  - `retBuf` 恒 8 字节；`readRet()` 按返回类型从 retBuf 解码（含窄整型符号扩展、ptr NULL→null）
  - <WCHAR>ptr 编码逻辑原样保留（utf-16le + '\0'，`held[]` 保活）
- **删除旧 API、统一命名**：
  - 旧 `js_ffi_call`（C 侧数组打包 + 返回解码，原 `ffiCall`）整体删除；新导出改名
    `ffiCallRaw` → `ffiCall`，**`ffiCall` 现在只有 4 参预打包签名**。
  - C 侧 `ffi_consts[]`（`FFI_TYPE_*` 数值导出）删除——JS 侧不再依赖这些数值，
    `quickwin.d.ts` 的 `FfiType`/`TypeArg`/`TypeArgs`/`FFI_TYPE_*` 声明同步移除。
  - `quickjs-ffi-type.h` 不再被 include，仅保留为 ABI 文档参照（JS `ARG_SIZE[]` 的对照源）。
  - `lib/ffi/bind.ts` 的 `KIND_TO_FFI` 表换成 `KIND_SET`（仅做 kind 合法性校验）。
- **调用方全部迁移到 `bind()`/`bindLib()`**：
  - `test/test_ffi.ts`（`EnumPrintersW`、`GetDC`）
  - `examples/setres.ts`、`examples/pdf_preview2.ts`、`examples/PdfCanvas.tsx`、`examples/pdf_viewer.tsx`
  - `lib/react-qw/components/ListView.tsx`、`lib/react-qw/components/PathPicker.tsx`

**验证**：

- Win11 x64：`ffi` 过滤组 **88/88**、全量 **557/557**
- XP ia32：全量 **557/557**
- `make js` / `npx tsc` 通过；`make cc64` / `make cc32` 通过（仅原有 `-Wunused-parameter` 警告）
- 差分探针（两架构）：0 参/1 参/2 参 <WCHAR>ptr/5 参 SetRect/f64 sqrt/atan2/f32+i32 混合/
  6 参 AngleArc/ptr 返回/u32 全过