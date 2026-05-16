#ifndef QUICKJS_WAMR_H
#define QUICKJS_WAMR_H

#include <quickjs.h>

JSModuleDef *js_init_module_wamr(JSContext *ctx);
void js_wamr_cleanup(JSRuntime *rt);

#endif