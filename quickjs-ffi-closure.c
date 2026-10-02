/*
 * 内建 FFI 闭包（回调）：JS 函数 → Win32/C 函数指针。
 *
 * 分层（见 quickjs-ffi-closure.h）：
 *   - 每闭包一个 VirtualAlloc 的可执行块（自包含）：trampoline + 元数据 + wrapper + ctx
 *   - 汇编派发器在 quickjs-ffi-closure-{win64,ia32}.S
 *   - JS 侧（lib/ffi-bind.ts closure()）为每个闭包包一个 wrapper：闭包捕获
 *     args/ret/fn，负责解码 frame + 调用户回调 + 编码返回；C 侧只存 wrapper。
 *
 * 块布局（128 字节）：
 *   [0..31]    trampoline（内嵌块地址）
 *   [32..35]   magic（in_use 校验）
 *   [36..39]   ret_kind（ia32 结果加载分派：0=int/ptr/void 1=f32 2=f64）
 *   [40..43]   arg_bytes（ia32 stdcall 清栈字节数；cdecl/x64 = 0）
 *   [44..47]   对齐垫
 *   [48..63]   JSValue wrapper（JS_DupValue 强引用；本版 QuickJS 的 JSValue 为
 *              16 字节 = JSValueUnion 8B + int64 tag 8B，字段必须按 16 字节排布）
 *   [64..71]   JSContext *ctx（创建该闭包的 context，捕获）
 *
 * 无跨 context 全局：ctx 与 wrapper 在创建时捕获进块，回调永远回到创建它的
 * context。Worker 导入 'ffi' 不会污染其它 context；wrapper 天生属于其创建
 * context，连注册派发环节都不存在。
 *
 * 生命周期：closureNew 对 wrapper 做 JS_DupValue（wrapper 闭包再持有用户 fn，
 * 故 fn 一并存活）；dispose（closureFree，按块地址）做 JS_FreeValue + VirtualFree。
 *
 * 线程模型：仅同步同线程回调（JS 调用线程内由 Win32 API 同步回调）。
 */
#include <string.h>
#include <windows.h>
#include "quickjs.h"
#include "quickjs-ffi-closure.h"

#define CLOSURE_BLOCK_SIZE 128
#define CLOSURE_OFF_MAGIC 32
#define CLOSURE_OFF_RETKIND 36
#define CLOSURE_OFF_ARGBYTES 40
#define CLOSURE_OFF_FN 48
#define CLOSURE_OFF_CTX 64
#define CLOSURE_MAGIC 0x51AC0FFu

static int closure_valid(uint8_t *blk)
{
    return *(uint32_t *)(blk + CLOSURE_OFF_MAGIC) == CLOSURE_MAGIC;
}

/* 写一条 trampoline（块地址 + 共享派发器地址；绝对跳转，不依赖 rel32 距离） */
static void write_trampoline(uint8_t *blk, uint8_t *dispatch)
{
#if defined(__i386__)
    blk[0] = 0xB8;                                    /* movl $<block:u32>, %eax */
    uint32_t b = (uint32_t)(uintptr_t)blk;
    memcpy(blk + 1, &b, 4);
    blk[5] = 0xBA;                                    /* movl $<dispatch:u32>, %edx */
    uint32_t d = (uint32_t)(uintptr_t)dispatch;
    memcpy(blk + 6, &d, 4);
    blk[10] = 0xFF; blk[11] = 0xE2;                   /* jmp *%edx */
#else
    blk[0] = 0x49; blk[1] = 0xBA;                     /* movq $<block:u64>, %r10 */
    uint64_t b = (uint64_t)(uintptr_t)blk;
    memcpy(blk + 2, &b, 8);
    blk[10] = 0x49; blk[11] = 0xBB;                   /* movq $<dispatch:u64>, %r11 */
    uint64_t d = (uint64_t)(uintptr_t)dispatch;
    memcpy(blk + 12, &d, 8);
    blk[20] = 0x41; blk[21] = 0xFF; blk[22] = 0xE3;   /* jmp *%r11 */
#endif
}

/* C→JS 桥接：data[size] 拷成 JS ArrayBuffer，调块内 wrapper (frame, retBuf)，
   再把 retBuf 的 8 字节写回 out。任何失败（异常/未注册）out 保持 0。
   用块内捕获的 ctx/wrapper，绝不碰跨 context 全局。 */
static void invoke_closure_js(uint8_t *blk, const uint8_t *data, size_t size, uint8_t *out)
{
    JSContext *ctx = *(JSContext **)(blk + CLOSURE_OFF_CTX);
    JSValue wrapper = *(JSValue *)(blk + CLOSURE_OFF_FN);
    if (!ctx || JS_IsUndefined(wrapper) || !closure_valid(blk)) {
        memset(out, 0, 8);
        return;
    }
    JSValue frame = JS_NewArrayBufferCopy(ctx, data, size);
    uint8_t zero8[8] = { 0 };
    JSValue retbuf = JS_NewArrayBufferCopy(ctx, zero8, 8);   /* 8 字节零 */
    if (JS_IsException(frame) || JS_IsException(retbuf)) {
        JS_FreeValue(ctx, frame);
        JS_FreeValue(ctx, retbuf);
        memset(out, 0, 8);
        return;
    }
    JSValue argv[2] = { frame, retbuf };
    JSValue r = JS_Call(ctx, wrapper, JS_UNDEFINED, 2, argv);
    if (JS_IsException(r)) {
        /* wrapper 内部应已 try/catch 用户回调；走到这里多半是 wrapper 自身崩，
           吞掉异常继续，结果槽保持 0 */
        JSValue ex = JS_GetException(ctx);
        JS_FreeValue(ctx, ex);
        memset(out, 0, 8);
    } else {
        JS_FreeValue(ctx, r);
        size_t olen;
        uint8_t *optr = JS_GetArrayBuffer(ctx, &olen, retbuf);
        if (optr && olen >= 8)
            memcpy(out, optr, 8);
    }
    JS_FreeValue(ctx, frame);
    JS_FreeValue(ctx, retbuf);
}

#if defined(__i386__)
uint32_t qwin_closure_inner_ia32(uint32_t block, const uint8_t *stack_args, uint8_t *result)
{
    uint8_t *blk = (uint8_t *)(uintptr_t)block;
    uint32_t ret_kind = 0;
    if (closure_valid(blk)) {
        ret_kind = *(uint32_t *)(blk + CLOSURE_OFF_RETKIND);
        invoke_closure_js(blk, stack_args, 16 * 4 /* 最多 16 个 4 字节槽 */, result);
    } else {
        memset(result, 0, 8);
    }
    return ret_kind;
}
#else
void qwin_closure_inner_win64(uint64_t block, const uint8_t *int_args,
                              const uint8_t *stack_args, uint8_t *frame)
{
    uint8_t *blk = (uint8_t *)(uintptr_t)block;
    uint8_t buf[32 + 96 + 32];
    if (closure_valid(blk)) {
        memcpy(buf, int_args, 32);
        memcpy(buf + 32, stack_args, 96);
        memcpy(buf + 128, frame + 16, 32);              /* xmm0-3 */
        invoke_closure_js(blk, buf, sizeof(buf), frame);
    } else {
        memset(frame, 0, 8);
    }
}
#endif

/* ---- JS 可见导出：closureNew / closureFree ---- */

static JSValue js_ffi_closure_new(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    int32_t arg_bytes = 0, ret_kind = 0;
    if (argc < 3)
        return JS_ThrowTypeError(ctx, "closureNew: expected (argBytes, retKind, wrapper)");
    JS_ToInt32(ctx, &arg_bytes, argv[0]);
    JS_ToInt32(ctx, &ret_kind, argv[1]);
    if (!JS_IsFunction(ctx, argv[2]))
        return JS_ThrowTypeError(ctx, "closureNew: third argument must be a function");

    uint8_t *blk = (uint8_t *)VirtualAlloc(NULL, CLOSURE_BLOCK_SIZE,
                                           MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!blk)
        return JS_ThrowTypeError(ctx, "closureNew: VirtualAlloc failed");

    /* 元数据先写（RW 态），再锁 RX。ctx/wrapper 均在创建 context 捕获。 */
    *(uint32_t *)(blk + CLOSURE_OFF_MAGIC) = CLOSURE_MAGIC;
    *(uint32_t *)(blk + CLOSURE_OFF_RETKIND) = (uint32_t)ret_kind;
    *(uint32_t *)(blk + CLOSURE_OFF_ARGBYTES) = (uint32_t)arg_bytes;
    *(JSContext **)(blk + CLOSURE_OFF_CTX) = ctx;
    *(JSValue *)(blk + CLOSURE_OFF_FN) = JS_DupValue(ctx, argv[2]);
#if defined(__i386__)
    write_trampoline(blk, (uint8_t *)qwin_closure_dispatch_ia32);
#else
    write_trampoline(blk, (uint8_t *)qwin_closure_dispatch_win64);
#endif
    DWORD old;
    if (!VirtualProtect(blk, CLOSURE_BLOCK_SIZE, PAGE_EXECUTE_READ, &old)) {
        JS_FreeValue(ctx, *(JSValue *)(blk + CLOSURE_OFF_FN));
        VirtualFree(blk, 0, MEM_RELEASE);
        return JS_ThrowTypeError(ctx, "closureNew: VirtualProtect failed");
    }
    /* 直接返回块地址（= 函数指针） */
    return JS_NewInt64(ctx, (int64_t)(intptr_t)blk);
}

static JSValue js_ffi_closure_free(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    int64_t ptr = 0;
    if (argc >= 1)
        JS_ToInt64(ctx, &ptr, argv[0]);
    uint8_t *blk = (uint8_t *)(intptr_t)ptr;
    if (blk && closure_valid(blk)) {
        JS_FreeValue(ctx, *(JSValue *)(blk + CLOSURE_OFF_FN));
        VirtualFree(blk, 0, MEM_RELEASE);
    }
    return JS_UNDEFINED;
}

const JSCFunctionListEntry qwin_closure_funcs[QWIN_CLOSURE_FUNCS_COUNT] = {
    JS_CFUNC_DEF("closureNew", 3, js_ffi_closure_new),
    JS_CFUNC_DEF("closureFree", 1, js_ffi_closure_free),
};
