/*
 * 内建 FFI 闭包派发器 —— X64 (Win64 ABI)
 *
 * 每 closure 一个 128 字节 VirtualAlloc 可执行块（C 侧创建时写入）：
 *   [0..31]   trampoline：49 BA <block:u64>  49 BB <dispatch:u64>  41 FF E3
 *             即 movq $<块地址>,%r10; movq $<dispatch>,%r11; jmp *%r11（绝对跳转）
 *   [32] magic  [36] ret_kind  [40] arg_bytes  [48] wrapper(JSValue 16B)
 *                                              [64] ctx(8B)
 * r10 是易失寄存器（Win64 参数只用 rcx/rdx/r8/r9），安全承载块地址。
 *
 * 入口（Win32 API 经 call 进入 trampoline，trampoline 再 jmp 到此）：
 *   [rsp]         调用方返回地址
 *   [rsp+0x08..0x27] 32 字节影子空间（调用方按 ABI 预留，可作 scratch）
 *   [rsp+0x28..]     第 5 个及以后的实参（溢出区）
 *   rcx/rdx/r8/r9   第 1..4 个整数实参
 *   xmm0-3          第 1..4 个浮点实参
 *   r10             闭包块地址（trampoline 注入）
 *
 * 本帧 FS=88：
 *   [rsp+0x00..0x07] 对齐垫
 *   [rsp+0x08..0x27] 32 字节 outgoing 影子（给 C 转发的 call 预留，勿碰）
 *   [rsp+0x28..0x37] 结果槽（16 字节，用前 8）
 *   [rsp+0x38..0x57] xmm0-3（32 字节）
 *
 * 调 C: qwin_closure_inner_win64(block, int_args, stack_args, frame)
 *   rcx=block(r10)  rdx=int_args(原 rsp+0x08=新 rsp+0x60)  r8=stack_args(原 rsp+0x28=新 rsp+0x80)
 *   r9=frame=新 rsp+0x28（frame[0..15]=结果槽, frame[16..47]=xmm）
 *
 * 返回：从结果槽统一双读 RAX+XMM0（同 libffi win64.S 的 movq+movsd），
 * 整数/浮点返回都不挑。C 侧已把 JS 写好的 8 字节放回结果槽。
 */

#ifdef __USER_LABEL_PREFIX__
# define QW2(X, Y) X ## Y
# define QW1(X, Y) QW2(X, Y)
# define QW(X)  QW1(__USER_LABEL_PREFIX__, X)
#else
# define QW(X)  X
#endif

	.text
	.balign	16
	.globl	QW(qwin_closure_dispatch_win64)

QW(qwin_closure_dispatch_win64):
	.cfi_startproc
	/* 整数实参 1..4 → 调用方影子空间 */
	movq	%rcx, 8(%rsp)
	movq	%rdx, 16(%rsp)
	movq	%r8, 24(%rsp)
	movq	%r9, 32(%rsp)

	subq	$88, %rsp		/* FS：对齐 + outgoing 影子 + 结果槽 + xmm */
	movsd	%xmm0, 56(%rsp)
	movsd	%xmm1, 64(%rsp)
	movsd	%xmm2, 72(%rsp)
	movsd	%xmm3, 80(%rsp)

	movq	%r10, %rcx		/* block（闭包块地址） */
	leaq	96(%rsp), %rdx		/* int_args：原 rsp+8 = 新 rsp+88+8 */
	leaq	128(%rsp), %r8		/* stack_args：原 rsp+40 = 新 rsp+128 */
	leaq	40(%rsp), %r9		/* frame：新 rsp+40 */
	xorl	%eax, %eax		/* AL=0 确定性 */
	call	QW(qwin_closure_inner_win64)

	/* 结果槽统一双读 */
	movq	40(%rsp), %rax
	movsd	40(%rsp), %xmm0

	addq	$88, %rsp
	ret
	.cfi_endproc
