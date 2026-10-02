#ifndef QUICKJS_FFI_CALL_H
#define QUICKJS_FFI_CALL_H

#include <stdint.h>

/* 内建 FFI 调用桩：取代历史上第三方 FFI 后端的 prep_cif + call。
 *
 * 分层约定（.agents/REMOVE_LIBFFI_PLAN.md §3.2 / §10）：
 *   - 类型分类、宽度计算、参数打包、返回值读回、错误检查 全在 JS 侧（lib/ffi-bind.ts）
 *   - C 侧（quickjs-ffi.c）只把 JS 预打包的 argFrame 转交桩、取回原始返回
 *   - asm 侧只做「按 ABI 搬运参数 + call + 取回原始返回值」
 * 因此 asm 不需要知道任何类型信息，两个架构的 .S 共用同一套内部调用约定。
 *
 * 参数（IA32 版本）：
 *   func         目标函数地址
 *   argbuf       JS 侧按 cdecl 布局打包好的连续参数区，低地址 = 第一个参数。
 *                打包规则：每个参数占 ARG_SIZE 字节（4 或 8），
 *                无对齐填充，顺序即源码参数顺序。
 *                打包后 asm 只需一次 rep movsb，故不需要知道任何类型信息。
 *   nstack_bytes argbuf 的总长度 = Σ qwin_ffi_arg_size[type]
 *   out          单个 8 字节返回槽，写回 JS 的 retBuf；由 ret_fp 决定写哪一类：
 *                  ret_fp != 0 → fstpl，浮点恒以 double 落地（float 返回亦无损：
 *                                ST0 里的扩展精度值源自 32 位 float，转 double
 *                                精确，JS 侧再 getFloat32 收窄可精确还原）；
 *                  ret_fp == 0 → EAX:EDX 直接落 8 字节（ia32 的 64 位返回走
 *                                EDX:EAX）。32 位返回时高 4 字节是垃圾，
 *                                JS 侧 readRet 按声明类型取低 N 字节后不会用到。
 *   ret_fp       非 0 = 返回值是 f32/f64，汇编弹出 ST0 写 out；
 *                0 = 整数/指针/void，汇编完全不碰 x87。
 *
 *   ret_fp 不能省：Win32 ABI 要求 x87 栈在函数边界为空，对空栈执行 fstpl 属
 *   栈下溢非法操作，默认被掩蔽不崩，但会置 FE_INVALID 并污染此后的
 *   fetestexcept()/math_errhandling。
 *
 * 关键约束：调用点之后不得有任何依赖 ESP 相对偏移的栈访问，
 * 一切出参走 EBP/EBX 相对寻址。原因见 REMOVE_LIBFFI_PLAN.md §2.2.1：
 * 被调方可能是 stdcall（ret $N 多弹参数），必须靠「从帧基准重建 ESP」
 * 来无条件抹平差异。
 */
void qwin_ffi_call_ia32(void *func, const void *argbuf, uint32_t nstack_bytes,
                        void *out, int ret_fp);

/* x64 版本（Win64 ABI）：
 *   slots 固定 8 字节宽，无需宽度表；前 4 槽进 GPR+XMM 双读，其余进栈参数区。
 *   影子空间由 C 调用方按 ABI 预留，stub 不自己减 32；只给溢出参数让出栈区。
 *   nargs 仅用于决定溢出参数个数，不限制 4：arm 无条件双读 slots[0..3]，
 *   因此 C 侧必须保证 slots 数组至少 4 个元素（length<4 时补齐并清零）。
 *   out          单个 8 字节返回槽：ret_fp != 0 → XMM0，否则 RAX。
 *                （x64 无 x87 下溢问题，但 ret_fp 仍需以决定写哪个寄存器。）
 * 实现见 REMOVE_LIBFFI_PLAN.md §3.3.1。 */
void qwin_ffi_call_win64(void *func, const uint64_t *slots, uint32_t nargs,
                         void *out, int ret_fp);

#endif
