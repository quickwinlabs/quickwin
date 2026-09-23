#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"
#include "quickjs-libc.h"
#include "quickjs-sock.h"
#include "quickjs-thread-state.h"
#include "quickjs-args.h"
#include "quickjs/cutils.h"

#ifndef countof
#define countof(x) (sizeof(x) / sizeof((x)[0]))
#endif

/* ─── inet_ntop / inet_pton runtime dispatch ────────────────── */
/* XP has no inet_ntop/inet_pton; Vista+ has native versions.   */
/* We use function pointers resolved at init time.              */
/* XP fallback uses WSAStringToAddress / WSAAddressToString     */
/* which support both IPv4 and IPv6 on XP SP1+.                 */

/* Native ws2_32 inet_ntop/inet_pton are WSAAPI (stdcall on x86).
   Mismatch vs cdecl corrupts the stack on Win7 x86 — must match. */
typedef const char *(WSAAPI *inet_ntop_fn)(int af, const void *src, char *dst, socklen_t size);
typedef int (WSAAPI *inet_pton_fn)(int af, const char *src, void *dst);

static inet_ntop_fn p_inet_ntop = NULL;
static inet_pton_fn p_inet_pton = NULL;

static const char *WSAAPI inet_ntop_compat(int af, const void *src, char *dst, socklen_t size) {
    struct sockaddr_storage ss;
    unsigned long len = (unsigned long)size;
    memset(&ss, 0, sizeof(ss));
    ss.ss_family = (ADDRESS_FAMILY)af;
    switch (af) {
    case AF_INET:
        ((struct sockaddr_in *)&ss)->sin_addr = *(struct in_addr *)src;
        break;
    case AF_INET6:
        ((struct sockaddr_in6 *)&ss)->sin6_addr = *(struct in6_addr *)src;
        break;
    default:
        return NULL;
    }
    if (WSAAddressToStringA((struct sockaddr *)&ss, sizeof(ss), NULL, dst, &len) == 0)
        return dst;
    return NULL;
}

static int WSAAPI inet_pton_compat(int af, const char *src, void *dst) {
    struct sockaddr_storage ss;
    int size = sizeof(ss);
    char src_copy[INET6_ADDRSTRLEN + 1];
    strncpy(src_copy, src, INET6_ADDRSTRLEN);
    src_copy[INET6_ADDRSTRLEN] = '\0';
    memset(&ss, 0, sizeof(ss));
    if (WSAStringToAddressA(src_copy, af, NULL, (struct sockaddr *)&ss, &size) == 0) {
        switch (af) {
        case AF_INET:
            *(struct in_addr *)dst = ((struct sockaddr_in *)&ss)->sin_addr;
            return 1;
        case AF_INET6:
            *(struct in6_addr *)dst = ((struct sockaddr_in6 *)&ss)->sin6_addr;
            return 1;
        }
    }
    return 0;
}

static void inet_init_compat(void) {
    if (p_inet_ntop) return;
    HMODULE h = GetModuleHandleA("ws2_32.dll");
    if (h) {
        p_inet_ntop = (inet_ntop_fn)GetProcAddress(h, "inet_ntop");
        p_inet_pton = (inet_pton_fn)GetProcAddress(h, "inet_pton");
    }
    if (!p_inet_ntop) p_inet_ntop = inet_ntop_compat;
    if (!p_inet_pton) p_inet_pton = inet_pton_compat;
}

#define inet_ntop p_inet_ntop
#define inet_pton p_inet_pton

#define INIT_SLOTS_CAP 16

/* ─── Internal types ────────────────────────────────────────── */

struct SockHandle {
    int fd;            /* -1 if slot is free */
    int af;            /* AF_INET / AF_INET6 */
    WSAEVENT event;
    JSValue on_event;
    JSContext *js_ctx;
};

/* ─── Per-runtime state (embedded in JSThreadState, no globals) ─ */

static SockState *find_runtime(JSRuntime *rt)
{
    JSThreadState *ts = JS_GetRuntimeOpaque(rt);
    return ts ? &ts->sock : NULL;
}

/* ─── API: event-loop integration ───────────────────────────── */

void js_sock_init(JSRuntime *rt)
{
    inet_init_compat();
    SockState *r = find_runtime(rt);
    if (!r || r->slots)
        return;
    r->slot_count = 0;
    r->slots_capacity = INIT_SLOTS_CAP;
    r->slots = malloc(r->slots_capacity * sizeof(SockHandle));
    if (!r->slots) {
        r->slots_capacity = 0;
        return;
    }
    for (int i = 0; i < r->slots_capacity; i++)
        r->slots[i].fd = -1;
}

/* dispose in-place: free this runtime's slots, no global array */
void js_sock_remove_runtime(JSRuntime *rt)
{
    SockState *r = find_runtime(rt);
    if (!r)
        return;
    free(r->slots);
    r->slots = NULL;
    r->slot_count = 0;
    r->slots_capacity = 0;
}

int js_sock_slot_count(JSRuntime *rt)
{
    SockState *r = find_runtime(rt);
    return r ? r->slot_count : 0;
}

void js_sock_collect_handles(JSRuntime *rt, HANDLE *handles, int max, int *count)
{
    SockState *r = find_runtime(rt);
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
    SockState *r = find_runtime(rt);
    if (!r) return 0;
    for (int i = 0; i < r->slots_capacity; i++) {
        SockHandle *s = &r->slots[i];
        if (s->fd < 0) continue;
        if ((HANDLE)s->event == triggered) {
            WSANETWORKEVENTS events;
            memset(&events, 0, sizeof(events));
            if (WSAEnumNetworkEvents(s->fd, s->event, &events) != SOCKET_ERROR) {
                loop_log("[loop] sock fd=%d slot=%d events=0x%08lX",
                         s->fd, i, (unsigned long)events.lNetworkEvents);
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
                int err = WSAGetLastError();
                loop_log("[loop] sock fd=%d slot=%d WSAEnumNetworkEvents FAILED err=%d — cleaning up",
                         s->fd, i, err);
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
                if (r->slot_count > 0)
                    r->slot_count--;
            }
            return 1;
        }
    }
    return 0;
}

void js_sock_free_handles(JSRuntime *rt)
{
    SockState *r = find_runtime(rt);
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
    SockState *r = find_runtime(JS_GetRuntime(ctx));
    if (!r || idx < 0 || idx >= r->slots_capacity || r->slots[idx].fd < 0)
        return NULL;
    return &r->slots[idx];
}

static int find_free_slot(SockState *r)
{
    for (int i = 0; i < r->slots_capacity; i++) {
        if (r->slots[i].fd < 0)
            return i;
    }
    return -1;
}

static SockHandle *make_slot(SockState *r, JSRuntime *rt)
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
    GET_INT32_OPT(ctx, argv[0], af, AF_INET);
    GET_INT32_OPT(ctx, argv[1], type, SOCK_STREAM);
    GET_INT32_OPT(ctx, argv[2], protocol, 0);

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

    SockState *r = find_runtime(JS_GetRuntime(ctx));
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
    sock->af = af;
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
            sock->af = AF_INET6;
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

    GET_INT32_OPT(ctx, argv[1], size, 4096);

    uint8_t *buf = malloc(size);
    if (!buf)
        return JS_ThrowTypeError(ctx, "Out of memory");

    GET_INT32_OPT(ctx, argv[2], flags, 0);

    int ret = recv(sock->fd, (char*)buf, size, flags);
    if (ret <= 0) {
        free(buf);
        return JS_NULL;
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

    SockState *r = find_runtime(JS_GetRuntime(ctx));
    if (r && r->slot_count > 0) r->slot_count--;

    return JS_UNDEFINED;
}

static JSValue js_shutdown(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    SockHandle *sock = get_sock(ctx, argv[0]);
    if (!sock || sock->fd < 0)
        return JS_NewInt32(ctx, -1);

    GET_INT32_OPT(ctx, argv[1], how, SD_BOTH);

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

/* ─── Server-side support ───────────────────────────────────── */

/* Recreate the socket fd with the given address family, reusing the
   existing WSA event handle. Used when bind() needs a different family. */
static int sock_rebind_fd(SockHandle *sock, int af, int event_mask)
{
    SOCKET fd = socket(af, SOCK_STREAM, 0);
    if (fd == INVALID_SOCKET)
        return -1;

    u_long mode = 1;
    ioctlsocket(fd, FIONBIO, &mode);

    if (WSAEventSelect(fd, sock->event, event_mask) == SOCKET_ERROR) {
        closesocket(fd);
        return -1;
    }

    if (sock->fd >= 0) {
        WSAEventSelect(sock->fd, sock->event, 0);
        closesocket(sock->fd);
    }
    sock->fd = (int)fd;
    sock->af = af;
    return 0;
}

static JSValue js_bind(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    SockHandle *sock = get_sock(ctx, argv[0]);
    if (!sock || sock->fd < 0)
        return JS_ThrowTypeError(ctx, "Invalid sock handle");

    const char *host = NULL;
    if (argc > 1 && !JS_IsNull(argv[1]) && !JS_IsUndefined(argv[1]))
        host = JS_ToCString(ctx, argv[1]);

    int port = 0;
    if (argc > 2) JS_ToInt32(ctx, &port, argv[2]);

    int is_ipv6 = (host && strchr(host, ':') != NULL) ? 1 : 0;
    int ret;

    if (is_ipv6) {
        if (sock->af != AF_INET6) {
            if (sock_rebind_fd(sock, AF_INET6, FD_READ | FD_WRITE | FD_CONNECT | FD_CLOSE)) {
                if (host) JS_FreeCString(ctx, host);
                return JS_NewInt32(ctx, -1);
            }
        }
        struct sockaddr_in6 addr;
        memset(&addr, 0, sizeof(addr));
        addr.sin6_family = AF_INET6;
        addr.sin6_port = htons((unsigned short)port);
        if (host && host[0] && strcmp(host, "::") != 0) {
            if (inet_pton(AF_INET6, host, &addr.sin6_addr) != 1) {
                if (host) JS_FreeCString(ctx, host);
                return JS_NewInt32(ctx, -1);
            }
        }
        ret = bind(sock->fd, (struct sockaddr *)&addr, sizeof(addr));
    } else {
        if (sock->af != AF_INET) {
            if (sock_rebind_fd(sock, AF_INET, FD_READ | FD_WRITE | FD_CONNECT | FD_CLOSE)) {
                if (host) JS_FreeCString(ctx, host);
                return JS_NewInt32(ctx, -1);
            }
        }
        struct sockaddr_in addr;
        memset(&addr, 0, sizeof(addr));
        addr.sin_family = AF_INET;
        addr.sin_port = htons((unsigned short)port);
        if (host && host[0]) {
            addr.sin_addr.s_addr = inet_addr(host);
            if (addr.sin_addr.s_addr == INADDR_NONE) {
                if (host) JS_FreeCString(ctx, host);
                return JS_NewInt32(ctx, -1);
            }
        } else {
            addr.sin_addr.s_addr = htonl(INADDR_ANY);
        }
        ret = bind(sock->fd, (struct sockaddr *)&addr, sizeof(addr));
    }

    if (host) JS_FreeCString(ctx, host);
    return JS_NewInt32(ctx, ret == 0 ? 0 : -1);
}

static JSValue js_listen(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    SockHandle *sock = get_sock(ctx, argv[0]);
    if (!sock || sock->fd < 0)
        return JS_ThrowTypeError(ctx, "Invalid sock handle");

    int backlog = 8;
    if (argc > 1) JS_ToInt32(ctx, &backlog, argv[1]);

    int ret = listen(sock->fd, backlog);
    if (ret == 0) {
        /* switch the event mask to accept notifications */
        WSAEventSelect(sock->fd, sock->event, FD_ACCEPT | FD_CLOSE);
    }
    return JS_NewInt32(ctx, ret);
}

static JSValue js_accept(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    SockHandle *sock = get_sock(ctx, argv[0]);
    if (!sock || sock->fd < 0)
        return JS_ThrowTypeError(ctx, "Invalid sock handle");

    struct sockaddr_storage ss;
    int len = sizeof(ss);
    SOCKET newfd = accept(sock->fd, (struct sockaddr *)&ss, &len);
    if (newfd == INVALID_SOCKET)
        return JS_NULL;

    u_long mode = 1;
    ioctlsocket(newfd, FIONBIO, &mode);

    WSAEVENT event = WSACreateEvent();
    if (event == WSA_INVALID_EVENT) {
        closesocket(newfd);
        return JS_NULL;
    }
    if (WSAEventSelect(newfd, event, FD_READ | FD_WRITE | FD_CLOSE) == SOCKET_ERROR) {
        WSACloseEvent(event);
        closesocket(newfd);
        return JS_NULL;
    }

    SockState *r = find_runtime(JS_GetRuntime(ctx));
    if (!r) {
        WSACloseEvent(event);
        closesocket(newfd);
        return JS_NULL;
    }

    SockHandle *ns = make_slot(r, JS_GetRuntime(ctx));
    if (!ns) {
        WSACloseEvent(event);
        closesocket(newfd);
        return JS_NULL;
    }

    ns->fd = (int)newfd;
    ns->af = (ss.ss_family == AF_INET6) ? AF_INET6 : AF_INET;
    ns->event = event;
    ns->on_event = JS_UNDEFINED;
    ns->js_ctx = ctx;
    r->slot_count++;

    char ip[INET6_ADDRSTRLEN];
    const char *ip_str = NULL;
    int port = 0;
    if (ss.ss_family == AF_INET) {
        struct sockaddr_in *sin = (struct sockaddr_in *)&ss;
        ip_str = inet_ntop(AF_INET, &sin->sin_addr, ip, sizeof(ip));
        port = ntohs(sin->sin_port);
    } else if (ss.ss_family == AF_INET6) {
        struct sockaddr_in6 *sin6 = (struct sockaddr_in6 *)&ss;
        ip_str = inet_ntop(AF_INET6, &sin6->sin6_addr, ip, sizeof(ip));
        port = ntohs(sin6->sin6_port);
    }

    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "handle", JS_NewInt32(ctx, (int)(ns - r->slots)));
    JS_SetPropertyStr(ctx, obj, "addr", JS_NewString(ctx, ip_str ? ip_str : ""));
    JS_SetPropertyStr(ctx, obj, "port", JS_NewInt32(ctx, port));
    return obj;
}

static JSValue js_getsockname(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    SockHandle *sock = get_sock(ctx, argv[0]);
    if (!sock || sock->fd < 0)
        return JS_ThrowTypeError(ctx, "Invalid sock handle");

    struct sockaddr_storage ss;
    int len = sizeof(ss);
    if (getsockname(sock->fd, (struct sockaddr *)&ss, &len) != 0)
        return JS_NULL;

    char ip[INET6_ADDRSTRLEN];
    const char *ip_str = NULL;
    int port = 0;
    if (ss.ss_family == AF_INET) {
        struct sockaddr_in *sin = (struct sockaddr_in *)&ss;
        ip_str = inet_ntop(AF_INET, &sin->sin_addr, ip, sizeof(ip));
        port = ntohs(sin->sin_port);
    } else if (ss.ss_family == AF_INET6) {
        struct sockaddr_in6 *sin6 = (struct sockaddr_in6 *)&ss;
        ip_str = inet_ntop(AF_INET6, &sin6->sin6_addr, ip, sizeof(ip));
        port = ntohs(sin6->sin6_port);
    }

    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "addr", JS_NewString(ctx, ip_str ? ip_str : ""));
    JS_SetPropertyStr(ctx, obj, "port", JS_NewInt32(ctx, port));
    return obj;
}

/* ─── Module exports ────────────────────────────────────────── */

static const JSCFunctionListEntry sock_funcs[] = {
    JS_CFUNC_DEF("socket", 3, js_socket),
    JS_CFUNC_DEF("connect", 3, js_connect),
    JS_CFUNC_DEF("bind", 3, js_bind),
    JS_CFUNC_DEF("listen", 2, js_listen),
    JS_CFUNC_DEF("accept", 1, js_accept),
    JS_CFUNC_DEF("getsockname", 1, js_getsockname),
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
