/*
 * 内建 FFI 调用器 —— IA32 (Win32 cdecl)
 *
 * 取代 libffi 的 ffi_prep_cif + ffi_call（见 .agents/REMOVE_LIBFFI_PLAN.md）。
 *
 * 分层：类型分类、宽度计算、返回值解码全在 C 侧；本文件只做「按 ABI 搬运参数 +
 * call + 取回原始返回值」。因此本文件不需要知道任何类型信息。
 *
 * 参数区布局（依据 deps/libffi/src/x86/ffi.c:341-402 的写入侧分支）：
 *   size <= FFI_SIZEOF_ARG(4) 的类型推进 4 字节，更大的按 ALIGN(size,4) 推进；
 *   放置时用的 align 恒为 FFI_SIZEOF_ARG，与 ffi_type.alignment 无关。
 *   故真实布局 = 每参数 4 或 8 字节的简单前缀和，零填充。
 *   cif->bytes 虽然按 t->alignment 对齐过，但那只用于 alloca 估算。
 *
 * 帧基准恢复（REMOVE_LIBFFI_PLAN.md §2.2.1）：
 *   Win32 的退栈责任分两种 —— cdecl 由调用方事后清，stdcall 由被调方 ret $N 清。
 *   若事后无条件做 add $N,%esp，遇 stdcall 会多弹 N 字节。这里改为在 call 之后
 *   用 mov %ebx,%esp 从自己的帧基准无条件重建 ESP，两种约定共用同一出口。
 *   这与 libffi 的 sysv.S:112 / :174 同源。
 *
 * 由此产生的硬约束：call 之后不得有任何依赖 ESP 相对偏移的栈访问。
 */

	/* MinGW（COFF）下 gcc 给 C 标识符加下划线前缀，汇编符号必须跟着加，否则
 * C 侧引用的是 _qwin_ffi_call_ia32，链接报 undefined reference。
 * 直接沿用 libffi 的 sysv.S:37-42 写法：__USER_LABEL_PREFIX__ 在 mingw 下为 "_"，
 * 而将来 x64 mingw 为空，故不能把前缀硬编码进标签。 */
#ifdef __USER_LABEL_PREFIX__
# define C2(X, Y) X ## Y
# define C1(X, Y) C2(X, Y)
# define C(X)  C1(__USER_LABEL_PREFIX__, X)
#else
# define C(X)  X
#endif

	.text
	.balign 16
	.globl	C(qwin_ffi_call_ia32)
/* 不用 .type/.size：@function 语法是 ELF 专有，mingw 的 COFF 后端不认，
   而 PE 导出表由链接器自行生成，这里也不需要它们。 */

/* void qwin_ffi_call_ia32(void *func, const void *argbuf,
 *                         uint32_t nstack_bytes, void *out, int ret_fp);
 *
 * cdecl 入参在栈上。标准 i386 帧（push %ebp; mov %esp,%ebp）里
 * 0(%ebp)=保存的 ebp、4(%ebp)=返回地址，故第一个参数在 8(%ebp)：
 *   func=8(%ebp) argbuf=12(%ebp) nstack_bytes=16(%ebp)
 *   out=20(%ebp) ret_fp=24(%ebp)
 * argbuf 由 C 侧打包成 cdecl 顺序（低地址 = 第一个参数）。
 */
C(qwin_ffi_call_ia32):
	.cfi_startproc
	pushl	%ebp
	.cfi_def_cfa_offset 8
	.cfi_offset %ebp, -8
	movl	%esp, %ebp
	.cfi_def_cfa_register %ebp

	/* rep movsb 会破坏 esi/edi/ecx，三者都是 callee-saved/需还原 */
	pushl	%ebx
	pushl	%esi
	pushl	%edi

	/* ebx = 帧基准。必须在三次 push 之后取：若取在 push 之前，基准会指向
	 * callee-saved 区块，把这 12 字节一起当成参数区扔掉，参数静默错位。 */
	movl	%esp, %ebx

	subl	16(%ebp), %esp		/* 分配 nstack_bytes 字节参数区 */
	andl	$-16, %esp		/* 调用点 16 字节对齐。
					   向下取整不会溢出：ESP <= ebx-nstack_bytes，
					   故 [ESP, ESP+nstack_bytes) 完全落在 ebx 下方，
					   不会碰到上面压入的 edi/esi/ebx/ebp/retaddr。 */

	/* argbuf -> 参数区，一次整体搬运。asm 无需知道任何类型或槽偏移。
	   cld 显式清方向标志：若 DF 被上一段代码留成 1，rep movsb 会反向拷贝，
	   直接踩坏下方调用者栈帧，且不报错。ABI 规定 DF 进/出函数均为 0，
	   所以这里清它不会破坏任何调用者的预期。 */
	cld
	movl	12(%ebp), %esi		/* src */
	movl	%esp, %edi		/* dst */
	movl	16(%ebp), %ecx		/* n */
	rep movsb

	call	*8(%ebp)

	/* ---- 以下为「返回后」路径：一律走 %ebp/%ebx 相对寻址 ----
	   注意不能用 %eax 承载间接寻址结果：它刚被用作 call 的寻址寄存器。
	   单一 8 字节返回槽 out（20(%ebp)），ret_fp 决定写浮点还是整数。 */

	/* 只有真的是浮点返回时才碰 x87。Win32 ABI 要求 x87 栈在函数边界为空，
	 * 对空栈做 fstpl 属栈下溢非法操作：默认控制字会掩蔽它，不崩，
	 * 但会置 FE_INVALID，污染此后同一线程的 fetestexcept()/math_errhandling。
	 * 所以这里必须由 C 侧告知返回类别，不能无条件弹出。 */
	cmpl	$0, 24(%ebp)		/* ret_fp */
	je	.Lint_ret
	movl	20(%ebp), %ecx		/* out */
	fstpl	(%ecx)			/* 浮点返回恒按 double 落地。
					   float 返回时 ST0 里的扩展精度值
					   来自 32 位 float，转 double 无损，
					   JS readRet 再 getFloat32 收窄可精确还原。 */
	jmp	.Lret_done
.Lint_ret:
	movl	20(%ebp), %ecx		/* out */
	movl	%eax, (%ecx)
	movl	%edx, 4(%ecx)		/* 64 位整数返回走 EDX:EAX。
					   32 位返回时 edx 是垃圾，但 JS readRet
					   按声明类型取低 N 字节后不会用到。 */
.Lret_done:

	movl	%ebx, %esp		/* ★ 从帧基准无条件重建，抹平
					   cdecl / stdcall 的退栈差异。
					   ebx 是在三次 push「之后」取的，故这里 esp
					   已恰好指向保存的 edi，直接顺序 pop 即可，
					   不能再做额外的 esp 调整（多加 4 字节会让
					   ret 跳到第一个入参而不是返回地址）。 */
	popl	%edi
	popl	%esi
	popl	%ebx
	popl	%ebp
	.cfi_def_cfa %esp, 4
	ret
	.cfi_endproc

/* 附注：本函数的栈帧含「动态 sub + and 对齐」（16(%ebp) 处的长度未知），
   SEH 的 stackalloc 只能表达常量，故 gas 无法自动生成正确的 unwind 描述。
   这在实践中无影响：唯一被调用方是 Win32 API，不会向本帧抛异常，
   且本调用链上无 C++ 异常。上面的 .cfi_* 对 DWARF 消费者仍然正确。
   若日后要支持「目标函数长跳转 / 回调回到本帧」，必须先把帧改成常量大小。 */