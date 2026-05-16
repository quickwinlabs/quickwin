#ifndef QUICKJS_HTTP_H
#define QUICKJS_HTTP_H

#include "quickjs.h"

char* http_get_sync(const char* url);

void js_init_http_cache_api(JSContext *ctx);

char* js_module_normalize_name(JSContext *ctx,
                               const char *base_name,
                               const char *name, void *opaque);

#endif
