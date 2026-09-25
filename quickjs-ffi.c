#include <stdio.h>
#include <string.h>
#include <windows.h>
#include <ffi.h>
#include "quickjs.h"
#include "quickjs-ffi.h"

static ffi_type *ffi_types[] = {
    &ffi_type_void,
    NULL,
    NULL,
    &ffi_type_float,
    &ffi_type_double,
    &ffi_type_uint8,
    &ffi_type_sint8,
    &ffi_type_uint16,
    &ffi_type_sint16,
    &ffi_type_uint32,
    &ffi_type_sint32,
    &ffi_type_uint64,
    &ffi_type_sint64,
    NULL,
    &ffi_type_pointer,
};

/**
 * @argv: func arg_types:ffi_type[] args:[] ret_type:ffi_type
 */
JSValue js_ffi_call(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{

    int64_t _func;
    JS_ToInt64(ctx, &_func, argv[0]);
    void *func = (void *)_func;
    JSValue js_arg_types_array = argv[1];
    JSValue js_args_array = argv[2];
    JSValue js_ret_type = argv[3];
    int64_t ret_type;
    JS_ToInt64(ctx, &ret_type, js_ret_type);

    JSValue len = JS_GetPropertyStr(ctx, js_arg_types_array, "length");
    int64_t length;
    JS_ToInt64(ctx, &length, len);
    JS_FreeValue(ctx, len);
    ffi_type *arg_types[length];
    uint64_t args[length];
    void *ffi_args[length];
    for (int i = 0; i < length; i++)
    {
        // 所有参数统一由 64 位位宽槽存储（8 字节），ffi_args[i] 指向槽位。
        // libffi 按 arg_types[i] 从槽起始读 N 字节：整数写满整槽，小端下
        // 取低 N 字节即正确（int32 读前 4 字节）；float/double 按位模式
        // memcpy 进槽。大端上 int64 槽高 N 字节对小值全是 0 → 传参全变 0；
        // Windows 全平台均为小端，此处明确不做大端适配。
        ffi_args[i] = args + i;
    }
    for (int i = 0; i < length; i++)
    {
        JSValue js_arg_type = JS_GetPropertyUint32(ctx, js_arg_types_array, i);
        int64_t arg_type;
        JS_ToInt64(ctx, &arg_type, js_arg_type);
        JS_FreeValue(ctx, js_arg_type);
        arg_types[i] = ffi_types[arg_type];

        JSValue js_arg = JS_GetPropertyUint32(ctx, js_args_array, i);
        if (arg_type == FFI_TYPE_POINTER)
        {
            if (JS_IsNull(js_arg) || JS_IsUndefined(js_arg))
            {
                args[i] = (uint64_t)NULL;
            }
            else if (JS_IsNumber(js_arg))
            {
                // 句柄/裸指针（HDC/HWND…）按指针槽宽直通：ia32 4 字节、x64 8 字节，避免错用 UINT64 在 x86 栈上错位
                int64_t v;
                JS_ToInt64(ctx, &v, js_arg);
                args[i] = (uint64_t)v;
            }
            else
            {
                size_t size;
                args[i] = (uint64_t)JS_GetArrayBuffer(ctx, &size, js_arg);
                if (JS_HasException(ctx))
                {
                    JS_FreeValue(ctx, js_arg);
                    return JS_EXCEPTION;
                }
            }
        }
        else
        {
            if (arg_type == FFI_TYPE_FLOAT || arg_type == FFI_TYPE_DOUBLE)
            {
                double f;
                JS_ToFloat64(ctx, &f, js_arg);
                if (arg_type == FFI_TYPE_FLOAT)
                {
                    float f32 = (float)f;
                    memcpy(&args[i], &f32, sizeof(f32));
                }
                else
                {
                    memcpy(&args[i], &f, sizeof(f));
                }
            }
            else
            {
                // 非指针类型的整数参数统一以 64 位位宽存入 args[i]
                // ffi_call 会按 arg_types[i] 从 args[i] 开头读 N 个字节
                // 小端：读低 N 字节，结果正确（例如 int32 读前 4 字节即正确的 32 位值）
                // 大端：读高 N 字节，小值的高位全是 0 → 传参全部变 0
                // Windows 全平台均为小端，此处明确不做大端适配
                int64_t v;
                JS_ToInt64(ctx, &v, js_arg);
                args[i] = (uint64_t)v;
            }
        }
        JS_FreeValue(ctx, js_arg);
    }

    ffi_cif cif;
    ffi_status status;
    uint64_t ret = 0;
    status = ffi_prep_cif(&cif, FFI_DEFAULT_ABI, length, ffi_types[ret_type], arg_types);
    ffi_call(&cif, func, &ret, ffi_args);

    if (ret_type == FFI_TYPE_VOID)
        return JS_UNDEFINED;
    if (ret_type == FFI_TYPE_DOUBLE)
    {
        double d;
        memcpy(&d, &ret, sizeof(d));
        return JS_NewFloat64(ctx, d);
    }
    if (ret_type == FFI_TYPE_FLOAT)
    {
        float f;
        memcpy(&f, &ret, sizeof(f));
        return JS_NewFloat64(ctx, f);
    }
    if (ret_type == FFI_TYPE_POINTER && ret == (uint64_t)NULL)
        return JS_NULL;
    // 整数返回值不依赖 libffi 是否符号扩展写回（x64 会扩展、x86 只写低 4 字节），
    // 按声明类型显式截断 + 符号/零扩展，保证 i8/i16/i32 负数在 JS 里读回负数。
    switch (ret_type)
    {
    case FFI_TYPE_UINT8:
        return JS_NewInt64(ctx, (int64_t)(uint8_t)ret);
    case FFI_TYPE_SINT8:
        return JS_NewInt64(ctx, (int64_t)(int8_t)ret);
    case FFI_TYPE_UINT16:
        return JS_NewInt64(ctx, (int64_t)(uint16_t)ret);
    case FFI_TYPE_SINT16:
        return JS_NewInt64(ctx, (int64_t)(int16_t)ret);
    case FFI_TYPE_UINT32:
        return JS_NewInt64(ctx, (int64_t)(uint32_t)ret);
    case FFI_TYPE_SINT32:
        return JS_NewInt64(ctx, (int64_t)(int32_t)ret);
    case FFI_TYPE_UINT64:
    case FFI_TYPE_SINT64:
    default:
        return JS_NewInt64(ctx, (int64_t)ret);
    }
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

static const JSCFunctionListEntry ffi_funcs[] = {
    JS_CFUNC_DEF("ffiCall", 4, js_ffi_call),
    JS_CFUNC_DEF("bufferPtr", 1, js_ffi_buffer_ptr),
    JS_CFUNC_DEF("readByte", 1, js_ffi_read_byte),
    JS_CFUNC_DEF("writeByte", 2, js_ffi_write_byte),
};

#define DEF(x) JS_PROP_INT32_DEF(#x, x, JS_PROP_CONFIGURABLE)
static const JSCFunctionListEntry ffi_consts[] = {
    DEF(FFI_TYPE_VOID),
    DEF(FFI_TYPE_UINT8),
    DEF(FFI_TYPE_SINT8),
    DEF(FFI_TYPE_UINT16),
    DEF(FFI_TYPE_SINT16),
    DEF(FFI_TYPE_UINT32),
    DEF(FFI_TYPE_SINT32),
    DEF(FFI_TYPE_UINT64),
    DEF(FFI_TYPE_SINT64),
    DEF(FFI_TYPE_FLOAT),
    DEF(FFI_TYPE_DOUBLE),
    DEF(FFI_TYPE_POINTER),
#undef DEF
};

static int js_ffi_init(JSContext *ctx, JSModuleDef *m)
{
    JS_SetModuleExportList(ctx, m, ffi_consts, sizeof(ffi_consts) / sizeof(ffi_consts[0]));
    JS_SetModuleExportList(ctx, m, ffi_funcs, sizeof(ffi_funcs) / sizeof(ffi_funcs[0]));
    return 0;
}

JSModuleDef *js_init_module_ffi(JSContext *ctx)
{
    JSModuleDef *m;
    m = JS_NewCModule(ctx, "ffi", js_ffi_init);
    if (!m)
        return NULL;
    JS_AddModuleExportList(ctx, m, ffi_consts, sizeof(ffi_consts) / sizeof(ffi_consts[0]));
    JS_AddModuleExportList(ctx, m, ffi_funcs, sizeof(ffi_funcs) / sizeof(ffi_funcs[0]));
    return m;
}