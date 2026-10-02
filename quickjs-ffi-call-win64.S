/*
 * 内建 FFI 调用器 —— X64 (Win64 ABI)
 *
 * 取代 libffi 的 ffi_call_win64（见 .agents/REMOVE_LIBFFI_PLAN.md）：
 * 类型分类、返回值解码、错误检查全在 C 侧；本文件只做「按 ABI 搬运参数 +
 * call + 取回原始返回值」。
 *
 * 布局依据 deps/libffi/src/x86/ffiw64.c ffi_call_int（写入侧）：
 *   - 每个参数固定占一个 8 字节槽（C 侧已填好，本文件无宽度表）
 *   - 前 4 槽同时装进 GPR（RCX/RDX/R8/R9）与 XMM（XMM0-3）双读。
 *     Win64 ABI 允许调用方把同一参数放进两个视图，被调方按自己签名只读
 *     该读的那个，故跨槽的垃圾值无害。与 libffi win64.S 的
 *     movq+movsd 双读完全一致。
 *   - 第 5 个及以后的参数进「溢出参数区」（在其下方预留 32 字节影子空间）。
 *
 * 内部调用约定（被 C 调用时的入参，Win64）：
 *   func=RCX  slots=RDX  nargs=R8d  out=R9  ret_fp=[rbp+0x30]
 *   影子空间由 C 侧调用方按 ABI 预留，stub 不自己 sub $32；
 *   只给溢出参数额外让出 16·n 并保持 16 字节对齐。
 *
 * 关键约束：
 *   - call 之后不得再依赖 RCX/RDX/R8/R9 —— 它们已被槽内容覆盖。
 *     func 必须提前存进 r12（callee-saved），call 用 *%r12。
 *   - slots 前 4 槽无条件双读（对齐 libffi），故 C 侧必须保证 slots 数组
 *     长度 >= 4（length < 4 时补齐到 4，清零尾部）。
 *   - AL 恒置 0：不声明为变参，但保持确定性。
 *   - rdi/rsi/由 rep movsq 破坏，且 rdi/rsi/r12-r15 在 Win64 均为
 *     callee-saved，必须先 push 存底。
 */

/* MinGW（COFF）下 gcc 给 C 标识符加下划线前缀（ia32 有、x64 为空），
   用 libffi 同款 __USER_LABEL_PREFIX__ 写法（sysv.S:37-42）。 */
#ifdef __USER_LABEL_PREFIX__
# define QW2(X, Y) X ## Y
# define QW1(X, Y) QW2(X, Y)
# define QW(X)  QW1(__USER_LABEL_PREFIX__, X)
#else
# define QW(X)  X
#endif

	.text
	.balign 16
	.globl	QW(qwin_ffi_call_win64)

/* void qwin_ffi_call_win64(void *func, const uint64_t *slots,
 *                          uint32_t nargs, void *out, int ret_fp);
 *
 * 入口时（Win64，未自己动栈）:
 *   [rsp]     返回地址
 *   [rsp+0x08..0x27] 32 字节影子空间（由 C 调用方预留）
 *   第 5 参 ret_fp 在 [rsp+0x28]（= [rbp+0x28+8] = [rbp+0x30]）
 */
QW(qwin_ffi_call_win64):
	.cfi_startproc
	pushq	%rbp
	.cfi_def_cfa_offset 16
	.cfi_offset %rbp, -16
	movq	%rsp, %rbp		/* rbp = 旧 rsp - 8 */

	/* rdi/rsi/r12-r15 是 Win64 callee-saved 且后面会被改动，先保存 */
	pushq	%rdi
	pushq	%rsi
	pushq	%r12
	pushq	%r13
	pushq	%r14
	pushq	%r15

	movq	%rcx, %r12		/* func   → r12 */
	movq	%rdx, %r13		/* slots  → r13 */
	movl	%r8d, %r14d		/* nargs  → r14 */
	movq	%r9, %r15		/* out    → r15 */

	/* 溢出参数个数 = max(nargs - 4, 0)，存 r10 */
	leal	-4(%r14d), %r10d
	testl	%r10d, %r10d
	jns	1f
	xorl	%r10d, %r10d
1:

	/* 分配溢出参数区（32 影子 + 8·n 溢出）+ 对齐余量，再向下凑 16 */
	movl	%r10d, %eax
	cltq
	leaq	32(,%rax,8), %rax	/* 32 + 8·n */
	addq	$15, %rax
	andq	$-16, %rax
	subq	%rax, %rsp
	andq	$-16, %rsp

	/* 溢出参数：slots[4..] → [rsp+0x20+…]，即影子区之后 */
	testl	%r10d, %r10d
	jle	2f
	leaq	32(%rsp), %rdi		/* 影子之后 = 溢出区 */
	leaq	0x20(%r13), %rsi	/* slots + 4*8 */
	movl	%r10d, %ecx
	rep movsq
2:

	/* 前 4 槽双读：movq (GPR) + movsd (XMM)。与 libffi win64.S identical */
	movq	0x00(%r13), %rcx
	movsd	0x00(%r13), %xmm0
	movq	0x08(%r13), %rdx
	movsd	0x08(%r13), %xmm1
	movq	0x10(%r13), %r8
	movsd	0x10(%r13), %xmm2
	movq	0x18(%r13), %r9
	movsd	0x18(%r13), %xmm3

	xorl	%eax, %eax		/* AL=0 确定性 */
	call	*%r12			/* ★ 用 r12；RCX/RDX/... 已被槽覆盖 */

	/* 返回：单一 8 字节返回槽 out(r15)，ret_fp 决定取 RAX 还是 XMM0。
	   ret_fp 在 [rbp+0x30]，rbp 未被目标函数改动，可在 call 后重读。 */
	cmpl	$0, 0x30(%rbp)		/* ret_fp */
	je	.Lret_int
	movq	%xmm0, (%r15)		/* out ← XMM0（f32/f64） */
	jmp	.Lret_done
.Lret_int:
	movq	%rax, (%r15)		/* out ← RAX（整数/指针/void） */
.Lret_done:

	/* 从帧基准无条件重建 —— 不依赖目标函数是否清栈（Win64 恒由调用方清）。
	   必须逆序恢复入口 push 的 6 个 callee-saved：Win64 下 rdi/rsi 是非易失
	   （与 SysV 不同），漏恢复会破坏 C 调用方，-Os/-flto 下极易触发 AV。 */
	leaq	-48(%rbp), %rsp		/* 跳到最后一个 push（r15 槽） */
	popq	%r15
	popq	%r14
	popq	%r13
	popq	%r12
	popq	%rsi
	popq	%rdi
	popq	%rbp
	.cfi_def_cfa %rsp, 8
	ret
	.cfi_endproc