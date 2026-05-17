#include <winsock2.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "quickjs-http.h"
#include "quickjs.h"
#include "cutils.h"

#include <wolfssl/options.h>
#include <wolfssl/ssl.h>

static int is_http_url(const char* name) {
    return strncmp(name, "http://", 7) == 0;
}

static int is_https_url(const char* name) {
    return strncmp(name, "https://", 8) == 0;
}

static char* extract_body(char* response) {
    char* body = strstr(response, "\r\n\r\n");
    if (body) {
        body += 4;
        size_t body_len = strlen(body);
        memmove(response, body, body_len + 1);
    }
    return response;
}

static int parse_url(const char* url, char* scheme, size_t scheme_size,
                      char* host, size_t host_size, int* port, char* path, size_t path_size) {
    memset(scheme, 0, scheme_size);
    memset(host, 0, host_size);
    memset(path, 0, path_size);
    path[0] = '/';
    path[1] = '\0';
    *port = 80;

    const char* p = url;

    if (strncmp(p, "http://", 7) == 0) {
        strncpy(scheme, "http", scheme_size - 1);
        p += 7;
    } else if (strncmp(p, "https://", 8) == 0) {
        strncpy(scheme, "https", scheme_size - 1);
        p += 8;
        *port = 443;
    } else {
        return 0;
    }

    const char* slash = strchr(p, '/');
    const char* colon = strchr(p, ':');

    if (slash && colon && colon > slash) {
        colon = NULL;
    }

    if (colon) {
        size_t host_len = colon - p;
        if (host_len >= host_size) host_len = host_size - 1;
        strncpy(host, p, host_len);
        sscanf(colon + 1, "%d%s", port, path);
    } else if (slash) {
        size_t host_len = slash - p;
        if (host_len >= host_size) host_len = host_size - 1;
        strncpy(host, p, host_len);
        strncpy(path, slash, path_size - 1);
    } else {
        strncpy(host, p, host_size - 1);
    }

    return 1;
}

// ── File I/O helpers ──

static void* read_entire_file(const char* path, size_t* out_len) {
    FILE* f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    void* buf = malloc((size_t)len + 1);
    if (!buf) { fclose(f); return NULL; }
    fread(buf, 1, len, f);
    fclose(f);
    ((char*)buf)[len] = '\0';
    if (out_len) *out_len = (size_t)len;
    return buf;
}

static int write_entire_file(const char* path, const void* data, size_t len) {
    FILE* f = fopen(path, "wb");
    if (!f) return 0;
    size_t written = fwrite(data, 1, len, f);
    fclose(f);
    return written == len;
}

// ── HTTP Cache ──
//
// Cache 路径早期用宽字符 (wchar_t) 实现：
//   GetModuleFileNameW → swprintf(L"%016llx") → _wfopen
//
// MINGW64 的 __USE_MINGW_ANSI_STDIO 包装器只覆盖窄字符函数 (snprintf 等)，
// 不覆盖 swprintf 等宽字符函数。窄版 snprintf 把 %llx 正确转为 Windows 的 %I64x，
// 而宽版 swprintf 透传到系统 CRT (msvcrt.dll)，Win7 的 msvcrt 不认识 %llx，
// 导致文件名乱码 → 所有文件操作静默失败。
//
// 修复：全部改为窄字符路径 (ANSI)，统一使用 snprintf + fopen。
//   GetModuleFileNameA → snprintf → fopen

static unsigned long long fnv1a_64(const char* str) {
    unsigned long long hash = 14695981039346656037ULL;
    int c;
    while ((c = (unsigned char)*str++)) {
        hash ^= c;
        hash *= 1099511628211ULL;
    }
    return hash;
}

static void get_cache_dir(char* buf, int buf_size) {
    GetModuleFileNameA(NULL, buf, buf_size);
    char* p = strrchr(buf, '\\');
    if (p) p[1] = '\0';
    strcat(buf, "_cache");
}

static void cache_path(const char* cache_dir, const char* url,
                       char* path, int path_size, const char* ext) {
    unsigned long long h = fnv1a_64(url);
    snprintf(path, path_size, "%s\\%016llx%s", cache_dir, h, ext);
}

// Returns max_age (>=0), -1 if no max-age, -2 if no-store
static int parse_max_age(const char* response) {
    const char* cc = strstr(response, "Cache-Control:");
    if (!cc) {
        cc = strstr(response, "cache-control:");
        if (!cc) return -1;
    }
    cc += 14;
    while (*cc == ' ') cc++;
    if (strncmp(cc, "no-store", 8) == 0) return -2;
    const char* ma = strstr(cc, "max-age=");
    if (!ma) return -1;
    ma += 8;
    return atoi(ma);
}

// ── Cache file helpers (shared by C import caching and JS fetch() API) ──

static char* read_meta_file(const char* url) {
    char cache_dir[MAX_PATH];
    get_cache_dir(cache_dir, MAX_PATH);
    char path[MAX_PATH];
    cache_path(cache_dir, url, path, MAX_PATH, ".meta");
    return read_entire_file(path, NULL);
}

static void* read_body_file(const char* url, size_t* out_len) {
    char cache_dir[MAX_PATH];
    get_cache_dir(cache_dir, MAX_PATH);
    char path[MAX_PATH];
    cache_path(cache_dir, url, path, MAX_PATH, ".body");
    return read_entire_file(path, out_len);
}

static void write_meta_file(const char* url, const char* json_str) {
    char cache_dir[MAX_PATH];
    get_cache_dir(cache_dir, MAX_PATH);
    char path[MAX_PATH];
    cache_path(cache_dir, url, path, MAX_PATH, ".meta");
    write_entire_file(path, json_str, strlen(json_str));
}

static void write_cache_file(const char* url, int max_age,
                             const void* body, size_t body_len) {
    char cache_dir[MAX_PATH];
    get_cache_dir(cache_dir, MAX_PATH);
    CreateDirectoryA(cache_dir, NULL);

    char meta_buf[128];
    snprintf(meta_buf, sizeof(meta_buf), "{\"storedAt\":%lld,\"maxAge\":%d}",
             (long long)time(NULL), max_age);

    char meta_path[MAX_PATH], body_path[MAX_PATH];
    cache_path(cache_dir, url, meta_path, MAX_PATH, ".meta");
    cache_path(cache_dir, url, body_path, MAX_PATH, ".body");

    if (!write_entire_file(meta_path, meta_buf, strlen(meta_buf))) return;
    if (!write_entire_file(body_path, body, body_len)) remove(meta_path);
}

static char* read_cache(const char* url) {
    char* meta = read_meta_file(url);
    if (!meta) return NULL;

    long long storedAt = 0;
    int maxAge = 0;
    const char* p = strstr(meta, "\"storedAt\"");
    if (p) { p = strchr(p, ':'); if (p) storedAt = atoll(p + 1); }
    p = strstr(meta, "\"maxAge\"");
    if (p) { p = strchr(p, ':'); if (p) maxAge = atoi(p + 1); }
    free(meta);

    if (maxAge <= 0 || time(NULL) - storedAt >= maxAge) {
        char cache_dir[MAX_PATH];
        get_cache_dir(cache_dir, MAX_PATH);
        char meta_path[MAX_PATH], body_path[MAX_PATH];
        cache_path(cache_dir, url, meta_path, MAX_PATH, ".meta");
        cache_path(cache_dir, url, body_path, MAX_PATH, ".body");
        remove(meta_path);
        remove(body_path);
        return NULL;
    }

    size_t body_len;
    return read_body_file(url, &body_len);
}

static void try_cache_response(const char* url, const char* response, size_t total) {
    if (strncmp(response, "HTTP/1.1 200", 12) != 0 &&
        strncmp(response, "HTTP/1.0 200", 12) != 0) return;

    int max_age = parse_max_age(response);
    if (max_age < 0) return;

    const char* body_start = strstr(response, "\r\n\r\n");
    if (!body_start) return;
    body_start += 4;
    size_t body_len = total - (body_start - response);
    if (body_len == 0) return;

    write_cache_file(url, max_age, body_start, body_len);
}

// ── JS-callable cache API (globalThis.__httpCache__) ──

static JSValue js_cache_readMeta(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
    const char* url = JS_ToCString(ctx, argv[0]);
    if (!url) return JS_NULL;
    char* result = read_meta_file(url);
    JS_FreeCString(ctx, url);
    if (!result) return JS_NULL;
    JSValue js_r = JS_NewString(ctx, result);
    free(result);
    return js_r;
}

static JSValue js_cache_readBody(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
    const char* url = JS_ToCString(ctx, argv[0]);
    if (!url) return JS_NULL;
    size_t len;
    void* buf = read_body_file(url, &len);
    JS_FreeCString(ctx, url);
    if (!buf) return JS_NULL;
    JSValue js_r = JS_NewArrayBufferCopy(ctx, buf, len);
    free(buf);
    return js_r;
}

static JSValue js_cache_writeCache(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    const char* url = JS_ToCString(ctx, argv[0]);
    if (!url) return JS_EXCEPTION;
    int max_age;
    JS_ToInt32(ctx, &max_age, argv[1]);
    size_t body_len = 0;
    const void* body = NULL;
    uint8_t* ab_body = NULL;
    const char* str_body = NULL;

    if (JS_IsString(argv[2])) {
        str_body = JS_ToCString(ctx, argv[2]);
        if (!str_body) { JS_FreeCString(ctx, url); return JS_EXCEPTION; }
        body = str_body;
        body_len = strlen(str_body);
    } else {
        ab_body = JS_GetArrayBuffer(ctx, &body_len, argv[2]);
        if (!ab_body) { JS_FreeCString(ctx, url); return JS_EXCEPTION; }
        body = ab_body;
    }

    write_cache_file(url, max_age, body, body_len);

    if (str_body) JS_FreeCString(ctx, str_body);
    JS_FreeCString(ctx, url);
    return JS_UNDEFINED;
}

static JSValue js_cache_writeMeta(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    const char* url = JS_ToCString(ctx, argv[0]);
    if (!url) return JS_EXCEPTION;
    const char* json_str = JS_ToCString(ctx, argv[1]);
    if (!json_str) { JS_FreeCString(ctx, url); return JS_EXCEPTION; }
    write_meta_file(url, json_str);
    JS_FreeCString(ctx, url);
    JS_FreeCString(ctx, json_str);
    return JS_UNDEFINED;
}

static JSValue js_cache_cacheKey(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
    const char* url = JS_ToCString(ctx, argv[0]);
    if (!url) return JS_NULL;
    unsigned long long h = fnv1a_64(url);
    JS_FreeCString(ctx, url);
    char hex[17];
    snprintf(hex, sizeof(hex), "%016llx", h);
    return JS_NewString(ctx, hex);
}

void js_init_http_cache_api(JSContext *ctx) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "readMeta",
        JS_NewCFunction(ctx, js_cache_readMeta, "readMeta", 1));
    JS_SetPropertyStr(ctx, obj, "readBody",
        JS_NewCFunction(ctx, js_cache_readBody, "readBody", 1));
    JS_SetPropertyStr(ctx, obj, "writeCache",
        JS_NewCFunction(ctx, js_cache_writeCache, "writeCache", 3));
    JS_SetPropertyStr(ctx, obj, "writeMeta",
        JS_NewCFunction(ctx, js_cache_writeMeta, "writeMeta", 2));
    JS_SetPropertyStr(ctx, obj, "cacheKey",
        JS_NewCFunction(ctx, js_cache_cacheKey, "cacheKey", 1));
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "__httpCache__", obj);
    JS_FreeValue(ctx, global);
}

char* http_get_sync(const char* url) {
    char scheme[16] = {0};
    char host[256] = {0};
    char path[1024] = {0};
    int port = 80;

    if (!parse_url(url, scheme, sizeof(scheme), host, sizeof(host), &port, path, sizeof(path))) {
        return NULL;
    }

    char* cached = read_cache(url);
    if (cached) return cached;

    int is_https = is_https_url(url);

    SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) {
        return NULL;
    }

    struct hostent* he = gethostbyname(host);
    if (!he) {
        closesocket(sock);
        return NULL;
    }

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    memcpy(&addr.sin_addr, he->h_addr_list[0], he->h_length);

    if (connect(sock, (struct sockaddr*)&addr, sizeof(addr)) == SOCKET_ERROR) {
        closesocket(sock);
        return NULL;
    }

    if (is_https) {
        WOLFSSL_METHOD* method = wolfTLSv1_2_client_method();
        WOLFSSL_CTX* ctx = wolfSSL_CTX_new(method);
        if (!ctx) {
            closesocket(sock);
            return NULL;
        }

        wolfSSL_CTX_set_verify(ctx, SSL_VERIFY_NONE, NULL);

        WOLFSSL* ssl = wolfSSL_new(ctx);
        if (!ssl) {
            wolfSSL_CTX_free(ctx);
            closesocket(sock);
            return NULL;
        }

        wolfSSL_set_fd(ssl, sock);

        wolfSSL_UseSNI(ssl, WOLFSSL_SNI_HOST_NAME, host, strlen(host));

        if (wolfSSL_connect(ssl) != SSL_SUCCESS) {
            wolfSSL_free(ssl);
            wolfSSL_CTX_free(ctx);
            closesocket(sock);
            return NULL;
        }

        char request[2048];
        snprintf(request, sizeof(request),
                 "GET %s HTTP/1.1\r\n"
                 "Host: %s\r\n"
                 "User-Agent: QuickJS/1.0\r\n"
                 "Connection: close\r\n"
                 "\r\n",
                 path, host);

        if (wolfSSL_write(ssl, request, strlen(request)) <= 0) {
            wolfSSL_shutdown(ssl);
            wolfSSL_free(ssl);
            wolfSSL_CTX_free(ctx);
            closesocket(sock);
            return NULL;
        }

        char* response = malloc(1024 * 1024);
        if (!response) {
            wolfSSL_shutdown(ssl);
            wolfSSL_free(ssl);
            wolfSSL_CTX_free(ctx);
            closesocket(sock);
            return NULL;
        }

        size_t total = 0;
        char buffer[4096];
        int received;

        while ((received = wolfSSL_read(ssl, buffer, sizeof(buffer))) > 0) {
            if (total + received >= 1024 * 1024) {
                break;
            }
            memcpy(response + total, buffer, received);
            total += received;
        }

        response[total] = '\0';

        try_cache_response(url, response, total);

        wolfSSL_shutdown(ssl);
        wolfSSL_free(ssl);
        wolfSSL_CTX_free(ctx);
        closesocket(sock);

        if (response) {
            return extract_body(response);
        }
        return NULL;
    } else {
        char request[2048];
        snprintf(request, sizeof(request),
                 "GET %s HTTP/1.1\r\n"
                 "Host: %s\r\n"
                 "User-Agent: QuickJS/1.0\r\n"
                 "Connection: close\r\n"
                 "\r\n",
                 path, host);

        send(sock, request, strlen(request), 0);

        char* response = malloc(1024 * 1024);
        if (!response) {
            closesocket(sock);
            return NULL;
        }

        size_t total = 0;
        char buffer[4096];
        int received;

        while ((received = recv(sock, buffer, sizeof(buffer), 0)) > 0) {
            if (total + received >= 1024 * 1024) {
                break;
            }
            memcpy(response + total, buffer, received);
            total += received;
        }

        response[total] = '\0';

        try_cache_response(url, response, total);

        closesocket(sock);

        if (response) {
            return extract_body(response);
        }
        return NULL;
    }
}

char* js_module_normalize_name(JSContext *ctx,
                               const char *base_name,
                               const char *name, void *opaque)
{
    // printf("base_name: %s  name: %s", base_name, name);
    if (!is_http_url(base_name) && !is_https_url(base_name)) {
        if (name[0] != '.') {
            return js_strdup(ctx, name);
        }
        char *filename, *p;
        const char *r;
        int cap, len;

        p = strrchr(base_name, '/');
        if (p)
            len = p - base_name;
        else
            len = 0;

        cap = len + strlen(name) + 1 + 1;
        filename = js_malloc(ctx, cap);
        if (!filename)
            return NULL;
        memcpy(filename, base_name, len);
        filename[len] = '\0';

        r = name;
        for(;;) {
            if (r[0] == '.' && r[1] == '/') {
                r += 2;
            } else if (r[0] == '.' && r[1] == '.' && r[2] == '/') {
                if (filename[0] == '\0')
                    break;
                p = strrchr(filename, '/');
                if (!p)
                    p = filename;
                else
                    p++;
                if (!strcmp(p, ".") || !strcmp(p, ".."))
                    break;
                if (p > filename)
                    p--;
                *p = '\0';
                r += 3;
            } else {
                break;
            }
        }
        if (filename[0] != '\0')
            pstrcat(filename, cap, "/");
        pstrcat(filename, cap, r);
        return filename;
    }

    char scheme[16] = {0};
    char hbase[256] = {0};
    char base_path[1024] = {0};
    int port = 80;

    if (!parse_url(base_name, scheme, sizeof(scheme), hbase, sizeof(hbase), &port, base_path, sizeof(base_path))) {
        return js_strdup(ctx, name);
    }

    if (is_http_url(name) || is_https_url(name)) {
        return js_strdup(ctx, name);
    }

    char new_path[1024] = {0};

    if (name[0] == '/') {
        strncpy(new_path, name, sizeof(new_path) - 1);
    } else {
        strncpy(new_path, base_path, sizeof(new_path) - 1);

        char *last_slash = strrchr(new_path, '/');
        if (last_slash) {
            *(last_slash + 1) = '\0';
        } else {
            new_path[0] = '/';
            new_path[1] = '\0';
        }

        const char *r = name;
        for(;;) {
            if (r[0] == '.' && r[1] == '/') {
                r += 2;
            } else if (r[0] == '.' && r[1] == '.' && r[2] == '/') {
                if (strlen(new_path) > 1) {
                    char *p = strrchr(new_path, '/');
                    if (p && p != new_path) {
                        char *prev = p - 1;
                        while (prev > new_path && *prev != '/') {
                            prev--;
                        }
                        if (*prev == '/') {
                            *(prev + 1) = '\0';
                        }
                    }
                }
                r += 3;
            } else {
                break;
            }
        }

        size_t current_len = strlen(new_path);
        if (current_len + strlen(r) < sizeof(new_path)) {
            strcat(new_path, r);
        }
    }

    char *result = js_malloc(ctx, 256 + sizeof(new_path));
    if (!result)
        return NULL;

    if (port == 80) {
        snprintf(result, 256 + sizeof(new_path), "%s://%s%s", scheme, hbase, new_path);
    } else {
        snprintf(result, 256 + sizeof(new_path), "%s://%s:%d%s", scheme, hbase, port, new_path);
    }

    return result;
}