#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <wininet.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <time.h>

#include "quickjs-http.h"
#include "quickjs.h"
#include "cutils.h"

#include <wolfssl/options.h>
#include <wolfssl/ssl.h>

#include <brotli/decode.h>

int http_debug = 0;

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

static void skip_crlf(char **p) {
    *p += strcspn(*p, "\r\n");
    *p += strspn(*p, "\r\n");
}

static int is_chunked(const char *response) {
    const char *te = strstr(response, "Transfer-Encoding:");
    if (!te) te = strstr(response, "transfer-encoding:");
    if (!te) return 0;
    return strstr(te + 18, "chunked") != NULL;
}

static int decode_chunked(char *response, size_t *total) {
    char *body = strstr(response, "\r\n\r\n");
    if (!body) return 0;
    body += 4;

    char *r = body, *w = body;
    while (*r) {
        long size = strtol(r, &r, 16);
        if (size <= 0) break;
        skip_crlf(&r);
        memmove(w, r, size);
        w += size;
        r += size;
        skip_crlf(&r);
    }
    *w = '\0';
    if (total)
        *total = (size_t)(w - response);
    return 1;
}

static int parse_url(const char* url, char* scheme, size_t scheme_size,
                      char* host, size_t host_size, int* port, char* path, size_t path_size) {
    memset(scheme, 0, scheme_size);
    memset(host, 0, host_size);
    memset(path, 0, path_size);
    path[0] = '/';
    path[1] = '\0';
    *port = 80;

    int wlen = MultiByteToWideChar(CP_UTF8, 0, url, -1, NULL, 0);
    wchar_t *wurl = malloc(wlen * sizeof(wchar_t));
    if (!wurl) return 0;
    MultiByteToWideChar(CP_UTF8, 0, url, -1, wurl, wlen);

    URL_COMPONENTSW uc;
    memset(&uc, 0, sizeof(uc));
    uc.dwStructSize = sizeof(uc);
    wchar_t wscheme[16] = {0}, whost[256] = {0}, wpath[1024] = {0};
    uc.lpszScheme = wscheme;     uc.dwSchemeLength = 16;
    uc.lpszHostName = whost;     uc.dwHostNameLength = 256;
    uc.lpszUrlPath = wpath;      uc.dwUrlPathLength = 1024;
    /* omit lpszExtraInfo → query/fragment included in lpszUrlPath */

    BOOL ok = InternetCrackUrlW(wurl, 0, ICU_ESCAPE, &uc);
    free(wurl);
    if (!ok) return 0;

    WideCharToMultiByte(CP_UTF8, 0, wscheme, -1, scheme, (int)scheme_size, NULL, NULL);
    WideCharToMultiByte(CP_UTF8, 0, whost, -1, host, (int)host_size, NULL, NULL);
    *port = uc.nPort;

    if (wpath[0])
        WideCharToMultiByte(CP_UTF8, 0, wpath, -1, path, (int)path_size, NULL, NULL);

    return 1;
}

// ── File I/O helpers ──

static void* read_entire_fileW(const wchar_t* path, size_t* out_len) {
    FILE* f = _wfopen(path, L"rb");
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

static int write_entire_fileW(const wchar_t* path, const void* data, size_t len) {
    FILE* f = _wfopen(path, L"wb");
    if (!f) return 0;
    size_t written = fwrite(data, 1, len, f);
    fclose(f);
    return written == len;
}

// ── HTTP Cache ──
//
// 宽窄字符方案：
//   hex 格式化用窄 snprintf(%llx) —— 避开 swprintf 的 %llx 兼容性 bug
//   文件路径用 wchar_t —— GetModuleFileNameW / _wfopen / CreateDirectoryW / DeleteFileW
//   路径拼接用 wcscpy 逐段拷贝（预先检查缓冲区边界），不用 swprintf 拼接
//
// 路径流：
//   GetModuleFileNameW → wchar_t 缓存目录
//   fnv1a_64(url) → snprintf(%016llx) → MultiByteToWideChar → wchar_t hex
//   wcscpy(cache_dir) + '\\' + wcscpy(hex) + wcscpy(ext) → 完整路径
//   _wfopen / CreateDirectoryW / DeleteFileW

static unsigned long long fnv1a_64(const char* str) {
    unsigned long long hash = 14695981039346656037ULL;
    int c;
    while ((c = (unsigned char)*str++)) {
        hash ^= c;
        hash *= 1099511628211ULL;
    }
    return hash;
}

static void get_cache_dirW(wchar_t* buf, int buf_size) {
    DWORD len = GetModuleFileNameW(NULL, buf, buf_size);
    if (len == 0 || len >= (DWORD)buf_size || buf_size <= 0) {
        buf[0] = L'\0';
        return;
    }
    wchar_t* p = wcsrchr(buf, L'\\');
    if (p) {
        size_t base_len = p - buf + 1;
        if (base_len + 6 + 1 <= (size_t)buf_size) {
            wcscpy(p + 1, L"_cache");
            return;
        }
    }
    buf[0] = L'\0';
}

static void cache_pathW(const wchar_t* cache_dir, const char* url,
                        wchar_t* path, int path_size, const wchar_t* ext) {
    unsigned long long h = fnv1a_64(url);
    char hex[17];
    snprintf(hex, sizeof(hex), "%016llx", h);
    wchar_t whex[17];
    MultiByteToWideChar(CP_ACP, 0, hex, -1, whex, 17);
    path[0] = L'\0';
    size_t dir_len = wcslen(cache_dir);
    size_t hex_len = wcslen(whex);
    size_t ext_len = wcslen(ext);
    if (dir_len + 1 + hex_len + ext_len + 1 > (size_t)path_size) return;
    wcscpy(path, cache_dir);
    path[dir_len] = L'\\';
    wcscpy(path + dir_len + 1, whex);
    wcscpy(path + dir_len + 1 + hex_len, ext);
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

static inline void cache_path_for(const char* url, const wchar_t* ext, wchar_t* path, int path_size) {
    wchar_t dir[MAX_PATH];
    get_cache_dirW(dir, MAX_PATH);
    cache_pathW(dir, url, path, path_size, ext);
}

static char* read_meta_file(const char* url) {
    wchar_t path[MAX_PATH];
    cache_path_for(url, L".meta", path, MAX_PATH);
    return read_entire_fileW(path, NULL);
}

static void* read_body_file(const char* url, size_t* out_len) {
    wchar_t path[MAX_PATH];
    cache_path_for(url, L".body", path, MAX_PATH);
    return read_entire_fileW(path, out_len);
}

static void write_meta_file(const char* url, const char* json_str) {
    wchar_t path[MAX_PATH];
    cache_path_for(url, L".meta", path, MAX_PATH);
    write_entire_fileW(path, json_str, strlen(json_str));
}

static void write_cache_file(const char* url, int max_age,
                             const void* body, size_t body_len) {
    wchar_t meta_path[MAX_PATH], body_path[MAX_PATH];
    cache_path_for(url, L".meta", meta_path, MAX_PATH);
    cache_path_for(url, L".body", body_path, MAX_PATH);

    wchar_t dir[MAX_PATH];
    get_cache_dirW(dir, MAX_PATH);
    CreateDirectoryW(dir, NULL);

    char meta_buf[128];
    snprintf(meta_buf, sizeof(meta_buf), "{\"storedAt\":%lld,\"maxAge\":%d}",
             (long long)time(NULL), max_age);

    if (!write_entire_fileW(meta_path, meta_buf, strlen(meta_buf))) return;
    if (!write_entire_fileW(body_path, body, body_len)) DeleteFileW(meta_path);
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
        wchar_t meta_path[MAX_PATH], body_path[MAX_PATH];
        cache_path_for(url, L".meta", meta_path, MAX_PATH);
        cache_path_for(url, L".body", body_path, MAX_PATH);
        DeleteFileW(meta_path);
        DeleteFileW(body_path);
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

static int is_brotli(const char *response) {
    const char *ce = strstr(response, "Content-Encoding:");
    if (!ce) ce = strstr(response, "content-encoding:");
    if (!ce) return 0;
    ce += 17;
    while (*ce == ' ') ce++;
    return strncmp(ce, "br", 2) == 0 && (ce[2] == '\r' || ce[2] == '\n' || ce[2] == ' ' || ce[2] == '\0');
}

static int decompress_brotli_body(char **response, size_t *total) {
    char *body = strstr(*response, "\r\n\r\n");
    if (!body) return 0;
    body += 4;

    size_t header_len = body - *response;
    size_t body_len = *total - header_len;
    if (body_len == 0) return 0;

    BrotliDecoderState *state = BrotliDecoderCreateInstance(NULL, NULL, NULL);
    if (!state) return 0;

    size_t available_in = body_len;
    const uint8_t *next_in = (uint8_t *)body;
    size_t buf_cap = body_len * 2 + 1024;
    uint8_t *buf = malloc(buf_cap);
    if (!buf) { BrotliDecoderDestroyInstance(state); return 0; }
    size_t total_out = 0;

    BrotliDecoderResult result;
    do {
        size_t available_out = buf_cap - total_out;
        uint8_t *next_out = buf + total_out;
        result = BrotliDecoderDecompressStream(state, &available_in, &next_in,
                                               &available_out, &next_out, &total_out);
        if (result == BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT) {
            buf_cap *= 2;
            uint8_t *new_buf = realloc(buf, buf_cap);
            if (!new_buf) { free(buf); BrotliDecoderDestroyInstance(state); return 0; }
            buf = new_buf;
        }
    } while (result == BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT);

    BrotliDecoderDestroyInstance(state);

    if (result != BROTLI_DECODER_RESULT_SUCCESS) { free(buf); return 0; }

    size_t new_total = header_len + total_out;
    char *new_response = realloc(*response, new_total + 1);
    if (!new_response) { free(buf); return 0; }
    *response = new_response;

    memcpy(*response + header_len, buf, total_out);
    (*response)[new_total] = '\0';
    *total = new_total;

    free(buf);
    return 1;
}

// ── Unified I/O helpers for HTTP and HTTPS ──

static inline int http_send(SOCKET sock, WOLFSSL* ssl, const char* data, int len) {
    return ssl ? wolfSSL_write(ssl, data, len) : send(sock, data, len, 0);
}

static inline int http_recv(SOCKET sock, WOLFSSL* ssl, char* buf, int len) {
    return ssl ? wolfSSL_read(ssl, buf, len) : recv(sock, buf, len, 0);
}

static char* read_http_response(SOCKET sock, WOLFSSL* ssl, size_t* out_total) {
    size_t cap = 65536;
    char* response = malloc(cap);
    if (!response) return NULL;

    size_t total = 0;
    char buffer[4096];
    int received;

    while ((received = http_recv(sock, ssl, buffer, sizeof(buffer))) > 0) {
        if (total + received > cap) {
            do { cap *= 2; } while (total + received > cap);
            char* new_resp = realloc(response, cap);
            if (!new_resp) { free(response); return NULL; }
            response = new_resp;
        }
        memcpy(response + total, buffer, received);
        total += received;
    }

    response[total] = '\0';
    *out_total = total;
    return response;
}

// ── HTTP(S) client ──

char* http_get_sync(const char* url) {
    char scheme[16] = {0};
    char host[256] = {0};
    char path[1024] = {0};
    int port = 80;

    if (!parse_url(url, scheme, sizeof(scheme), host, sizeof(host), &port, path, sizeof(path)))
        return NULL;

    char* cached = read_cache(url);
    if (cached) return cached;

    int is_https = is_https_url(url);

    struct addrinfo hints, *res, *rp;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    if (getaddrinfo(host, NULL, &hints, &res) != 0)
        return NULL;

    SOCKET sock = INVALID_SOCKET;
    for (rp = res; rp; rp = rp->ai_next) {
        sock = socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol);
        if (sock == INVALID_SOCKET) continue;

        if (rp->ai_family == AF_INET)
            ((struct sockaddr_in*)rp->ai_addr)->sin_port = htons(port);
        else if (rp->ai_family == AF_INET6)
            ((struct sockaddr_in6*)rp->ai_addr)->sin6_port = htons(port);

        if (connect(sock, rp->ai_addr, (int)rp->ai_addrlen) == 0)
            break;
        closesocket(sock);
    }
    freeaddrinfo(res);
    if (rp == NULL) return NULL;

    WOLFSSL* ssl = NULL;
    WOLFSSL_CTX* ctx = NULL;
    if (is_https) {
        WOLFSSL_METHOD* method = wolfTLSv1_2_client_method();
        ctx = wolfSSL_CTX_new(method);
        if (!ctx) { closesocket(sock); return NULL; }
        wolfSSL_CTX_set_verify(ctx, SSL_VERIFY_NONE, NULL);
        ssl = wolfSSL_new(ctx);
        if (!ssl) { wolfSSL_CTX_free(ctx); closesocket(sock); return NULL; }
        wolfSSL_set_fd(ssl, sock);
        wolfSSL_UseSNI(ssl, WOLFSSL_SNI_HOST_NAME, host, strlen(host));
        if (wolfSSL_connect(ssl) != SSL_SUCCESS) {
            wolfSSL_free(ssl); wolfSSL_CTX_free(ctx); closesocket(sock);
            return NULL;
        }
    }

    int default_port = is_https ? 443 : 80;
    char host_header[512];
    if (port != default_port)
        snprintf(host_header, sizeof(host_header), "%s:%d", host, port);
    else
        snprintf(host_header, sizeof(host_header), "%s", host);

    char request[2048];
    snprintf(request, sizeof(request),
             "GET %s HTTP/1.1\r\n"
             "Host: %s\r\n"
             "User-Agent: QuickJS/1.0\r\n"
             "Accept-Encoding: br\r\n"
             "Connection: close\r\n"
             "\r\n",
             path, host_header);

    if (http_debug)
        fprintf(stderr, "---[ HTTP request ]---\n%s\n", request);

    char* result = NULL;
    char* response = NULL;
    size_t total = 0;

    if (http_send(sock, ssl, request, strlen(request)) <= 0)
        goto done;

    response = read_http_response(sock, ssl, &total);
    if (!response) goto done;

    if (http_debug) {
        char* hdr_end = strstr(response, "\r\n\r\n");
        if (hdr_end)
            fprintf(stderr, "---[ HTTP response ]---\n%.*s\n", (int)(hdr_end - response), response);
        else
            fprintf(stderr, "---[ HTTP response ]---\n%s\n", response);
    }

    if (is_chunked(response))
        decode_chunked(response, &total);

    if (is_brotli(response)) {
        if (!decompress_brotli_body(&response, &total))
            goto done;
    }

    try_cache_response(url, response, total);
    result = extract_body(response);

done:
    if (!result) free(response);
    if (ssl) { wolfSSL_shutdown(ssl); wolfSSL_free(ssl); }
    if (ctx) wolfSSL_CTX_free(ctx);
    closesocket(sock);
    return result;
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

    if (is_http_url(name) || is_https_url(name) || (name[0] != '.' && name[0] != '/')) {
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