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
 * 本派发器是共享的，N 从闭包块 [ebx+40]（arg_bytes）动态取，故不能用
 * `ret $N` 立即数，改用「返回地址搬运」：先把目标 esp 算进 ecx，把返回地址
 * 预写到 [E+arg_bytes]，最后 movl %ecx,%esp 后 ret（等价 ret $N）。
 *
 * 返回值分派（ret_kind）：0=int/ptr/void → EAX；1=f32、2=f64 → ST0；
 * 3=int64 → EDX:EAX（i386 64 位整数返回约定，同 libffi X86_RET_INT64）。
 * EDX 先搬返回地址、读完结果后复用装高 32 位，两次使用错开；整个过程
 * esp 不切走，结果槽才能始终可寻址（借鉴 libffi x86/sysv.S 的三段式）。
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

	/* 第 1 步：目标 esp + 搬返回地址（此时 esp 仍在结果槽、ebp 有效）。
	   ecx = ret 前的 esp（E+arg_bytes）；返回地址预写到该处，等价于 ret $N：
	   cdecl 时 arg_bytes=0 → 写回原位（no-op）；stdcall 时写进参数区末字，
	   与旧的 popl/addl/pushl 技巧落点完全相同。
	   必须先于读结果完成 —— 之后 EDX 才腾得出来装 int64 高半。 */
	movl	40(%ebx), %ecx		/* arg_bytes（自包含：闭包块内，stdcall 清栈/cdecl=0） */
	leal	4(%ebp,%ecx), %ecx	/* ret 前 esp = E+arg_bytes */
	movl	4(%ebp), %edx		/* 返回地址 → EDX（暂用） */
	movl	%edx, (%ecx)		/* [E+arg_bytes] = 返回地址 */

	/* 第 2 步：装返回值。esp 仍在结果槽，结果字节 [esp..esp+7] 始终可寻址。
	   ret_kind：0=int/ptr/void  1=f32  2=f64  3=int64(EDX:EAX) */
	testl	%eax, %eax
	jnz	.Lnotint
	movl	(%esp), %eax		/* kind=0: int32/ptr/void → EAX */
	jmp	.Ldone
.Lnotint:
	cmpl	$3, %eax
	je	.Lint64
	cmpl	$2, %eax
	je	.Lf64
	flds	(%esp)			/* kind=1: f32 → ST0 */
	jmp	.Ldone
.Lint64:
	movl	(%esp), %eax		/* 低 32 → EAX */
	movl	4(%esp), %edx		/* 高 32 → EDX（i386 64 位返回 EDX:EAX；
				   返回地址已入栈，EDX 此处复用是安全的） */
	jmp	.Ldone
.Lf64:
	fldl	(%esp)			/* kind=2: f64 → ST0 */

	/* 第 3 步：恢复 callee-saved，最后才把 esp 切到目标。 */
.Ldone:
	addl	$8, %esp		/* 弹结果槽 */
	popl	%ebx			/* 恢复 */
	popl	%ebp			/* 恢复；此时 esp=E，[esp]=原返回地址（不再使用） */
	movl	%ecx, %esp		/* 切到 E+arg_bytes */
	ret				/* eip=[E+arg_bytes]=返回地址，返回后 esp=E+4+arg_bytes ✓ */

	.cfi_endproc
