#include <string.h>
#include <stdlib.h>

#include "quickjs.h"
#include "quickjs-zstd.h"
#include <zstd.h>

static JSValue js_zstd_compress(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    size_t src_len;
    void *src = NULL;
    uint8_t *ab_src = NULL;
    const char *str_src = NULL;

    if (JS_IsString(argv[0])) {
        str_src = JS_ToCString(ctx, argv[0]);
        if (!str_src) return JS_EXCEPTION;
        src = (void *)str_src;
        src_len = strlen(str_src);
    } else {
        ab_src = JS_GetArrayBuffer(ctx, &src_len, argv[0]);
        if (!ab_src) {
            return JS_ThrowTypeError(ctx, "expected ArrayBuffer or string");
        }
        src = ab_src;
    }

    int level = 0;
    if (argc > 1 && !JS_IsUndefined(argv[1])) {
        JS_ToInt32(ctx, &level, argv[1]);
    }

    size_t dst_cap = ZSTD_compressBound(src_len);
    void *dst = malloc(dst_cap);
    if (!dst) {
        if (str_src) JS_FreeCString(ctx, str_src);
        return JS_ThrowOutOfMemory(ctx);
    }

    size_t result = ZSTD_compress(dst, dst_cap, src, src_len, level);
    if (ZSTD_isError(result)) {
        free(dst);
        if (str_src) JS_FreeCString(ctx, str_src);
        return JS_ThrowTypeError(ctx, ZSTD_getErrorName(result));
    }

    JSValue js_r = JS_NewArrayBufferCopy(ctx, dst, result);
    free(dst);
    if (str_src) JS_FreeCString(ctx, str_src);
    return js_r;
}

static JSValue js_zstd_decompress(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    size_t src_len;
    uint8_t *src = JS_GetArrayBuffer(ctx, &src_len, argv[0]);
    if (!src) {
        return JS_ThrowTypeError(ctx, "expected ArrayBuffer");
    }

    size_t dst_cap = ZSTD_getFrameContentSize(src, src_len);
    if (dst_cap == ZSTD_CONTENTSIZE_ERROR || dst_cap == ZSTD_CONTENTSIZE_UNKNOWN) {
        dst_cap = src_len * 4;
    }

    void *dst = malloc(dst_cap);
    if (!dst) return JS_ThrowOutOfMemory(ctx);

    size_t result = ZSTD_decompress(dst, dst_cap, src, src_len);
    if (ZSTD_isError(result)) {
        free(dst);
        return JS_ThrowTypeError(ctx, ZSTD_getErrorName(result));
    }

    JSValue js_r = JS_NewArrayBufferCopy(ctx, dst, result);
    free(dst);
    return js_r;
}

static const JSCFunctionListEntry zstd_funcs[] = {
    JS_CFUNC_DEF("compress", 2, js_zstd_compress),
    JS_CFUNC_DEF("decompress", 1, js_zstd_decompress),
};

static int js_zstd_init(JSContext *ctx, JSModuleDef *m)
{
    JS_SetModuleExportList(ctx, m, zstd_funcs, sizeof(zstd_funcs) / sizeof(zstd_funcs[0]));
    return 0;
}

JSModuleDef *js_init_module_zstd(JSContext *ctx)
{
    JSModuleDef *m = JS_NewCModule(ctx, "zstd", js_zstd_init);
    if (!m)
        return NULL;
    JS_AddModuleExportList(ctx, m, zstd_funcs, sizeof(zstd_funcs) / sizeof(zstd_funcs[0]));
    return m;
}
