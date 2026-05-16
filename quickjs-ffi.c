#include <stdio.h>
#include <windows.h>
#include <ffi.h>
#include "quickjs.h"
#include "quickjs-ffi.h"

static ffi_type *ffi_types[] = {
    &ffi_type_void,
    NULL,
    NULL,
    NULL,
    NULL,
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
    ffi_type *arg_types[length];
    int64_t args[length];
    void *ffi_args[length];
    for (int i = 0; i < length; i++)
    {
        ffi_args[i] = args + i;
        printf("%u\n", ffi_args[i]);
    }
    for (int i = 0; i < length; i++)
    {
        JSValue js_arg_type = JS_GetPropertyUint32(ctx, js_arg_types_array, i);
        int64_t arg_type;
        JS_ToInt64(ctx, &arg_type, js_arg_type);
        arg_types[i] = ffi_types[arg_type];
        printf(" %d ", arg_type);

        JSValue js_arg = JS_GetPropertyUint32(ctx, js_args_array, i);
        if (arg_type == FFI_TYPE_POINTER)
        {
            if (JS_IsNull(js_arg))
            {
                args[i] = 0;
            }
            else
            {
                size_t size;
                args[i] = (int64_t)JS_GetArrayBuffer(ctx, &size, js_arg);
                // check exception
            }
        }
        else
        {
            JS_ToInt64(ctx, args + i, js_arg);
        }
        printf(" %u ", args[i]);
    }

    ffi_cif cif;
    ffi_status status;
    uint64_t ret;
    status = ffi_prep_cif(&cif, FFI_DEFAULT_ABI, length, ffi_types[ret_type], arg_types);
    printf("\nStatus: %d\n", status);
    ffi_call(&cif, func, &ret, ffi_args);

    if (ret_type == FFI_TYPE_VOID)
    {
        return JS_UNDEFINED;
    }
    else
    {
        return JS_NewInt64(ctx, ret);
    }
}

static const JSCFunctionListEntry ffi_funcs[] = {
    JS_CFUNC_DEF("ffiCall", 4, js_ffi_call),
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