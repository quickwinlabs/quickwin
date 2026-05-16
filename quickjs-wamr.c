#include "quickjs-wamr.h"
#include "wasm_export.h"
#include "wasm.h"
#include "cutils.h"
#include <stdlib.h>
#include <stdio.h>

#define MAX_WASM_IMPORTS 64

#define MAX_WASMSTORE_COUNT 10

#ifdef DEBUG
#define DEBUG_PRINTF(...) printf(__VA_ARGS__)
#else
#define DEBUG_PRINTF(...) do {} while (0)
#endif

// ─── WASM Class IDs ────────────────────────────────────────────
static JSClassID js_webassembly_module_class_id;
static JSClassID js_webassembly_instance_class_id;
static JSClassID js_webassembly_global_class_id;
static JSClassID js_webassembly_memory_class_id;
static JSClassID js_webassembly_table_class_id;

// ─── WASM Runtime Structs ──────────────────────────────────────
typedef struct QJWasmModule
{
    uint8_t *buf;
    wasm_module_t module;
    NativeSymbol *import_funcs;
    int32_t import_func_count;
} QJWasmModule;

typedef struct QJWasmInstance
{
    JSContext *ctx;
    JSValue module_obj;
    JSValue import_obj;
    wasm_module_inst_t inst;
} QJWasmInstance;

typedef struct QJWasmGlobal
{
    wasm_valkind_t kind;
    bool is_mutable;
    WASMValue standalone_value;
    void *global_data;
    JSValue exported_by;
} QJWasmGlobal;

typedef struct QJWasmMemory
{
    uint8_t *local_data;
    uint32_t local_pages;
    uint32_t local_max_pages;
    wasm_memory_inst_t mem_inst;
    JSValue exported_by;
    JSValue cached_buffer;
} QJWasmMemory;

typedef struct QJWasmTable
{
    wasm_table_inst_t table_inst;
    wasm_module_inst_t module_inst;
    JSValue exported_by;
} QJWasmTable;


JSValue js_call_wasm_bridge(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv, int magic, JSValue *func_data);
static JSValue js_wasm_instance_ctor(JSContext *ctx, JSValueConst new_target,
                                     int argc, JSValueConst *argv);

static void wasm_call_js_bridge(wasm_exec_env_t exec_env, uint64_t *args)
{
    wasm_module_inst_t inst = wasm_runtime_get_module_inst(exec_env);
    if (!inst)
        return;
    QJWasmInstance *wasm_inst = wasm_runtime_get_custom_data(inst);
    if (!wasm_inst)
        return;
    int import_idx = (int)(intptr_t)wasm_runtime_get_function_attachment(exec_env);
    QJWasmModule *wasm_module = JS_GetOpaque(wasm_inst->module_obj, js_webassembly_module_class_id);
    if (!wasm_module)
        return;
    wasm_import_t import;
    wasm_runtime_get_import_type(wasm_module->module, import_idx, &import);
    wasm_func_type_t ft = import.u.func_type;
    const char *module_name = import.module_name;
    const char *name = import.name;

    JSContext *ctx = wasm_inst->ctx;
    JSValue import_obj = wasm_inst->import_obj;
    JSValue mod = JS_GetPropertyStr(ctx, import_obj, module_name);
    JSValue fn = JS_GetPropertyStr(ctx, mod, name);
    uint32_t param_count = wasm_func_type_get_param_count(ft);
    uint32_t result_count = wasm_func_type_get_result_count(ft);
    JSValue *js_argv = NULL;
    if (param_count > 0) {
        js_argv = js_malloc(ctx, sizeof(JSValue) * param_count);
        uint64_t *_args = args;
        for (uint32_t i = 0; i < param_count; i++)
        {
            wasm_valkind_t vk = wasm_func_type_get_param_valkind(ft, i);
            JSValue arg = JS_UNDEFINED;
            switch (vk)
            {
            case WASM_I32:
            {
                native_raw_get_arg(int32_t, n, _args);
                arg = JS_NewInt32(ctx, n);
                break;
            }
            case WASM_I64:
            {
                native_raw_get_arg(int64_t, n, _args);
                arg = JS_NewInt64(ctx, n);
                break;
            }
            case WASM_F32:
            {
                native_raw_get_arg(float, n, _args);
                arg = JS_NewFloat64(ctx, n);
                break;
            }
            case WASM_F64:
            {
                native_raw_get_arg(double, n, _args);
                arg = JS_NewFloat64(ctx, n);
                break;
            }
            default:
                arg = JS_UNDEFINED;
                break;
            }
            js_argv[i] = arg;
        }
    }
    JSValue ret = JS_Call(ctx, fn, JS_UNDEFINED, param_count, js_argv);

    js_free(ctx, js_argv);
    if (JS_IsException(ret))
    {
        JS_FreeValue(ctx, ret);
        JS_FreeValue(ctx, fn);
        JS_FreeValue(ctx, mod);
        return;
    }
    if (result_count > 0)
    {
        wasm_valkind_t rk = wasm_func_type_get_result_valkind(ft, 0);
        switch (rk)
        {
        case WASM_I32:
        {
            int32_t v;
            JS_ToInt32(ctx, &v, ret);
            // TODO: check
            ((int32_t *)args)[0] = v;
            break;
        }
        case WASM_I64:
        {
            int64_t v;
            JS_ToInt64(ctx, &v, ret);
            args[0] = v;
            break;
        }
        case WASM_F32:
        {
            double d;
            JS_ToFloat64(ctx, &d, ret);
            ((float *)args)[0] = (float)d;
            break;
        }
        case WASM_F64:
        {
            double d;
            JS_ToFloat64(ctx, &d, ret);
            ((double *)args)[0] = d;
            break;
        }
        }
    }

    JS_FreeValue(ctx, ret);
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, mod);
}

static JSValue create_wasm_module_object(JSContext *ctx, const uint8_t *buf, wasm_module_t module)
{
    JSValue obj = JS_NewObjectClass(ctx, js_webassembly_module_class_id);
    QJWasmModule *wasm_module = js_mallocz(ctx, sizeof(QJWasmModule));
    wasm_module->module = module;
    wasm_module->buf = buf;
    int import_count = wasm_runtime_get_import_count(wasm_module->module);
    int func_count = 0;
    for (int i = 0; i < import_count; i++)
    {
        wasm_import_t import;
        wasm_runtime_get_import_type(wasm_module->module, i, &import);
        if (import.kind == WASM_IMPORT_EXPORT_KIND_FUNC)
            func_count++;
    }
    wasm_module->import_func_count = func_count;
    if (func_count)
        wasm_module->import_funcs = js_mallocz(ctx, func_count * sizeof(NativeSymbol));
    for (int i = 0, fidx = 0; i < import_count; i++)
    {
        wasm_import_t import;
        wasm_runtime_get_import_type(wasm_module->module, i, &import);
        if (import.kind != WASM_IMPORT_EXPORT_KIND_FUNC)
            continue;
        NativeSymbol s = {
            .symbol = import.name,
            .attachment = (void *)(intptr_t)i,
            .signature = NULL,
            .func_ptr = wasm_call_js_bridge};
        wasm_module->import_funcs[fidx++] = s;
        wasm_runtime_register_natives_raw(import.module_name, &wasm_module->import_funcs[fidx - 1], 1);
    }
    wasm_runtime_resolve_symbols(module);

    JS_SetOpaque(obj, wasm_module);

    return obj;
}

static JSValue js_webassembly_validate(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t buf_size;
    uint8_t *_buf = JS_GetArrayBuffer(ctx, &buf_size, argv[0]);

    if (!_buf || buf_size == 0)
        return JS_FALSE;

    uint8_t *buf = js_malloc(ctx, buf_size);
    memcpy(buf, _buf, buf_size);
    wasm_module_t m = wasm_runtime_load(buf, buf_size, NULL, 0);
    JSValue ret = JS_FALSE;
    if (m)
    {
        ret = JS_TRUE;
        wasm_runtime_unload(m);
    }
    js_free(ctx, buf);
    return ret;
}

static JSValue js_webassembly_compile(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t buf_size;
    uint8_t *_buf = JS_GetArrayBuffer(ctx, &buf_size, argv[0]);

    JSValue promise, resolving_funcs[2];

    promise = JS_NewPromiseCapability(ctx, resolving_funcs);
    if (JS_IsException(promise))
        return JS_EXCEPTION;

    if (!_buf || buf_size == 0)
    {
        JS_ThrowTypeError(ctx, "Invalid ArrayBuffer");
        JSValue error = JS_GetException(ctx);
        JS_Call(ctx, resolving_funcs[1], JS_UNDEFINED, 1, (JSValueConst *)&error);
        JS_FreeValue(ctx, error);
        goto done;
    }

    uint8_t *buf = js_malloc(ctx, buf_size);
    memcpy(buf, _buf, buf_size);
    if (!buf)
    {
        JS_ThrowTypeError(ctx, "Invalid ArrayBuffer");
        JSValue error = JS_GetException(ctx);
        JS_Call(ctx, resolving_funcs[1], JS_UNDEFINED, 1, (JSValueConst *)&error);
        JS_FreeValue(ctx, error);
        goto done;
    }
    LoadArgs args = {.no_resolve = true};
    wasm_module_t module = wasm_runtime_load_ex(buf, buf_size, &args, NULL, 0);
    if (!module)
    {
        JS_ThrowTypeError(ctx, "WASM compilation failed");
        JSValue error = JS_GetException(ctx);
        JS_Call(ctx, resolving_funcs[1], JS_UNDEFINED, 1, (JSValueConst *)&error);
        JS_FreeValue(ctx, error);
        goto done;
    }

    JSValue module_obj = create_wasm_module_object(ctx, buf, module);
    JS_Call(ctx, resolving_funcs[0], JS_UNDEFINED, 1, (JSValueConst *)&module_obj);
    JS_FreeValue(ctx, module_obj);

done:
    JS_FreeValue(ctx, resolving_funcs[0]);
    JS_FreeValue(ctx, resolving_funcs[1]);
    return promise;
}

static JSValue js_webassembly_instantiate(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "WebAssembly.instantiate: missing buffer argument");

    size_t buf_size;
    uint8_t *_buf = JS_GetArrayBuffer(ctx, &buf_size, argv[0]);
    if (!_buf || buf_size == 0) {
        JSValue buffer_val = JS_GetPropertyStr(ctx, argv[0], "buffer");
        if (!JS_IsException(buffer_val)) {
            _buf = JS_GetArrayBuffer(ctx, &buf_size, buffer_val);
            JS_FreeValue(ctx, buffer_val);
        }
    }
    if (!_buf || buf_size == 0)
        return JS_ThrowTypeError(ctx, "WebAssembly.instantiate: first argument must be an ArrayBuffer");

    uint8_t *buf = js_malloc(ctx, buf_size);
    memcpy(buf, _buf, buf_size);
    LoadArgs args = {.no_resolve = true};
    wasm_module_t module = wasm_runtime_load_ex(buf, buf_size, &args, NULL, 0);
    if (!module)
    {
        js_free(ctx, buf);
        return JS_ThrowTypeError(ctx, "WebAssembly.instantiate: compilation failed");
    }
    JSValue module_obj = create_wasm_module_object(ctx, buf, module);

    JSValue inst_args[2];
    inst_args[0] = module_obj;
    int inst_argc = 1;
    if (argc >= 2 && JS_IsObject(argv[1]))
    {
        inst_args[1] = argv[1];
        inst_argc = 2;
    }
    JSValue inst_obj = js_wasm_instance_ctor(ctx, JS_UNDEFINED, inst_argc, inst_args);

    if (JS_IsException(inst_obj))
    {
        JS_FreeValue(ctx, module_obj);
        return inst_obj;
    }

    JSValue result = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, result, "module", module_obj);
    JS_SetPropertyStr(ctx, result, "instance", inst_obj);
    // JS_FreeValue(ctx, module_obj);
    // JS_FreeValue(ctx, inst_obj);

    JSValue promise, resolving_funcs[2];
    promise = JS_NewPromiseCapability(ctx, resolving_funcs);
    if (JS_IsException(promise))
    {
        JS_FreeValue(ctx, result);
        return promise;
    }
    JS_Call(ctx, resolving_funcs[0], JS_UNDEFINED, 1, (JSValueConst *)&result);
    JS_FreeValue(ctx, resolving_funcs[0]);
    JS_FreeValue(ctx, resolving_funcs[1]);
    JS_FreeValue(ctx, result);
    return promise;
}

static const JSCFunctionListEntry js_webassembly_funcs[] = {
    JS_CFUNC_DEF("validate", 1, js_webassembly_validate),
    JS_CFUNC_DEF("compile", 1, js_webassembly_compile),
    JS_CFUNC_DEF("instantiate", 2, js_webassembly_instantiate),
};

JSValue js_webassembly_module_ctor(JSContext *ctx, JSValueConst new_target, int argc, JSValueConst *argv)
{
    if (argc < 1)
    {
        return JS_ThrowTypeError(ctx, "Expected at least 1 argument");
    }

    size_t buf_size;
    uint8_t *_buf = JS_GetArrayBuffer(ctx, &buf_size, argv[0]);
    if (!_buf || buf_size == 0)
        return JS_ThrowTypeError(ctx, "Invalid ArrayBuffer");

    uint8_t *buf = js_malloc(ctx, buf_size);
    memcpy(buf, _buf, buf_size);

    LoadArgs args = {.no_resolve = true};
    wasm_module_t module = wasm_runtime_load_ex(buf, buf_size, &args, NULL, 0);

    if (!module)
    {
        return JS_ThrowTypeError(ctx, "WASM compilation failed");
    }

    return create_wasm_module_object(ctx, buf, module);
}

static void js_wasm_module_finalizer(JSRuntime *rt, JSValue val)
{
    QJWasmModule *wasm_module = JS_GetOpaque(val, js_webassembly_module_class_id);
    if (wasm_module)
    {
        int import_count = wasm_runtime_get_import_count(wasm_module->module);
        for (int i = 0, fidx = 0; i < import_count; i++)
        {
            wasm_import_t import;
            wasm_runtime_get_import_type(wasm_module->module, i, &import);
            if (import.kind != WASM_IMPORT_EXPORT_KIND_FUNC)
                continue;
            wasm_runtime_unregister_natives(import.module_name, &wasm_module->import_funcs[fidx]);
            fidx++;
        }
        wasm_runtime_unload(wasm_module->module);
        js_free_rt(rt, wasm_module->buf);
        js_free_rt(rt, wasm_module->import_funcs);
        js_free_rt(rt, wasm_module);
    }
}

static char *str_of_kind(wasm_import_export_kind_t kind)
{
    switch (kind)
    {
    case WASM_IMPORT_EXPORT_KIND_FUNC:
        return "function";
    case WASM_IMPORT_EXPORT_KIND_GLOBAL:
        return "global";
    case WASM_IMPORT_EXPORT_KIND_MEMORY:
        return "memory";
    case WASM_IMPORT_EXPORT_KIND_TABLE:
        return "table";
    default:
        return "unknown";
    }
}

static JSValue js_wasm_module_exports(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    if (argc < 1)
    {
        return JS_ThrowTypeError(ctx, "WebAssembly.Module.exports: missing argument");
    }

    QJWasmModule *wasm_module = JS_GetOpaque(argv[0], js_webassembly_module_class_id);
    if (!wasm_module)
    {
        return JS_ThrowTypeError(ctx, "WebAssembly.Module.exports: argument is not a WebAssembly.Module");
    }
    JSValue arr = JS_NewArray(ctx);
    int export_count = wasm_runtime_get_export_count(wasm_module->module);
    for (int i = 0; i < export_count; i++)
    {
        wasm_export_t export;
        wasm_runtime_get_export_type(wasm_module->module, i, &export);
        JSValue obj = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, obj, "name", JS_NewString(ctx, export.name));
        JS_SetPropertyStr(ctx, obj, "kind", JS_NewString(ctx, str_of_kind(export.kind)));
        JS_SetPropertyUint32(ctx, arr, i, obj);
    }

    return arr;
}

static JSValue js_wasm_module_imports(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    if (argc < 1)
    {
        return JS_ThrowTypeError(ctx, "WebAssembly.Module.imports: missing argument");
    }

    QJWasmModule *wasm_module = JS_GetOpaque(argv[0], js_webassembly_module_class_id);
    if (!wasm_module)
    {
        return JS_ThrowTypeError(ctx, "WebAssembly.Module.imports: argument is not a WebAssembly.Module");
    }
    int import_count = wasm_runtime_get_import_count(wasm_module->module);
    JSValue arr = JS_NewArray(ctx);
    for (int i = 0; i < import_count; i++)
    {
        wasm_import_t import;
        wasm_runtime_get_import_type(wasm_module->module, i, &import);
        JSValue obj = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, obj, "module", JS_NewString(ctx, import.module_name));
        JS_SetPropertyStr(ctx, obj, "name", JS_NewString(ctx, import.name));
        JS_SetPropertyStr(ctx, obj, "kind", JS_NewString(ctx, str_of_kind(import.kind)));
        JS_SetPropertyUint32(ctx, arr, i, obj);
    }

    return arr;
}

static JSClassDef js_webassembly_module_class_def = {
    .class_name = "Module",
    .finalizer = js_wasm_module_finalizer};

static void js_js_to_wasm_val(JSContext *ctx, JSValueConst js_val, wasm_val_t *out, wasm_valkind_t kind)
{
    out->kind = kind;
    switch (kind)
    {
    case WASM_I32:
        out->of.i32 = JS_VALUE_GET_INT(js_val);
        break;
    case WASM_I64:
    {
        int64_t v;
        JS_ToInt64(ctx, &v, js_val);
        out->of.i64 = v;
        break;
    }
    case WASM_F32:
    case WASM_F64:
    {
        double v;
        JS_ToFloat64(ctx, &v, js_val);
        if (kind == WASM_F32)
            out->of.f32 = (float)v;
        else
            out->of.f64 = v;
        break;
    }
    default:
        out->of.i32 = 0;
        break;
    }
}

static inline void val_to_ptr(wasm_valkind_t kind, void *ptr, wasm_val_t *val)
{
    switch (kind)
    {
    case WASM_I32:
        *(int32_t *)ptr = val->of.i32;
        break;
    case WASM_I64:
        *(int64_t *)ptr = val->of.i64;
        break;
    case WASM_F32:
        *(float *)ptr = val->of.f32;
        break;
    case WASM_F64:
        *(double *)ptr = val->of.f64;
        break;
    }
}

static inline JSValue ptr_to_js(JSContext *ctx, wasm_valkind_t kind, void *ptr)
{
    switch (kind)
    {
    case WASM_I32:
        return JS_NewInt32(ctx, *(int32_t *)ptr);
    case WASM_I64:
        return JS_NewInt64(ctx, *(int64_t *)ptr);
    case WASM_F32:
        return JS_NewFloat64(ctx, *(float *)ptr);
    case WASM_F64:
        return JS_NewFloat64(ctx, *(double *)ptr);
    default:
        return JS_NewInt32(ctx, 0);
    }
}

// ─── WebAssembly.Global helpers ───────────────────────────────

static wasm_valkind_t js_valkind_from_string(JSContext *ctx, JSValueConst str)
{
    size_t len;
    const char *s = JS_ToCStringLen(ctx, &len, str);
    if (!s)
        return WASM_I32;
    wasm_valkind_t kind = WASM_I32;
    if (len == 3 && memcmp(s, "i32", 3) == 0)
        kind = WASM_I32;
    else if (len == 3 && memcmp(s, "i64", 3) == 0)
        kind = WASM_I64;
    else if (len == 3 && memcmp(s, "f32", 3) == 0)
        kind = WASM_F32;
    else if (len == 3 && memcmp(s, "f64", 3) == 0)
        kind = WASM_F64;
    JS_FreeCString(ctx, s);
    return kind;
}

static JSValue js_wasm_global_ctor(JSContext *ctx, JSValueConst new_target,
                                   int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "WebAssembly.Global: first argument must be a descriptor object");

    JSValue desc = argv[0];
    JSValue val_str = JS_GetPropertyStr(ctx, desc, "value");
    JSValue mut_val = JS_GetPropertyStr(ctx, desc, "mutable");

    wasm_valkind_t kind = js_valkind_from_string(ctx, val_str);
    JS_FreeValue(ctx, val_str);

    bool is_mutable = false;
    if (JS_IsBool(mut_val))
        is_mutable = JS_VALUE_GET_BOOL(mut_val);
    JS_FreeValue(ctx, mut_val);

    QJWasmGlobal *wg = js_mallocz(ctx, sizeof(QJWasmGlobal));
    if (!wg)
        return JS_EXCEPTION;

    wg->kind = kind;
    wg->is_mutable = is_mutable;
    wg->exported_by = JS_UNDEFINED;
    wg->global_data = NULL;

    if (argc >= 2)
    {
        wasm_val_t tmp;
        js_js_to_wasm_val(ctx, argv[1], &tmp, kind);
        switch (kind)
        {
        case WASM_I32:
            wg->standalone_value.i32 = tmp.of.i32;
            break;
        case WASM_I64:
            wg->standalone_value.i64 = tmp.of.i64;
            break;
        case WASM_F32:
            wg->standalone_value.f32 = tmp.of.f32;
            break;
        case WASM_F64:
            wg->standalone_value.f64 = tmp.of.f64;
            break;
        }
    }
    else
    {
        switch (kind)
        {
        case WASM_I32:
            wg->standalone_value.i32 = 0;
            break;
        case WASM_I64:
            wg->standalone_value.i64 = 0;
            break;
        case WASM_F32:
            wg->standalone_value.f32 = 0.0f;
            break;
        default:
            wg->standalone_value.f64 = 0.0;
            break;
        }
    }

    JSValue obj = JS_NewObjectClass(ctx, js_webassembly_global_class_id);
    if (JS_IsException(obj))
    {
        js_free(ctx, wg);
        return obj;
    }
    JS_SetOpaque(obj, wg);
    return obj;
}

static QJWasmGlobal *js_wasm_global_get_this(JSContext *ctx, JSValueConst this_val)
{
    QJWasmGlobal *wg = JS_GetOpaque(this_val, js_webassembly_global_class_id);
    if (!wg)
    {
        JS_ThrowTypeError(ctx, "invalid WebAssembly.Global");
        return NULL;
    }
    return wg;
}

static JSValue js_wasm_global_get_value(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    QJWasmGlobal *wg = js_wasm_global_get_this(ctx, this_val);
    if (!wg)
        return JS_EXCEPTION;

    if (!JS_IsUndefined(wg->exported_by))
        return ptr_to_js(ctx, wg->kind, wg->global_data);

    return ptr_to_js(ctx, wg->kind, &wg->standalone_value);
}

static JSValue js_wasm_global_set_value(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    QJWasmGlobal *wg = js_wasm_global_get_this(ctx, this_val);
    if (!wg)
        return JS_EXCEPTION;

    if (!wg->is_mutable)
        return JS_ThrowTypeError(ctx, "WebAssembly.Global: immutable global cannot be set");

    if (argc < 1)
        return JS_ThrowTypeError(ctx, "WebAssembly.Global.value: missing argument");

    wasm_val_t tmp;
    js_js_to_wasm_val(ctx, argv[0], &tmp, wg->kind);

    if (!JS_IsUndefined(wg->exported_by))
        val_to_ptr(wg->kind, wg->global_data, &tmp);
    else
        val_to_ptr(wg->kind, &wg->standalone_value, &tmp);

    return JS_UNDEFINED;
}

static JSValue js_wasm_global_value_of(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv)
{
    return js_wasm_global_get_value(ctx, this_val, argc, argv);
}

static void js_wasm_global_finalizer(JSRuntime *rt, JSValue val)
{
    QJWasmGlobal *wg = JS_GetOpaque(val, js_webassembly_global_class_id);
    if (wg)
    {
        if (!JS_IsUndefined(wg->exported_by))
            JS_FreeValueRT(rt, wg->exported_by);
        js_free_rt(rt, wg);
    }
}

static void js_wasm_global_mark(JSRuntime *rt, JSValueConst val, JS_MarkFunc *mark_func)
{
    QJWasmGlobal *wg = JS_GetOpaque(val, js_webassembly_global_class_id);
    if (wg && !JS_IsUndefined(wg->exported_by))
        JS_MarkValue(rt, wg->exported_by, mark_func);
}

static JSClassDef js_webassembly_global_class_def = {
    .class_name = "Global",
    .finalizer = js_wasm_global_finalizer,
    .gc_mark = js_wasm_global_mark};

// ─── WebAssembly.Memory ───────────────────────────────────────

#define WASM_PAGE_SIZE 0x10000

static void noop_buffer_free(JSRuntime *rt, void *opaque, void *ptr)
{
    (void)rt; (void)opaque; (void)ptr;
}

static JSValue js_wasm_memory_ctor(JSContext *ctx, JSValueConst new_target,
                                   int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "WebAssembly.Memory: first argument must be a descriptor object");

    JSValue desc = argv[0];
    JSValue init_val = JS_GetPropertyStr(ctx, desc, "initial");
    JSValue max_val = JS_GetPropertyStr(ctx, desc, "maximum");

    int32_t initial = 1, maximum = -1;
    if (JS_IsNumber(init_val))
        JS_ToInt32(ctx, &initial, init_val);
    JS_FreeValue(ctx, init_val);
    if (JS_IsNumber(max_val))
        JS_ToInt32(ctx, &maximum, max_val);
    JS_FreeValue(ctx, max_val);

    if (initial < 0)
        return JS_ThrowTypeError(ctx, "WebAssembly.Memory: initial page count must be non-negative");
    if (maximum >= 0 && maximum < initial)
        return JS_ThrowTypeError(ctx, "WebAssembly.Memory: maximum must be >= initial");

    QJWasmMemory *wm = js_mallocz(ctx, sizeof(QJWasmMemory));
    if (!wm)
        return JS_EXCEPTION;

    wm->local_pages = (uint32_t)initial;
    wm->local_max_pages = (maximum >= 0) ? (uint32_t)maximum : UINT32_MAX;
    wm->exported_by = JS_UNDEFINED;
    wm->cached_buffer = JS_UNDEFINED;

    if (wm->local_pages > 0)
    {
        size_t size = (size_t)wm->local_pages * WASM_PAGE_SIZE;
        wm->local_data = js_malloc(ctx, size);
        if (!wm->local_data)
        {
            js_free(ctx, wm);
            return JS_EXCEPTION;
        }
        memset(wm->local_data, 0, size);
    }

    JSValue obj = JS_NewObjectClass(ctx, js_webassembly_memory_class_id);
    if (JS_IsException(obj))
    {
        if (wm->local_data)
            js_free(ctx, wm->local_data);
        js_free(ctx, wm);
        return obj;
    }
    JS_SetOpaque(obj, wm);
    return obj;
}

static QJWasmMemory *js_wasm_memory_get_this(JSContext *ctx, JSValueConst this_val)
{
    QJWasmMemory *wm = JS_GetOpaque(this_val, js_webassembly_memory_class_id);
    if (!wm)
        JS_ThrowTypeError(ctx, "invalid WebAssembly.Memory");
    return wm;
}

static JSValue js_wasm_memory_get_buffer(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv)
{
    (void)argc;
    (void)argv;
    QJWasmMemory *wm = js_wasm_memory_get_this(ctx, this_val);
    if (!wm)
        return JS_EXCEPTION;

    if (!JS_IsUndefined(wm->cached_buffer))
        return JS_DupValue(ctx, wm->cached_buffer);

    size_t size;
    uint8_t *data;

    if (JS_IsUndefined(wm->exported_by))
    {
        size = (size_t)wm->local_pages * WASM_PAGE_SIZE;
        data = wm->local_data;
    }
    else
    {
        uint64_t cur_pages = wasm_memory_get_cur_page_count(wm->mem_inst);
        size = (uint32_t)cur_pages * WASM_PAGE_SIZE;
        data = (uint8_t *)wasm_memory_get_base_address(wm->mem_inst);
    }

    JSValue buf = JS_NewArrayBuffer(ctx, data, size, noop_buffer_free, NULL, 0);
    wm->cached_buffer = JS_DupValue(ctx, buf);
    return buf;
}

static JSValue js_wasm_memory_grow(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    QJWasmMemory *wm = js_wasm_memory_get_this(ctx, this_val);
    if (!wm)
        return JS_EXCEPTION;

    int32_t delta = 1;
    if (argc >= 1 && JS_IsNumber(argv[0]))
        JS_ToInt32(ctx, &delta, argv[0]);

    if (delta < 0)
        return JS_ThrowTypeError(ctx, "WebAssembly.Memory.grow: delta must be non-negative");

    if (!JS_IsUndefined(wm->cached_buffer))
    {
        JS_DetachArrayBuffer(ctx, wm->cached_buffer);
        JS_FreeValue(ctx, wm->cached_buffer);
        wm->cached_buffer = JS_UNDEFINED;
    }

    if (JS_IsUndefined(wm->exported_by))
    {
        uint32_t old = wm->local_pages;
        uint64_t new_pages = (uint64_t)old + delta;
        if (new_pages > wm->local_max_pages)
            return JS_ThrowTypeError(ctx, "WebAssembly.Memory.grow: failed to grow memory");

        size_t old_size = (size_t)old * WASM_PAGE_SIZE;
        size_t new_size = (size_t)new_pages * WASM_PAGE_SIZE;
        uint8_t *new_data = realloc(wm->local_data, new_size);
        if (!new_data)
            return JS_ThrowTypeError(ctx, "WebAssembly.Memory.grow: failed to allocate memory");
        memset(new_data + old_size, 0, new_size - old_size);
        wm->local_data = new_data;
        wm->local_pages = (uint32_t)new_pages;
        return JS_NewInt32(ctx, (int32_t)old);
    }
    else
    {
        uint64_t old = wasm_memory_get_cur_page_count(wm->mem_inst);
        if (!wasm_memory_enlarge(wm->mem_inst, (uint64_t)delta))
            return JS_ThrowTypeError(ctx, "WebAssembly.Memory.grow: failed to grow memory");
        return JS_NewInt64(ctx, old);
    }
}

static void js_wasm_memory_finalizer(JSRuntime *rt, JSValue val)
{
    QJWasmMemory *wm = JS_GetOpaque(val, js_webassembly_memory_class_id);
    if (wm)
    {
        if (!JS_IsUndefined(wm->cached_buffer))
            JS_FreeValueRT(rt, wm->cached_buffer);
        if (wm->local_data)
            js_free_rt(rt, wm->local_data);
        if (!JS_IsUndefined(wm->exported_by))
            JS_FreeValueRT(rt, wm->exported_by);
        js_free_rt(rt, wm);
    }
}

static void js_wasm_memory_mark(JSRuntime *rt, JSValueConst val, JS_MarkFunc *mark_func)
{
    QJWasmMemory *wm = JS_GetOpaque(val, js_webassembly_memory_class_id);
    if (wm)
    {
        if (!JS_IsUndefined(wm->cached_buffer))
            JS_MarkValue(rt, wm->cached_buffer, mark_func);
        if (!JS_IsUndefined(wm->exported_by))
            JS_MarkValue(rt, wm->exported_by, mark_func);
    }
}

// ─── Table entry cache for non-export table functions ──────────
#define MAX_TABLE_ENTRIES 16384
static struct {
    wasm_function_inst_t func;
    wasm_module_inst_t module_inst;
} table_entry_cache[MAX_TABLE_ENTRIES];
static int table_entry_count = 0;

static JSValue js_wasm_table_entry_bridge(JSContext *ctx, JSValueConst this_val,
                                           int argc, JSValueConst *argv,
                                           int magic, JSValue *func_data)
{
    (void)this_val;
    (void)func_data;
    if (magic < 0 || magic >= table_entry_count) {
        return JS_UNDEFINED;
    }
    wasm_function_inst_t func = table_entry_cache[magic].func;
    wasm_module_inst_t module_inst = table_entry_cache[magic].module_inst;
    if (!func || !module_inst)
        return JS_UNDEFINED;

    uint32_t param_count = wasm_func_get_param_count(func, module_inst);
    uint32_t result_count = wasm_func_get_result_count(func, module_inst);

    wasm_valkind_t param_types[param_count];
    wasm_func_get_param_types(func, module_inst, param_types);
    wasm_val_t wasm_args[param_count];
    for (uint32_t i = 0; i < param_count; i++) {
        wasm_args[i].kind = param_types[i];
        switch (param_types[i]) {
        case WASM_I32: { int32_t v; JS_ToInt32(ctx, &v, argv[i]); wasm_args[i].of.i32 = v; break; }
        case WASM_I64: { int64_t v; JS_ToInt64(ctx, &v, argv[i]); wasm_args[i].of.i64 = v; break; }
        case WASM_F32: { double d; JS_ToFloat64(ctx, &d, argv[i]); wasm_args[i].of.f32 = (float)d; break; }
        case WASM_F64: { double d; JS_ToFloat64(ctx, &d, argv[i]); wasm_args[i].of.f64 = d; break; }
        }
    }

    wasm_exec_env_t exec_env = wasm_runtime_create_exec_env(module_inst, 65536);

    wasm_valkind_t result_type;
    wasm_val_t results[1];
    if (result_count > 0) {
        wasm_func_get_result_types(func, module_inst, &result_type);
        results[0].kind = result_type;
    }
    bool call_result = wasm_runtime_call_wasm_a(exec_env, func, result_count,
                             result_count > 0 ? results : NULL,
                             param_count, wasm_args);
    wasm_runtime_destroy_exec_env(exec_env);

    if (!call_result) {
        const char *err = wasm_runtime_get_exception(module_inst);
        printf("[table_entry] call FAILED (magic=%d): %s\n", magic, err ? err : "unknown"); fflush(stdout);
        wasm_runtime_clear_exception(module_inst);
        return JS_UNDEFINED;
    }

    if (result_count > 0) {
        switch (result_type) {
        case WASM_I32: return JS_NewInt32(ctx, results[0].of.i32);
        case WASM_I64: return JS_NewInt64(ctx, results[0].of.i64);
        case WASM_F32: return JS_NewFloat64(ctx, results[0].of.f32);
        case WASM_F64: return JS_NewFloat64(ctx, results[0].of.f64);
        }
    }
    return JS_UNDEFINED;
}

static JSClassDef js_webassembly_memory_class_def = {
    .class_name = "Memory",
    .finalizer = js_wasm_memory_finalizer,
    .gc_mark = js_wasm_memory_mark};

// ─── WebAssembly.Table ─────────────────────────────────────

static QJWasmTable *js_wasm_table_get_this(JSContext *ctx, JSValueConst this_val)
{
    QJWasmTable *wt = JS_GetOpaque(this_val, js_webassembly_table_class_id);
    if (!wt)
        JS_ThrowTypeError(ctx, "invalid WebAssembly.Table");
    return wt;
}

static JSValue js_wasm_table_get(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    QJWasmTable *wt = js_wasm_table_get_this(ctx, this_val);
    if (!wt)
        return JS_EXCEPTION;

    if (argc < 1 || !JS_IsNumber(argv[0]))
        return JS_ThrowTypeError(ctx, "WebAssembly.Table.get: index must be a number");

    int32_t index;
    JS_ToInt32(ctx, &index, argv[0]);

    if (index < 0 || (uint32_t)index >= wt->table_inst.cur_size)
        return JS_ThrowRangeError(ctx, "WebAssembly.Table.get: index out of bounds");

    wasm_function_inst_t func = wasm_table_get_func_inst(wt->module_inst, &wt->table_inst, (uint32_t)index);
    if (!func)
        return JS_NULL;

    // For non-export table entries, cache and return a callable bridge
    if (table_entry_count >= MAX_TABLE_ENTRIES)
        return JS_ThrowTypeError(ctx, "WebAssembly.Table.get: too many table entries");

    int entry_idx = table_entry_count++;
    table_entry_cache[entry_idx].func = func;
    table_entry_cache[entry_idx].module_inst = wt->module_inst;
    return JS_NewCFunctionData(ctx, js_wasm_table_entry_bridge, 0, entry_idx, 0, NULL);
}

static JSValue js_wasm_table_get_length(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    (void)argc;
    (void)argv;
    QJWasmTable *wt = js_wasm_table_get_this(ctx, this_val);
    if (!wt)
        return JS_EXCEPTION;
    return JS_NewUint32(ctx, wt->table_inst.cur_size);
}

static void js_wasm_table_finalizer(JSRuntime *rt, JSValue val)
{
    QJWasmTable *wt = JS_GetOpaque(val, js_webassembly_table_class_id);
    if (wt)
    {
        if (!JS_IsUndefined(wt->exported_by))
            JS_FreeValueRT(rt, wt->exported_by);
        js_free_rt(rt, wt);
    }
}

static void js_wasm_table_mark(JSRuntime *rt, JSValueConst val, JS_MarkFunc *mark_func)
{
    QJWasmTable *wt = JS_GetOpaque(val, js_webassembly_table_class_id);
    if (wt && !JS_IsUndefined(wt->exported_by))
        JS_MarkValue(rt, wt->exported_by, mark_func);
}

static JSClassDef js_webassembly_table_class_def = {
    .class_name = "Table",
    .finalizer = js_wasm_table_finalizer,
    .gc_mark = js_wasm_table_mark};

// ─── WebAssembly.Instance ─────────────────────────────────────


JSValue js_call_wasm_bridge(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv, int magic, JSValue *func_data)
{
    if (!func_data) {
        return JS_UNDEFINED;
    }
    if (JS_IsException(func_data[0])) {
        return JS_UNDEFINED;
    }
    QJWasmInstance *wasm_inst = JS_GetOpaque(func_data[0], js_webassembly_instance_class_id);
    if (!wasm_inst) {
        return JS_UNDEFINED;
    }
    QJWasmModule *wasm_module = JS_GetOpaque(wasm_inst->module_obj, js_webassembly_module_class_id);
    if (!wasm_module) {
        return JS_UNDEFINED;
    }
    int export_count = wasm_runtime_get_export_count(wasm_module->module);
    if (magic < 0 || magic >= export_count) {
        return JS_UNDEFINED;
    }
    wasm_export_t exp;
    wasm_runtime_get_export_type(wasm_module->module, magic, &exp);
    const char *func_name = exp.name;
    wasm_function_inst_t func = wasm_runtime_lookup_function(wasm_inst->inst, func_name);
    if (!func) {
        printf("[bridge] lookup FAILED for export[%d] '%s'\n", magic, func_name); fflush(stdout);
        return JS_UNDEFINED;
    }
    uint32_t param_count = wasm_func_get_param_count(func, wasm_inst->inst);
    uint32_t result_count = wasm_func_get_result_count(func, wasm_inst->inst);

#ifdef DEBUG
    printf("[bridge] CALL '%s' (magic=%d, params=%u, results=%u, js_args=%d)\n",
           func_name, magic, param_count, result_count, argc); fflush(stdout);
#endif

    wasm_valkind_t param_types[param_count];
    wasm_func_get_param_types(func, wasm_inst->inst, param_types);
    wasm_val_t wasm_args[param_count];
    for (uint32_t i = 0; i < param_count; i++) {
        wasm_args[i].kind = param_types[i];
        switch (param_types[i]) {
        case WASM_I32: { int32_t v; JS_ToInt32(ctx, &v, argv[i]); wasm_args[i].of.i32 = v; DEBUG_PRINTF("  arg[%u]=i32:%d\n", i, v); break; }
        case WASM_I64: { int64_t v; JS_ToInt64(ctx, &v, argv[i]); wasm_args[i].of.i64 = v; DEBUG_PRINTF("  arg[%u]=i64:%lld\n", i, (long long)v); break; }
        case WASM_F32: { double d; JS_ToFloat64(ctx, &d, argv[i]); wasm_args[i].of.f32 = (float)d; DEBUG_PRINTF("  arg[%u]=f32:%f\n", i, (float)d); break; }
        case WASM_F64: { double d; JS_ToFloat64(ctx, &d, argv[i]); wasm_args[i].of.f64 = d; DEBUG_PRINTF("  arg[%u]=f64:%f\n", i, d); break; }
        }
    }

    wasm_exec_env_t exec_env = wasm_runtime_create_exec_env(wasm_inst->inst, 4096);

    wasm_valkind_t result_type;
    wasm_val_t results[1];
    if (result_count > 0) {
        wasm_func_get_result_types(func, wasm_inst->inst, &result_type);
        results[0].kind = result_type;
    }
    bool call_result = wasm_runtime_call_wasm_a(exec_env, func, result_count,
                             result_count > 0 ? results : NULL,
                             param_count, wasm_args);
    wasm_runtime_destroy_exec_env(exec_env);

    if (!call_result) {
        const char *err = wasm_runtime_get_exception(wasm_inst->inst);
        printf("[bridge] call FAILED for '%s' (magic=%d): %s\n",
               func_name, magic, err ? err : "unknown error"); fflush(stdout);
        wasm_runtime_clear_exception(wasm_inst->inst);
        return JS_UNDEFINED;
    }

    if (result_count > 0) {
        DEBUG_PRINTF("[bridge] RESULT '%s' = ", func_name);
        switch (result_type) {
        case WASM_I32: DEBUG_PRINTF("i32:%d", results[0].of.i32); break;
        case WASM_I64: DEBUG_PRINTF("i64:%lld", (long long)results[0].of.i64); break;
        case WASM_F32: DEBUG_PRINTF("f32:%f", results[0].of.f32); break;
        case WASM_F64: DEBUG_PRINTF("f64:%f", results[0].of.f64); break;
        }
        DEBUG_PRINTF("\n"); fflush(stdout);

        switch (result_type) {
        case WASM_I32: return JS_NewInt32(ctx, results[0].of.i32);
        case WASM_I64: return JS_NewInt64(ctx, results[0].of.i64);
        case WASM_F32: return JS_NewFloat64(ctx, results[0].of.f32);
        case WASM_F64: return JS_NewFloat64(ctx, results[0].of.f64);
        }
    }
    DEBUG_PRINTF("[bridge] RESULT '%s' = (no result)\n", func_name); fflush(stdout);
    return JS_UNDEFINED;
}
static JSValue js_wasm_instance_ctor(JSContext *ctx, JSValueConst new_target,
                                     int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "WebAssembly.Instance: missing module argument");

    JSValue module_obj = argv[0];
    QJWasmModule *wasm_module = JS_GetOpaque(module_obj, js_webassembly_module_class_id);
    if (!wasm_module)
        return JS_ThrowTypeError(ctx, "WebAssembly.Instance: first argument must be a WebAssembly.Module");

    QJWasmInstance *wasm_inst = js_malloc(ctx, sizeof(QJWasmInstance));
    if (!wasm_inst)
        return JS_ThrowTypeError(ctx, "Instance malloc failed");

    wasm_inst->module_obj = JS_DupValue(ctx, module_obj);
    JSValue import_obj = (argc >= 2 && JS_IsObject(argv[1])) ? argv[1] : JS_UNDEFINED;
    wasm_inst->ctx = ctx;
    wasm_inst->import_obj = JS_IsObject(import_obj) ? JS_DupValue(ctx, import_obj) : JS_UNDEFINED;

    // ── Link import globals before instantiate ──
    int linked_globals_idx[64];
    int linked_count = 0;

    if (JS_IsObject(import_obj)
        && wasm_runtime_get_module_package_type(wasm_module->module) == Wasm_Module_Bytecode)
    {
        /* Cast WASMModuleCommon* → WASMModule*, per WAMR's documented pattern.
           WASMModule layout depends on compile flags (WASM_ENABLE_TAGS etc.);
           must match the WAMR library's compile options. */
        WASMModule *mod = (WASMModule *)wasm_module->module;
        for (uint32 i = 0; i < mod->import_global_count; i++)
        {
            WASMGlobalImport *gi = &mod->import_globals[i].u.global;
            if (gi->is_linked)
                continue;

            JSValue modv = JS_GetPropertyStr(ctx, import_obj, gi->module_name);
            if (!JS_IsObject(modv))
            {
                JS_FreeValue(ctx, modv);
                continue;
            }
            JSValue val = JS_GetPropertyStr(ctx, modv, gi->field_name);
            JS_FreeValue(ctx, modv);
            if (JS_IsUndefined(val))
            {
                JS_FreeValue(ctx, val);
                continue;
            }

            QJWasmGlobal *wg = JS_GetOpaque(val, js_webassembly_global_class_id);
            if (!wg)
            {
                JS_FreeValue(ctx, val);
                continue;
            }

            wasm_valkind_t expected;
            switch (gi->type.val_type)
            {
            case VALUE_TYPE_I32: expected = WASM_I32; break;
            case VALUE_TYPE_I64: expected = WASM_I64; break;
            case VALUE_TYPE_F32: expected = WASM_F32; break;
            case VALUE_TYPE_F64: expected = WASM_F64; break;
            default: JS_FreeValue(ctx, val); continue;
            }
            if (wg->kind != expected)
            {
                JS_FreeValue(ctx, val);
                continue;
            }

            void *src = !JS_IsUndefined(wg->exported_by) ? wg->global_data : &wg->standalone_value;
            switch (gi->type.val_type)
            {
            case VALUE_TYPE_I32:
                gi->global_data_linked.i32 = *(int32_t *)src;
                break;
            case VALUE_TYPE_I64:
                gi->global_data_linked.i64 = *(int64_t *)src;
                break;
            case VALUE_TYPE_F32:
                gi->global_data_linked.f32 = *(float32 *)src;
                break;
            case VALUE_TYPE_F64:
                gi->global_data_linked.f64 = *(float64 *)src;
                break;
            }
            gi->is_linked = true;
            linked_globals_idx[linked_count++] = i;
            JS_FreeValue(ctx, val);
        }
    }

    char error_buf[128];
    wasm_module_inst_t inst = wasm_runtime_instantiate(wasm_module->module, 65536, 0, error_buf, sizeof(error_buf));

    if (!inst)
    {
        // reset linked globals so next instantiation can retry
        if (linked_count > 0)
        {
        /* Cast WASMModuleCommon* → WASMModule*, per WAMR's documented pattern.
           WASMModule layout depends on compile flags (WASM_ENABLE_TAGS etc.);
           must match the WAMR library's compile options. */
        WASMModule *mod = (WASMModule *)wasm_module->module;
            for (int j = 0; j < linked_count; j++)
                mod->import_globals[linked_globals_idx[j]].u.global.is_linked = false;
        }
        JS_FreeValue(ctx, wasm_inst->import_obj);
        JS_FreeValue(ctx, wasm_inst->module_obj);
        js_free(ctx, wasm_inst);
        return JS_ThrowTypeError(ctx, "WebAssembly.Instance: instantiation failed: %s", error_buf);
    }

    // reset linked globals so next instantiation can pass different values
    if (linked_count > 0)
    {
        WASMModule *mod = (WASMModule *)wasm_module->module;
        for (int j = 0; j < linked_count; j++)
            mod->import_globals[linked_globals_idx[j]].u.global.is_linked = false;
    }

    wasm_inst->inst = inst;

    wasm_runtime_set_custom_data(inst, wasm_inst);
    JSValue inst_obj = JS_NewObjectClass(ctx, js_webassembly_instance_class_id);
    JS_SetOpaque(inst_obj, wasm_inst);

    JSValue exports_obj = JS_NewObject(ctx);
    int export_count = wasm_runtime_get_export_count(wasm_module->module);

    for (int i = 0; i < export_count; i++)
    {
        wasm_export_t export;
        wasm_runtime_get_export_type(wasm_module->module, i, &export);
        if (export.kind == WASM_IMPORT_EXPORT_KIND_FUNC)
        {
            JSValue fn = JS_NewCFunctionData(ctx, js_call_wasm_bridge, 0, i, 1, (JSValueConst *)&inst_obj);
            JS_SetPropertyStr(ctx, exports_obj, export.name, fn);
        }
        else if (export.kind == WASM_IMPORT_EXPORT_KIND_GLOBAL)
        {
            wasm_global_inst_t gi;
            if (wasm_runtime_get_export_global_inst(inst, export.name, &gi))
            {
                QJWasmGlobal *wg = js_mallocz(ctx, sizeof(QJWasmGlobal));
                if (wg)
                {
                    wg->kind = gi.kind;
                    wg->is_mutable = gi.is_mutable;
                    wg->global_data = gi.global_data;
                    wg->exported_by = JS_DupValue(ctx, inst_obj);

                    JSValue g_obj = JS_NewObjectClass(ctx, js_webassembly_global_class_id);
                    if (!JS_IsException(g_obj))
                    {
                        JS_SetOpaque(g_obj, wg);
                        JS_SetPropertyStr(ctx, exports_obj, export.name, g_obj);
                    }
                    else
                    {
                        JS_FreeValue(ctx, wg->exported_by);
                        js_free(ctx, wg);
                    }
                }
            }
        }
        else if (export.kind == WASM_IMPORT_EXPORT_KIND_MEMORY)
        {
            wasm_memory_inst_t mem = wasm_runtime_lookup_memory(inst, export.name);
            if (mem)
            {
                QJWasmMemory *wm = js_mallocz(ctx, sizeof(QJWasmMemory));
                if (wm)
                {
                    wm->mem_inst = mem;
                    wm->exported_by = JS_DupValue(ctx, inst_obj);
                    wm->cached_buffer = JS_UNDEFINED;

                    JSValue m_obj = JS_NewObjectClass(ctx, js_webassembly_memory_class_id);
                    if (!JS_IsException(m_obj))
                    {
                        JS_SetOpaque(m_obj, wm);
                        JS_SetPropertyStr(ctx, exports_obj, export.name, m_obj);
                    }
                    else
                    {
                        JS_FreeValue(ctx, wm->exported_by);
                        js_free(ctx, wm);
                    }
                }
            }
        }
        else if (export.kind == WASM_IMPORT_EXPORT_KIND_TABLE)
        {
            wasm_table_inst_t ti;
            if (wasm_runtime_get_export_table_inst(inst, export.name, &ti))
            {
                QJWasmTable *wt = js_mallocz(ctx, sizeof(QJWasmTable));
                if (wt)
                {
                    wt->table_inst = ti;
                    wt->module_inst = inst;
                    wt->exported_by = JS_DupValue(ctx, inst_obj);

                    JSValue t_obj = JS_NewObjectClass(ctx, js_webassembly_table_class_id);
                    if (!JS_IsException(t_obj))
                    {
                        JS_SetOpaque(t_obj, wt);
                        JS_SetPropertyStr(ctx, exports_obj, export.name, t_obj);
                    }
                    else
                    {
                        JS_FreeValue(ctx, wt->exported_by);
                        js_free(ctx, wt);
                    }
                }
            }
        }
    }

    JS_SetPropertyStr(ctx, inst_obj, "exports", exports_obj);

    return inst_obj;
}

static void js_wasm_instance_finalizer(JSRuntime *rt, JSValue val)
{
    QJWasmInstance *inst = JS_GetOpaque(val, js_webassembly_instance_class_id);
    if (inst)
    {
        wasm_runtime_deinstantiate(inst->inst);
        JS_FreeValueRT(rt, inst->module_obj);
        JS_FreeValueRT(rt, inst->import_obj);
        js_free_rt(rt, inst);
    }
}

static void js_wasm_instance_mark(JSRuntime *rt, JSValueConst val, JS_MarkFunc *mark_func)
{
    QJWasmInstance *inst = JS_GetOpaque(val, js_webassembly_instance_class_id);
    if (!inst)
        return;
    // if (!JS_IsUndefined(inst->import_obj))
    JS_MarkValue(rt, inst->import_obj, mark_func);
    JS_MarkValue(rt, inst->module_obj, mark_func);
}

static JSClassDef js_webassembly_instance_class_def = {
    .class_name = "Instance",
    .finalizer = js_wasm_instance_finalizer,
    .gc_mark = js_wasm_instance_mark};

static int inited = 0;

JSModuleDef *js_init_module_wamr(JSContext *ctx)
{
    if (!inited)
    {
        wasm_runtime_init();
        inited = 1;
    }

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue webassembly = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, webassembly, js_webassembly_funcs, countof(js_webassembly_funcs));

    JS_NewClassID(&js_webassembly_module_class_id);
    JS_NewClass(JS_GetRuntime(ctx), js_webassembly_module_class_id, &js_webassembly_module_class_def);
    JSValue proto = JS_NewObject(ctx);
    JSValue obj = JS_NewCFunction2(ctx, js_webassembly_module_ctor, "Module", 1, JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, obj, proto);
    JS_SetClassProto(ctx, js_webassembly_module_class_id, proto);
    JS_SetPropertyStr(ctx, obj, "exports",
                      JS_NewCFunction(ctx, js_wasm_module_exports, "exports", 1));
    JS_SetPropertyStr(ctx, obj, "imports",
                      JS_NewCFunction(ctx, js_wasm_module_imports, "imports", 1));
    JS_SetPropertyStr(ctx, webassembly, "Module", obj);

    JS_NewClassID(&js_webassembly_instance_class_id);
    JS_NewClass(JS_GetRuntime(ctx), js_webassembly_instance_class_id, &js_webassembly_instance_class_def);
    JSValue inst_proto = JS_NewObject(ctx);
    JSValue inst_ctor = JS_NewCFunction2(ctx, js_wasm_instance_ctor, "Instance", 1, JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, inst_ctor, inst_proto);
    JS_SetClassProto(ctx, js_webassembly_instance_class_id, inst_proto);
    JS_SetPropertyStr(ctx, webassembly, "Instance", inst_ctor);

    JS_NewClassID(&js_webassembly_global_class_id);
    JS_NewClass(JS_GetRuntime(ctx), js_webassembly_global_class_id, &js_webassembly_global_class_def);
    JSValue global_proto = JS_NewObject(ctx);
    JSValue global_ctor = JS_NewCFunction2(ctx, js_wasm_global_ctor, "Global", 1, JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, global_ctor, global_proto);
    JS_SetClassProto(ctx, js_webassembly_global_class_id, global_proto);
    JSAtom value_atom = JS_NewAtom(ctx, "value");
    JSValue gv_getter = JS_NewCFunction(ctx, js_wasm_global_get_value, "get value", 0);
    JSValue gv_setter = JS_NewCFunction(ctx, js_wasm_global_set_value, "set value", 1);
    JS_DefineProperty(ctx, global_proto, value_atom, JS_UNDEFINED,
                      gv_getter, gv_setter,
                      JS_PROP_C_W_E | JS_PROP_HAS_GET | JS_PROP_HAS_SET);
    JS_FreeValue(ctx, gv_getter);
    JS_FreeValue(ctx, gv_setter);
    JS_FreeAtom(ctx, value_atom);
    JS_SetPropertyStr(ctx, global_proto, "valueOf",
                      JS_NewCFunction(ctx, js_wasm_global_value_of, "valueOf", 0));
    JS_SetPropertyStr(ctx, webassembly, "Global", global_ctor);

    JS_NewClassID(&js_webassembly_memory_class_id);
    JS_NewClass(JS_GetRuntime(ctx), js_webassembly_memory_class_id, &js_webassembly_memory_class_def);
    JSValue mem_proto = JS_NewObject(ctx);
    JSValue mem_ctor = JS_NewCFunction2(ctx, js_wasm_memory_ctor, "Memory", 1, JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, mem_ctor, mem_proto);
    JS_SetClassProto(ctx, js_webassembly_memory_class_id, mem_proto);
    JSAtom buffer_atom = JS_NewAtom(ctx, "buffer");
    JSValue buf_getter = JS_NewCFunction(ctx, js_wasm_memory_get_buffer, "get buffer", 0);
    JS_DefineProperty(ctx, mem_proto, buffer_atom, JS_UNDEFINED,
                      buf_getter, JS_UNDEFINED,
                      JS_PROP_C_W_E | JS_PROP_HAS_GET);
    JS_FreeValue(ctx, buf_getter);
    JS_FreeAtom(ctx, buffer_atom);
    JS_SetPropertyStr(ctx, mem_proto, "grow",
                      JS_NewCFunction(ctx, js_wasm_memory_grow, "grow", 1));
    JS_SetPropertyStr(ctx, webassembly, "Memory", mem_ctor);

    JS_NewClassID(&js_webassembly_table_class_id);
    JS_NewClass(JS_GetRuntime(ctx), js_webassembly_table_class_id, &js_webassembly_table_class_def);
    JSValue table_proto = JS_NewObject(ctx);
    JS_SetClassProto(ctx, js_webassembly_table_class_id, table_proto);
    JSAtom length_atom = JS_NewAtom(ctx, "length");
    JSValue length_getter = JS_NewCFunction(ctx, js_wasm_table_get_length, "get length", 0);
    JS_DefineProperty(ctx, table_proto, length_atom, JS_UNDEFINED,
                      length_getter, JS_UNDEFINED,
                      JS_PROP_C_W_E | JS_PROP_HAS_GET);
    JS_FreeValue(ctx, length_getter);
    JS_FreeAtom(ctx, length_atom);
    JS_SetPropertyStr(ctx, table_proto, "get",
                      JS_NewCFunction(ctx, js_wasm_table_get, "get", 1));
    JS_SetPropertyStr(ctx, webassembly, "Table", JS_NewObject(ctx));

    JS_SetPropertyStr(ctx, global, "WebAssembly", webassembly);
    JS_FreeValue(ctx, global);
    return NULL;
}

void js_wamr_cleanup(JSRuntime *rt)
{
}
