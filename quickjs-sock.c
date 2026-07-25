#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"
#include "quickjs-sock.h"
#include "quickjs/cutils.h"

#ifndef countof
#define countof(x) (sizeof(x) / sizeof((x)[0]))
#endif

#define INIT_SLOTS_CAP 16

/* ─── Internal types ────────────────────────────────────────── */

typedef struct SockHandle {
    int fd;            /* -1 if slot is free */
    WSAEVENT event;
    JSValue on_event;
    JSContext *js_ctx;
} SockHandle;

typedef struct {
    JSRuntime *rt;
    SockHandle *slots;
    int slot_count;
    int slots_capacity;
} SockRuntime;

/* ─── Global state ──────────────────────────────────────────── */

static SockRuntime *g_sock_runtimes = NULL;
static int g_nsock_runtimes = 0;
static int g_runtimes_capacity = 0;

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
    if (g_nsock_runtimes >= g_runtimes_capacity) {
        int newCap = g_runtimes_capacity ? g_runtimes_capacity * 2 : 4;
        SockRuntime *p = realloc(g_sock_runtimes, newCap * sizeof(SockRuntime));
        if (!p) return;
        g_sock_runtimes = p;
        g_runtimes_capacity = newCap;
    }

    SockRuntime *r = &g_sock_runtimes[g_nsock_runtimes];
    r->rt = rt;
    r->slot_count = 0;
    r->slots_capacity = INIT_SLOTS_CAP;
    r->slots = malloc(r->slots_capacity * sizeof(SockHandle));
    if (!r->slots) {
        r->slots_capacity = 0;
        return;
    }
    g_nsock_runtimes++;
    for (int i = 0; i < r->slots_capacity; i++)
        r->slots[i].fd = -1;
}

void js_sock_remove_runtime(JSRuntime *rt)
{
    SockRuntime *r = find_runtime(rt);
    if (!r) return;
    free(r->slots);
    int idx = r - g_sock_runtimes;
    g_nsock_runtimes--;
    if (idx < g_nsock_runtimes)
        g_sock_runtimes[idx] = g_sock_runtimes[g_nsock_runtimes];
}

void js_sock_cleanup(void)
{
    free(g_sock_runtimes);
    g_sock_runtimes = NULL;
    g_nsock_runtimes = 0;
    g_runtimes_capacity = 0;
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
    for (int i = 0; i < r->slots_capacity; i++) {
        SockHandle *s = &r->slots[i];
        if (s->fd >= 0 && *count < max) {
            handles[*count] = (HANDLE)s->event;
            (*count)++;
        }
    }
}

int js_sock_handle_event(JSRuntime *rt, HANDLE triggered)
{
    SockRuntime *r = find_runtime(rt);
    if (!r) return 0;
    for (int i = 0; i < r->slots_capacity; i++) {
        SockHandle *s = &r->slots[i];
        if (s->fd < 0) continue;
        if ((HANDLE)s->event == triggered) {
            WSANETWORKEVENTS events;
            memset(&events, 0, sizeof(events));
            if (WSAEnumNetworkEvents(s->fd, s->event, &events) != SOCKET_ERROR) {
                if (!JS_IsUndefined(s->on_event)) {
                    JSContext *ctx = s->js_ctx;
                    JSValue callback = JS_DupValue(ctx, s->on_event);
                    JSValue event_obj = JS_NewObject(ctx);
                    JS_SetPropertyStr(ctx, event_obj, "lNetworkEvents", JS_NewInt32(ctx, events.lNetworkEvents));
                    JSValue error_codes = JS_NewArray(ctx);
                    for (int j = 0; j < FD_MAX_EVENTS; j++) {
                        JS_SetPropertyUint32(ctx, error_codes, j, JS_NewInt32(ctx, events.iErrorCode[j]));
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
            } else {
                /* WSAEnumNetworkEvents failed: socket is dead but event stays
                   signaled.  Clean up the slot so MsgWaitForMultipleObjects
                   stops returning immediately (would cause a tight CPU loop). */
                WSAEventSelect(s->fd, s->event, 0);
                closesocket(s->fd);
                s->fd = -1;
                if (s->event != WSA_INVALID_EVENT) {
                    WSAResetEvent(s->event);
                    WSACloseEvent(s->event);
                    s->event = WSA_INVALID_EVENT;
                }
                if (!JS_IsUndefined(s->on_event)) {
                    JS_FreeValueRT(rt, s->on_event);
                    s->on_event = JS_UNDEFINED;
                }
                r->slot_count--;
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
    for (int i = 0; i < r->slots_capacity; i++) {
        SockHandle *s = &r->slots[i];
        if (s->fd < 0) continue;
        if (!JS_IsUndefined(s->on_event))
            JS_FreeValueRT(rt, s->on_event);
        if (s->event != WSA_INVALID_EVENT)
            WSACloseEvent(s->event);
        if (s->fd >= 0)
            closesocket(s->fd);
        s->fd = -1;
    }
    r->slot_count = 0;
}

/* ─── Internal helpers ──────────────────────────────────────── */

static SockHandle *get_sock(JSContext *ctx, JSValueConst val)
{
    int idx;
    if (JS_ToInt32(ctx, &idx, val))
        return NULL;
    SockRuntime *r = find_runtime(JS_GetRuntime(ctx));
    if (!r || idx < 0 || idx >= r->slots_capacity || r->slots[idx].fd < 0)
        return NULL;
    return &r->slots[idx];
}

static int find_free_slot(SockRuntime *r)
{
    for (int i = 0; i < r->slots_capacity; i++) {
        if (r->slots[i].fd < 0)
            return i;
    }
    return -1;
}

static SockHandle *make_slot(SockRuntime *r, JSRuntime *rt)
{
    int idx = find_free_slot(r);
    if (idx >= 0)
        return &r->slots[idx];

    int newCap = r->slots_capacity ? r->slots_capacity * 2 : INIT_SLOTS_CAP;
    SockHandle *p = realloc(r->slots, newCap * sizeof(SockHandle));
    if (!p) return NULL;
    r->slots = p;
    for (int i = r->slots_capacity; i < newCap; i++)
        r->slots[i].fd = -1;
    idx = r->slots_capacity;
    r->slots_capacity = newCap;
    return &r->slots[idx];
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
    if (fd == INVALID_SOCKET)
        return JS_NewInt32(ctx, -1);

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

    SockRuntime *r = find_runtime(JS_GetRuntime(ctx));
    if (!r) {
        WSACloseEvent(event);
        closesocket(fd);
        return JS_NewInt32(ctx, -1);
    }

    SockHandle *sock = make_slot(r, JS_GetRuntime(ctx));
    if (!sock) {
        WSACloseEvent(event);
        closesocket(fd);
        return JS_NewInt32(ctx, -1);
    }

    sock->fd = (int)fd;
    sock->event = event;
    sock->on_event = JS_UNDEFINED;
    sock->js_ctx = ctx;
    r->slot_count++;

    return JS_NewInt32(ctx, sock - r->slots);
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

    int is_ipv6 = (strchr(host, ':') != NULL);
    SOCKET fd = sock->fd;
    int ret;

    if (is_ipv6) {
        struct sockaddr_in6 addr;
        memset(&addr, 0, sizeof(addr));
        addr.sin6_family = AF_INET6;
        addr.sin6_port = htons(port);
        if (inet_pton(AF_INET6, host, &addr.sin6_addr) != 1) {
            JS_FreeCString(ctx, host);
            return JS_NewInt32(ctx, -1);
        }
        JS_FreeCString(ctx, host);

        /* Need an AF_INET6 socket — recreate if necessary */
        if (fd != INVALID_SOCKET) {
            (void)closesocket(fd);
            fd = socket(AF_INET6, SOCK_STREAM, 0);
            if (fd == INVALID_SOCKET)
                return JS_NewInt32(ctx, -1);
            u_long mode = 1;
            ioctlsocket(fd, FIONBIO, &mode);
            WSAEventSelect(fd, sock->event, FD_READ | FD_WRITE | FD_CONNECT | FD_CLOSE);
            sock->fd = (int)fd;
        }

        ret = connect(fd, (struct sockaddr*)&addr, sizeof(addr));
    } else {
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
        ret = connect(fd, (struct sockaddr*)&addr, sizeof(addr));
    }

    if (ret == 0)
        return JS_NewInt32(ctx, 0);

    int err = WSAGetLastError();
    if (err == WSAEWOULDBLOCK)
        return JS_NewInt32(ctx, 0);

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

    SockRuntime *r = find_runtime(JS_GetRuntime(ctx));
    if (r && r->slot_count > 0) r->slot_count--;

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

    struct addrinfo hints, *res;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    int gai_err = getaddrinfo(hostname, NULL, &hints, &res);

    char ip[INET6_ADDRSTRLEN];
    const char *ip_str = NULL;

    if (gai_err == 0 && res) {
        struct addrinfo *ipv6 = NULL;

        for (struct addrinfo *rp = res; rp; rp = rp->ai_next) {
            if (rp->ai_family == AF_INET) {
                struct sockaddr_in *sin = (struct sockaddr_in *)rp->ai_addr;
                ip_str = inet_ntop(AF_INET, &sin->sin_addr, ip, sizeof(ip));
                break;
            }
            if (rp->ai_family == AF_INET6 && !ipv6)
                ipv6 = rp;
        }

        if (!ip_str && ipv6) {
            struct sockaddr_in6 *sin6 = (struct sockaddr_in6 *)ipv6->ai_addr;
            ip_str = inet_ntop(AF_INET6, &sin6->sin6_addr, ip, sizeof(ip));
        }

        freeaddrinfo(res);
    }

    /* Fallback: try numeric IP (v4 or v6) directly */
    if (!ip_str) {
        struct in_addr addr4;
        if (inet_pton(AF_INET, hostname, &addr4) == 1) {
            ip_str = inet_ntop(AF_INET, &addr4, ip, sizeof(ip));
        } else {
            struct in6_addr addr6;
            if (inet_pton(AF_INET6, hostname, &addr6) == 1) {
                ip_str = inet_ntop(AF_INET6, &addr6, ip, sizeof(ip));
            }
        }
    }

    JS_FreeCString(ctx, hostname);

    if (!ip_str)
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
