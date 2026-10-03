#ifndef QUICKJS_FFI_CLOSURE_H
#define QUICKJS_FFI_CLOSURE_H

#include <stdint.h>
#include "quickjs.h"

/* 内建 FFI 闭包（回调）：把 JS 函数变成可传给 Win32/C API 的函数指针。
 *
 * 分层约定与调用桩一致（.agents/REMOVE_LIBFFI_PLAN.md §10）：
 *   - JS 侧（lib/ffi/bind.ts closure()）解析回调签名、注册用户函数、注册派发函数
 *   - C 侧（quickjs-ffi-closure.c）每闭包一个 VirtualAlloc 可执行块（自包含），
 *     闭包触发时把捕获的实参打包成 JS ArrayBuffer、桥接回 JS 执行用户回调、拷回返回
 *   - asm 侧只做「按 ABI 捕获入参 + 调 C 转发 + 按 ABI 装填返回」
 *
 * 机制（同 libffi closures，见 deps/libffi/src/x86/win64.S / sysv.S）：
 *   每 closure 一个 128 字节 VirtualAlloc 块（启动时 RW 写 trampoline + 元数据，
 *   随后锁 PAGE_EXECUTE_READ）：
 *     [0..31] trampoline   win64: movq $<块>,%r10; movq $<dispatch>,%r11; jmp *%r11
 *                          ia32:  movl $<块>,%eax; movl $<dispatch>,%edx; jmp *%edx
 *     [32] magic  [36] ret_kind  [40] arg_bytes  [48] wrapper(JSValue 16B)
 *                                                    [64] ctx(8B)
 *   Win32 API 用 call 进入 trampoline，trampoline 转发到共享派发器；
 *   派发器只凭块地址（寄存器）工作，无全局表、无 idx。
 *   ctx/wrapper 在创建时捕获进块：回调永远回到创建它的 context，Worker 导入
 *   'ffi' 不会污染其它 context（无跨 context 全局、无 registry）。
 *
 * 同步同线程回调限定：QuickJS 单线程，仅支持「API 在 JS 调用线程内同步回调」
 * 的场景（EnumWindows / EnumFonts / qsort / SetTimer 同步用法等）；跨线程回调
 * （SetWinEventHook 等 hook 线程）不支持，需要队列 + 等待（死锁风险）。
 *
 * dispose 契约：closureFree 后该块地址（函数指针）不得再被任何 native 方引用。
 */

/* trampoline 派发器入口（汇编导出，C 侧写 trampoline 时取地址） */
void qwin_closure_dispatch_win64(void);
void qwin_closure_dispatch_ia32(void);

/* C 转发（汇编调 C）：按架构捕获的 frame 布局见对应 .S 头注释。
 *   win64: qwin_closure_inner_win64(block, int_args, stack_args, frame)
 *          frame[0..7]=结果槽，frame[16..47]=xmm0-3
 *   ia32:  qwin_closure_inner_ia32(block, stack_args, result)
 *          返回 ret_kind：0=int/ptr/void  1=f32  2=f64；结果写 result[0..7]
 *   block = 闭包块地址（trampoline 注入寄存器，跨 C 调用保存）。 */
void qwin_closure_inner_win64(uint64_t block, const uint8_t *int_args,
                              const uint8_t *stack_args, uint8_t *frame);
uint32_t qwin_closure_inner_ia32(uint32_t block, const uint8_t *stack_args,
                                 uint8_t *result);

/* quickjs-ffi-closure.c 的模块导出（并入 "ffi" 模块） */
#define QWIN_CLOSURE_FUNCS_COUNT 2
extern const JSCFunctionListEntry qwin_closure_funcs[QWIN_CLOSURE_FUNCS_COUNT];

#endif
