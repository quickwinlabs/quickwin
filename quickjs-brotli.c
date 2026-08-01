#include <string.h>
#include <stdlib.h>

#include "quickjs.h"
#include "quickjs-brotli.h"
#include <brotli/decode.h>

int JS_BrotliDecompress(const uint8_t *src, size_t src_len,
                        uint8_t **out, size_t *out_len) {
    BrotliDecoderState *state = BrotliDecoderCreateInstance(NULL, NULL, NULL);
    if (!state) return -1;

    size_t available_in = src_len;
    const uint8_t *next_in = src;
    size_t buf_cap = src_len * 2 + 1024;
    uint8_t *buf = malloc(buf_cap);
    if (!buf) {
        BrotliDecoderDestroyInstance(state);
        return -1;
    }
    size_t total_out = 0;

    BrotliDecoderResult result;
    do {
        size_t available_out = buf_cap - total_out;
        uint8_t *next_out = buf + total_out;
        result = BrotliDecoderDecompressStream(state, &available_in, &next_in,
                                               &available_out, &next_out, &total_out);
        if (result == BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT) {
            buf_cap *= 2;
            uint8_t *new_buf = realloc(buf, buf_cap);
            if (!new_buf) {
                free(buf);
                BrotliDecoderDestroyInstance(state);
                return -1;
            }
            buf = new_buf;
        }
    } while (result == BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT);

    BrotliDecoderDestroyInstance(state);

    if (result != BROTLI_DECODER_RESULT_SUCCESS) {
        free(buf);
        return -1;
    }

    *out = buf;
    *out_len = total_out;
    return 0;
}

static JSValue js_brotli_decompress(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv) {
    size_t src_len;
    uint8_t *src = JS_GetArrayBuffer(ctx, &src_len, argv[0]);
    if (!src) {
        return JS_ThrowTypeError(ctx, "expected ArrayBuffer");
    }

    uint8_t *out;
    size_t out_len;
    if (JS_BrotliDecompress(src, src_len, &out, &out_len) != 0) {
        return JS_ThrowTypeError(ctx, "brotli decompression failed");
    }

    JSValue js_r = JS_NewArrayBufferCopy(ctx, out, out_len);
    free(out);
    return js_r;
}

static const JSCFunctionListEntry brotli_funcs[] = {
    JS_CFUNC_DEF("decompress", 1, js_brotli_decompress),
};

static int js_brotli_init(JSContext *ctx, JSModuleDef *m)
{
    JS_SetModuleExportList(ctx, m, brotli_funcs, sizeof(brotli_funcs) / sizeof(brotli_funcs[0]));
    return 0;
}

JSModuleDef *js_init_module_brotli(JSContext *ctx)
{
    JSModuleDef *m = JS_NewCModule(ctx, "brotli", js_brotli_init);
    if (!m)
        return NULL;
    JS_AddModuleExportList(ctx, m, brotli_funcs, sizeof(brotli_funcs) / sizeof(brotli_funcs[0]));
    return m;
}
