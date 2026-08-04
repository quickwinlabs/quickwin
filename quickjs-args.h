#ifndef QUICKJS_ARGS_H
#define QUICKJS_ARGS_H

#include "quickjs.h"

#define GET_INT32(ctx, v, name)  \
    int32_t name;                \
    JS_ToInt32(ctx, &name, v)

#define GET_INT32_OPT(ctx, v, name, fallback) \
    int32_t name = (fallback);               \
    if (JS_IsNumber(v)) JS_ToInt32(ctx, &name, v)

#define GET_INT64_OPT(ctx, v, name, fallback) \
    int64_t name = (fallback);               \
    if (JS_IsNumber(v)) JS_ToInt64(ctx, &name, v)

#endif