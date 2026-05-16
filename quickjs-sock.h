#ifndef QUICKJS_SOCK_H
#define QUICKJS_SOCK_H

#include "quickjs.h"
#include "list.h"
#include <winsock2.h>

typedef struct SockHandle {
    struct list_head link;
    int fd;
    WSAEVENT event;
    
    JSValue on_event;
    JSContext *js_ctx;
} SockHandle;

JSModuleDef *js_init_module_sock(JSContext *ctx);

struct list_head *js_get_sock_handles(JSContext *ctx);
void sock_free_handles(JSRuntime *rt, struct list_head *handles);

void sock_handle_events(SockHandle *sock, WSANETWORKEVENTS *events);

#endif
