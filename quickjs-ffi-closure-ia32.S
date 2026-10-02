/*
 * 内建 FFI 闭包派发器 —— IA32 (Win32)
 *
 * 每 closure 一个 128 字节 VirtualAlloc 可执行块（C 侧创建时写入）：
 *   [0..31]   trampoline：B8 <block:u32>  BA <dispatch:u32>  FF E2
 *             即 movl $<块地址>,%eax; movl $<dispatch>,%edx; jmp *%edx（绝对跳转）
 *   [32] magic  [36] ret_kind  [40] arg_bytes  [48] wrapper(JSValue 16B)
 *                                              [64] ctx(8B)
 *
 * 入口（Win32 API 经 call 进入 trampoline，trampoline 再 jmp 到此）：
 *   [esp]      调用方返回地址
 *   [esp+0x04] 第 1 个实参（其后依次排列；cdecl/stdcall 参数全在栈上）
 *   eax        闭包块地址
 *
 * 返回约定：cdecl 调用方清栈；stdcall 由被调方 ret $N 清栈。
 * 本派发器是共享的，N 从闭包块 [ebx+40]（arg_bytes）动态取，
 * 用「返回地址搬运」技巧统一两条路径：先把返回地址弹进 edx，addl 跳过参数区，
 * 再 push 回返回地址后 ret（等价于 ret $N，见栈算术注释）。
 *
 * ia32 闭包返回限制：只支持 int32/ptr/void/f32/f64（Win32 回调无 64 位整数返回）。
 * 因此 eax（int）或 ST0（float）之外的 edx/ecx 均可作返回路径 scratch。
 */

#ifdef __USER_LABEL_PREFIX__
# define C2(X, Y) X ## Y
# define C1(X, Y) C2(X, Y)
# define C(X)  C1(__USER_LABEL_PREFIX__, X)
#else
# define C(X)  X
#endif

	.text
	.balign	16
	.globl	C(qwin_closure_dispatch_ia32)

C(qwin_closure_dispatch_ia32):
	.cfi_startproc
	pushl	%ebp
	.cfi_def_cfa_offset 8
	.cfi_offset %ebp, -8
	movl	%esp, %ebp
	.cfi_def_cfa_register %ebp

	pushl	%ebx
	movl	%eax, %ebx		/* block（闭包块地址）→ ebx（callee-saved，跨 C 调用存活） */

	subl	$8, %esp		/* 结果槽 [esp..esp+7] */

	/* C: qwin_closure_inner_ia32(block, stack_args, result) → eax=ret_kind */
	movl	%esp, %ecx		/* result ptr（arg3） */
	pushl	%ecx
	leal	8(%ebp), %ecx		/* stack_args = 首个实参地址（arg2） */
	pushl	%ecx
	pushl	%ebx			/* block（arg1） */
	call	C(qwin_closure_inner_ia32)
	addl	$12, %esp		/* cdecl：调用方清 3 个实参 */

	/* eax = ret_kind（0=int/ptr/void, 1=f32, 2=f64）；结果字节在 [esp..esp+7] */
	testl	%eax, %eax
	jnz	.Lfloat
	movl	(%esp), %eax		/* int32/ptr/void → EAX */
	jmp	.Lepi
.Lfloat:
	cmpl	$2, %eax
	je	.Lf64
	flds	(%esp)			/* f32 → ST0 */
	jmp	.Lepi
.Lf64:
	fldl	(%esp)			/* f64 → ST0 */
.Lepi:
	movl	40(%ebx), %ecx		/* arg_bytes（自包含：闭包块内，stdcall 清栈/cdecl=0） */

	addl	$8, %esp		/* 弹结果槽 */
	popl	%ebx			/* 恢复 */
	popl	%ebp			/* 此时 esp=E，[esp]=返回地址 */

	/* 返回地址搬运（等价 ret $N）：
	   弹返回地址进 edx → addl 跳过 API 参数区 → push 回返回地址 → ret。
	   最终调用方 esp = E+4+arg_bytes（stdcall 语义），cdecl 时 arg_bytes=0。 */
	popl	%edx			/* edx = 返回地址；esp = E+4 */
	addl	%ecx, %esp		/* 跳过参数区 → E+4+arg_bytes */
	pushl	%edx			/* → E+arg_bytes，[esp]=返回地址 */
	ret				/* → E+4+arg_bytes ✓ */

	.cfi_endproc
