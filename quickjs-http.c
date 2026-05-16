#include <winsock2.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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

char* http_get_sync(const char* url) {
    char scheme[16] = {0};
    char host[256] = {0};
    char path[1024] = {0};
    int port = 80;

    if (!parse_url(url, scheme, sizeof(scheme), host, sizeof(host), &port, path, sizeof(path))) {
        return NULL;
    }

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