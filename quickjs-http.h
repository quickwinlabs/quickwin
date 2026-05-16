#ifndef QUICKJS_HTTP_H
#define QUICKJS_HTTP_H

#include "quickjs.h"

char* http_get_sync(const char* url);

char* js_module_normalize_name(JSContext *ctx,
                               const char *base_name,
                               const char *name, void *opaque);

#endif
