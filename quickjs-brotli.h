#ifndef QUICKJS_BROTLI_H
#define QUICKJS_BROTLI_H

#include "quickjs.h"

JSModuleDef *js_init_module_brotli(JSContext *ctx);

int JS_BrotliDecompress(const uint8_t *src, size_t src_len,
                        uint8_t **out, size_t *out_len);

#endif
