#include <stdio.h>
#include <string.h>
#include <windows.h>
#include "quickjs.h"
#include "quickjs-ffi.h"
#include "quickjs-ffi-closure.h"

/* 内建调用器：ia32 / x64 都走本地汇编桩（REMOVE_LIBFFI_PLAN.md S3 / S5）。
   第三方 FFI 后端已不参与构建（S6）；参数打包下沉到 JS 侧（§10），本文件不再需要
   FFI_TYPE_* 类型表（quickjs-ffi-type.h 仅作文档参照）。 */
#include "quickjs-ffi-call.h"

/**
 * ffiCall(func, argFrame: ArrayBuffer, retBuf: ArrayBuffer, retIsFp: 0|1)
 *
 * 参数由 JS 用 DataView 打包成连续 argFrame，返回写进 JS 分配的 retBuf；
 * 本函数不做任何类型表/槽宽逻辑，只负责「搬运 + call + 取原始返回」。
 * argFrame/retBuf 的真实大小即所需大小（JS 总是 new ArrayBuffer(total) 后
 * 原样传入），故不传字节数参数，直接以 JS_GetArrayBuffer 返回的大小为准。
 * 布局按架构解释 argFrame：
 *   - ia32：连续 cdecl 参数区（每参数 4/8 字节，无填充），总长 = Σ槽宽
 *   - x64：8 字节宽槽数组，nargs = af_size / 8
 * retBuf 必须 >= 8 字节：桩按 ret_fp 把选定的 8 字节返回值直接写进 retBuf
 * （浮点写 XMM0/ST0，整数写 RAX/EAX+EDX）。ret_fp 对 x64 也必需：桩据此
 * 决定写哪个寄存器；ia32 上它还兼作 x87 空栈保护（整数返回时 x87 栈为空，
 * 无条件 fstpl 会置 FE_INVALID）。
 */
static JSValue js_ffi_call(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    int64_t _func, _fp;
    JS_ToInt64(ctx, &_func, argv[0]);
    JS_ToInt64(ctx, &_fp, argv[3]);

    size_t af_size, rb_size;
    void *argFrame = JS_GetArrayBuffer(ctx, &af_size, argv[1]);
    if (JS_HasException(ctx))
        return JS_EXCEPTION;
    void *retBuf = JS_GetArrayBuffer(ctx, &rb_size, argv[2]);
    if (JS_HasException(ctx))
        return JS_EXCEPTION;

    /* 参数上限 64（x64 每槽 8 字节） */
    if (af_size > 64 * 8)
        return JS_ThrowTypeError(ctx, "ffiCall: too many arguments");
    if (rb_size < 8)
        return JS_ThrowTypeError(ctx, "ffiCall: retBuf must be >= 8 bytes");

    void *func = (void *)_func;
    /* 桩把选定的 8 字节返回值直接写进 retBuf（ret_fp 决定整数槽还是浮点槽），
       故本函数不再需要中转的 ret/fp 与 memcpy。 */
#if defined(__i386__)
    qwin_ffi_call_ia32(func, argFrame, (uint32_t)af_size, retBuf, (int)_fp);
#else
    qwin_ffi_call_win64(func, (const uint64_t *)argFrame, (uint32_t)(af_size / 8), retBuf, (int)_fp);
#endif
    return JS_UNDEFINED;
}

static JSValue js_ffi_buffer_ptr(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    size_t size;
    void *ptr = JS_GetArrayBuffer(ctx, &size, argv[0]);
    if (!ptr)
        return JS_ThrowTypeError(ctx, "argument must be an ArrayBuffer");
    return JS_NewInt64(ctx, (int64_t)ptr);
}

static JSValue js_ffi_read_byte(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    int64_t ptr;
    JS_ToInt64(ctx, &ptr, argv[0]);
    return JS_NewInt32(ctx, *(uint8_t *)(intptr_t)ptr);
}

static JSValue js_ffi_write_byte(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    int64_t ptr, val;
    JS_ToInt64(ctx, &ptr, argv[0]);
    JS_ToInt64(ctx, &val, argv[1]);
    *(uint8_t *)(intptr_t)ptr = (uint8_t)val;
    return JS_UNDEFINED;
}

/* readBytes(ptr, len) -> ArrayBuffer：native 批量拷出，供结构 decode 的裸地址分支
   一次取整段——替代 JS 侧逐字节 readByte 循环（N 次 JS→C 往返降为 1 次 memcpy）。
   ptr=0 fail-loud throw（地址 0 必然访问违例，显式报错优于进程崩溃）；负 len 由
   JS_ToIndex 拒（自带 RangeError；小数/NaN 按 ToInteger 语义截断——非整型入参由
   调用方自己保证，现有两处 decode 传的都是布局计算出的整数）。野指针与 readByte
   同一信任边界，由调用方担保（decode 收到的地址来自 alloc()/C 返回值）。 */
static JSValue js_ffi_read_bytes(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    int64_t ptr;
    uint64_t len;
    JS_ToInt64(ctx, &ptr, argv[0]);
    if (JS_ToIndex(ctx, &len, argv[1]))
        return JS_EXCEPTION; /* JS_ToIndex 已抛 RangeError */
    if (ptr == 0)
        return JS_ThrowRangeError(ctx, "readBytes: null pointer");
    /* 内部 malloc+memcpy；len > INT32_MAX 由其 RangeError 拒 */
    return JS_NewArrayBufferCopy(ctx, (const uint8_t *)(intptr_t)ptr, (size_t)len);
}

static const JSCFunctionListEntry ffi_funcs[] = {
    JS_CFUNC_DEF("ffiCall", 4, js_ffi_call),
    JS_CFUNC_DEF("bufferPtr", 1, js_ffi_buffer_ptr),
    JS_CFUNC_DEF("readByte", 1, js_ffi_read_byte),
    JS_CFUNC_DEF("readBytes", 2, js_ffi_read_bytes),
    JS_CFUNC_DEF("writeByte", 2, js_ffi_write_byte),
};

static int js_ffi_init(JSContext *ctx, JSModuleDef *m)
{
    JS_SetModuleExportList(ctx, m, ffi_funcs, sizeof(ffi_funcs) / sizeof(ffi_funcs[0]));
    JS_SetModuleExportList(ctx, m, qwin_closure_funcs,
                           sizeof(qwin_closure_funcs) / sizeof(qwin_closure_funcs[0]));
    return 0;
}

JSModuleDef *js_init_module_ffi(JSContext *ctx)
{
    JSModuleDef *m;
    m = JS_NewCModule(ctx, "ffi", js_ffi_init);
    if (!m)
        return NULL;
    JS_AddModuleExportList(ctx, m, ffi_funcs, sizeof(ffi_funcs) / sizeof(ffi_funcs[0]));
    JS_AddModuleExportList(ctx, m, qwin_closure_funcs,
                           sizeof(qwin_closure_funcs) / sizeof(qwin_closure_funcs[0]));
    return m;
}