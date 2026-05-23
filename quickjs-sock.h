#ifndef QUICKJS_SOCK_H
#define QUICKJS_SOCK_H

#include "quickjs.h"
#include <windows.h>

JSModuleDef *js_init_module_sock(JSContext *ctx);

/* event-loop integration (async-task pattern) */
void js_sock_init(JSRuntime *rt);
int  js_sock_slot_count(JSRuntime *rt);
void js_sock_collect_handles(JSRuntime *rt, HANDLE *handles, int max, int *count);
int  js_sock_handle_event(JSRuntime *rt, HANDLE triggered);
void js_sock_free_handles(JSRuntime *rt);

#endif
