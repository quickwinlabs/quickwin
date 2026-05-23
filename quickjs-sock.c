#include <winsock2.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"
#include "quickjs-sock.h"
#include "quickjs/list.h"
#include "quickjs/cutils.h"

#ifndef countof
#define countof(x) (sizeof(x) / sizeof((x)[0]))
#endif

#define MAX_SOCK_RUNTIMES 4

/* ─── Internal types ────────────────────────────────────────── */

typedef struct SockHandle {
    struct list_head link;
    int fd;
    WSAEVENT event;
    JSValue on_event;
    JSContext *js_ctx;
} SockHandle;

typedef struct {
    JSRuntime *rt;
    struct list_head socket_handlers;
    int slot_count;
} SockRuntime;

/* ─── Global state ──────────────────────────────────────────── */

static SockRuntime g_sock_runtimes[MAX_SOCK_RUNTIMES];
static int g_nsock_runtimes;

static SockRuntime *find_runtime(JSRuntime *rt)
{
    for (int i = 0; i < g_nsock_runtimes; i++) {
        if (g_sock_runtimes[i].rt == rt)
            return &g_sock_runtimes[i];
    }
    return NULL;
}

/* ─── API: event-loop integration ───────────────────────────── */

void js_sock_init(JSRuntime *rt)
{
    if (g_nsock_runtimes >= MAX_SOCK_RUNTIMES)
        return;
    SockRuntime *r = &g_sock_runtimes[g_nsock_runtimes++];
    r->rt = rt;
    init_list_head(&r->socket_handlers);
    r->slot_count = 0;
}

int js_sock_slot_count(JSRuntime *rt)
{
    SockRuntime *r = find_runtime(rt);
    return r ? r->slot_count : 0;
}

void js_sock_collect_handles(JSRuntime *rt, HANDLE *handles, int max, int *count)
{
    SockRuntime *r = find_runtime(rt);
    if (!r) return;
    struct list_head *el;
    list_for_each(el, &r->socket_handlers) {
        SockHandle *sock = list_entry(el, SockHandle, link);
        if (sock->event != WSA_INVALID_EVENT && *count < max) {
            handles[*count] = (HANDLE)sock->event;
            (*count)++;
        }
    }
}

int js_sock_handle_event(JSRuntime *rt, HANDLE triggered)
{
    SockRuntime *r = find_runtime(rt);
    if (!r) return 0;
    struct list_head *el;
    list_for_each(el, &r->socket_handlers) {
        SockHandle *sock = list_entry(el, SockHandle, link);
        if ((HANDLE)sock->event == triggered) {
            WSANETWORKEVENTS events;
            memset(&events, 0, sizeof(events));
            if (WSAEnumNetworkEvents(sock->fd, sock->event, &events) != SOCKET_ERROR) {
                if (!JS_IsUndefined(sock->on_event)) {
                    JSContext *ctx = sock->js_ctx;
                    JSValue callback = JS_DupValue(ctx, sock->on_event);
                    JSValue event_obj = JS_NewObject(ctx);
                    JS_SetPropertyStr(ctx, event_obj, "lNetworkEvents", JS_NewInt32(ctx, events.lNetworkEvents));
                    JSValue error_codes = JS_NewArray(ctx);
                    for (int i = 0; i < FD_MAX_EVENTS; i++) {
                        JS_SetPropertyUint32(ctx, error_codes, i, JS_NewInt32(ctx, events.iErrorCode[i]));
                    }
                    JS_SetPropertyStr(ctx, event_obj, "iErrorCode", error_codes);
                    JSValue args[1] = { event_obj };
                    if (JS_IsFunction(ctx, callback)) {
                        JSValue ret = JS_Call(ctx, callback, JS_UNDEFINED, 1, args);
                        if (JS_IsException(ret)) {
                            JSValue exc = JS_GetException(ctx);
                            JS_FreeValue(ctx, exc);
                        }
                        JS_FreeValue(ctx, ret);
                    }
                    JS_FreeValue(ctx, callback);
                    JS_FreeValue(ctx, event_obj);
                }
            }
            return 1;
        }
    }
    return 0;
}

void js_sock_free_handles(JSRuntime *rt)
{
    SockRuntime *r = find_runtime(rt);
    if (!r) return;
    struct list_head *el, *el1;
    list_for_each_safe(el, el1, &r->socket_handlers) {
        SockHandle *sock = list_entry(el, SockHandle, link);
        list_del(&sock->link);
        if (!JS_IsUndefined(sock->on_event))
            JS_FreeValueRT(rt, sock->on_event);
        if (sock->event != WSA_INVALID_EVENT)
            WSACloseEvent(sock->event);
        if (sock->fd >= 0)
            closesocket(sock->fd);
        free(sock);
    }
    r->slot_count = 0;
}

/* ─── Internal helpers ──────────────────────────────────────── */

static struct list_head *get_list_head(JSContext *ctx)
{
    SockRuntime *r = find_runtime(JS_GetRuntime(ctx));
    return r ? &r->socket_handlers : NULL;
}

static SockHandle *get_sock(JSContext *ctx, JSValueConst val)
{
    int64_t idx;
    if (JS_ToInt64(ctx, &idx, val))
        return NULL;
    return (SockHandle *)(size_t)idx;
}

/* ─── JS API functions ──────────────────────────────────────── */

static JSValue js_socket(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int af = AF_INET;
    int type = SOCK_STREAM;
    int protocol = 0;

    if (argc > 0) JS_ToInt32(ctx, &af, argv[0]);
    if (argc > 1) JS_ToInt32(ctx, &type, argv[1]);
    if (argc > 2) JS_ToInt32(ctx, &protocol, argv[2]);

    SOCKET fd = socket(af, type, protocol);
    if (fd == INVALID_SOCKET) {
        return JS_NewInt32(ctx, -1);
    }

    u_long mode = 1;
    ioctlsocket(fd, FIONBIO, &mode);

    WSAEVENT event = WSACreateEvent();
    if (event == WSA_INVALID_EVENT) {
        closesocket(fd);
        return JS_NewInt32(ctx, -1);
    }

    int select_ret = WSAEventSelect(fd, event, FD_READ | FD_WRITE | FD_CONNECT | FD_CLOSE);
    if (select_ret == SOCKET_ERROR) {
        WSACloseEvent(event);
        closesocket(fd);
        return JS_NewInt32(ctx, -1);
    }

    SockHandle *sock = malloc(sizeof(SockHandle));
    if (!sock) {
        WSACloseEvent(event);
        closesocket(fd);
        return JS_NewInt32(ctx, -1);
    }

    memset(sock, 0, sizeof(SockHandle));
    sock->fd = (int)fd;
    sock->event = event;
    sock->on_event = JS_UNDEFINED;
    sock->js_ctx = ctx;

    struct list_head *head = get_list_head(ctx);
    if (!head) {
        WSACloseEvent(event);
        free(sock);
        closesocket(fd);
        return JS_NewInt32(ctx, -1);
    }

    list_add_tail(&sock->link, head);

    SockRuntime *r = find_runtime(JS_GetRuntime(ctx));
    if (r) r->slot_count++;

    return JS_NewInt64(ctx, (int64_t)(size_t)sock);
}

static JSValue js_connect(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    SockHandle *sock = get_sock(ctx, argv[0]);
    if (!sock)
        return JS_ThrowTypeError(ctx, "Invalid sock handle");

    const char *host = JS_ToCString(ctx, argv[1]);
    if (!host)
        return JS_ThrowTypeError(ctx, "host required");

    int port;
    if (JS_ToInt32(ctx, &port, argv[2])) {
        JS_FreeCString(ctx, host);
        return JS_ThrowTypeError(ctx, "port required");
    }

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    addr.sin_addr.s_addr = inet_addr(host);

    if (addr.sin_addr.s_addr == INADDR_NONE) {
        JS_FreeCString(ctx, host);
        return JS_NewInt32(ctx, -1);
    }

    JS_FreeCString(ctx, host);

    int ret = connect(sock->fd, (struct sockaddr*)&addr, sizeof(addr));

    if (ret == 0) {
        return JS_NewInt32(ctx, 0);
    }

    int err = WSAGetLastError();
    if (err == WSAEWOULDBLOCK) {
        return JS_NewInt32(ctx, 0);
    }

    return JS_NewInt32(ctx, -1);
}

static JSValue js_send(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    SockHandle *sock = get_sock(ctx, argv[0]);
    if (!sock || sock->fd < 0)
        return JS_ThrowTypeError(ctx, "Invalid sock handle");

    size_t size;
    uint8_t *buf = JS_GetArrayBuffer(ctx, &size, argv[1]);
    if (!buf)
        return JS_ThrowTypeError(ctx, "data must be ArrayBuffer");

    int flags = 0;
    if (argc > 2) JS_ToInt32(ctx, &flags, argv[2]);

    int ret = send(sock->fd, (const char*)buf, (int)size, flags);
    return JS_NewInt32(ctx, ret);
}

static JSValue js_recv(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    SockHandle *sock = get_sock(ctx, argv[0]);
    if (!sock || sock->fd < 0)
        return JS_ThrowTypeError(ctx, "Invalid sock handle");

    int size = 4096;
    if (argc > 1) JS_ToInt32(ctx, &size, argv[1]);

    uint8_t *buf = malloc(size);
    if (!buf)
        return JS_ThrowTypeError(ctx, "Out of memory");

    int flags = 0;
    if (argc > 2) JS_ToInt32(ctx, &flags, argv[2]);

    int ret = recv(sock->fd, (char*)buf, size, flags);
    if (ret <= 0) {
        free(buf);
        return JS_NewInt32(ctx, ret);
    }

    JSValue arr = JS_NewArrayBufferCopy(ctx, buf, ret);
    free(buf);

    return arr;
}

static JSValue js_closesocket(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    SockHandle *sock = get_sock(ctx, argv[0]);
    if (!sock || sock->fd < 0)
        return JS_UNDEFINED;

    if (sock->fd >= 0) {
        WSAEventSelect(sock->fd, sock->event, 0);
        closesocket(sock->fd);
        sock->fd = -1;
    }

    if (sock->event != WSA_INVALID_EVENT) {
        WSACloseEvent(sock->event);
        sock->event = WSA_INVALID_EVENT;
    }

    if (!JS_IsUndefined(sock->on_event)) {
        JS_FreeValue(ctx, sock->on_event);
        sock->on_event = JS_UNDEFINED;
    }

    list_del(&sock->link);

    SockRuntime *r = find_runtime(JS_GetRuntime(ctx));
    if (r && r->slot_count > 0) r->slot_count--;

    free(sock);

    return JS_UNDEFINED;
}

static JSValue js_shutdown(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    SockHandle *sock = get_sock(ctx, argv[0]);
    if (!sock || sock->fd < 0)
        return JS_NewInt32(ctx, -1);

    int how = SD_BOTH;
    if (argc > 1) JS_ToInt32(ctx, &how, argv[1]);

    int ret = shutdown(sock->fd, how);
    return JS_NewInt32(ctx, ret);
}

static JSValue js_set_on_event(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    SockHandle *sock = get_sock(ctx, argv[0]);
    if (!sock)
        return JS_ThrowTypeError(ctx, "Invalid sock handle");

    if (!JS_IsUndefined(sock->on_event))
        JS_FreeValue(ctx, sock->on_event);

    sock->on_event = JS_DupValue(ctx, argv[1]);

    return JS_UNDEFINED;
}

static JSValue js_get_fd(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    SockHandle *sock = get_sock(ctx, argv[0]);
    if (!sock)
        return JS_ThrowTypeError(ctx, "Invalid sock handle");

    return JS_NewInt32(ctx, sock->fd);
}

static JSValue js_resolve(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *hostname = JS_ToCString(ctx, argv[0]);
    if (!hostname)
        return JS_NULL;

    struct hostent *he = gethostbyname(hostname);
    JS_FreeCString(ctx, hostname);

    if (!he)
        return JS_NULL;

    char *ip = inet_ntoa(*(struct in_addr*)he->h_addr_list[0]);
    if (!ip)
        return JS_NULL;

    return JS_NewString(ctx, ip);
}

/* ─── Module exports ────────────────────────────────────────── */

static const JSCFunctionListEntry sock_funcs[] = {
    JS_CFUNC_DEF("socket", 3, js_socket),
    JS_CFUNC_DEF("connect", 3, js_connect),
    JS_CFUNC_DEF("send", 3, js_send),
    JS_CFUNC_DEF("recv", 3, js_recv),
    JS_CFUNC_DEF("shutdown", 2, js_shutdown),
    JS_CFUNC_DEF("closesocket", 1, js_closesocket),
    JS_CFUNC_DEF("set_on_event", 2, js_set_on_event),
    JS_CFUNC_DEF("get_fd", 1, js_get_fd),
    JS_CFUNC_DEF("resolve", 1, js_resolve),

    JS_PROP_INT32_DEF("AF_INET", AF_INET, JS_PROP_CONFIGURABLE),
    JS_PROP_INT32_DEF("SOCK_STREAM", SOCK_STREAM, JS_PROP_CONFIGURABLE),
    JS_PROP_INT32_DEF("SOCK_DGRAM", SOCK_DGRAM, JS_PROP_CONFIGURABLE),
    JS_PROP_INT32_DEF("IPPROTO_TCP", IPPROTO_TCP, JS_PROP_CONFIGURABLE),
    JS_PROP_INT32_DEF("IPPROTO_UDP", IPPROTO_UDP, JS_PROP_CONFIGURABLE),

    JS_PROP_INT32_DEF("SD_RECEIVE", SD_RECEIVE, JS_PROP_CONFIGURABLE),
    JS_PROP_INT32_DEF("SD_SEND", SD_SEND, JS_PROP_CONFIGURABLE),
    JS_PROP_INT32_DEF("SD_BOTH", SD_BOTH, JS_PROP_CONFIGURABLE),

    JS_PROP_INT32_DEF("FD_READ", FD_READ, JS_PROP_CONFIGURABLE),
    JS_PROP_INT32_DEF("FD_WRITE", FD_WRITE, JS_PROP_CONFIGURABLE),
    JS_PROP_INT32_DEF("FD_CONNECT", FD_CONNECT, JS_PROP_CONFIGURABLE),
    JS_PROP_INT32_DEF("FD_CLOSE", FD_CLOSE, JS_PROP_CONFIGURABLE),
};

static int sock_init(JSContext *ctx, JSModuleDef *m)
{
    return JS_SetModuleExportList(ctx, m, sock_funcs, countof(sock_funcs));
}

JSModuleDef *js_init_module_sock(JSContext *ctx)
{
    JSModuleDef *m = JS_NewCModule(ctx, "sock", sock_init);
    if (!m)
        return NULL;
    JS_AddModuleExportList(ctx, m, sock_funcs, countof(sock_funcs));
    return m;
}
