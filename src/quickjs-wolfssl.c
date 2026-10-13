#include <winsock2.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"
#include "quickjs-wolfssl.h"
#include "quickjs-args.h"

#include <wolfssl/options.h>
#include <wolfssl/ssl.h>

#ifndef countof
#define countof(x) (sizeof(x) / sizeof((x)[0]))
#endif

static JSValue js_wolfSSL_library_init(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int ret = wolfSSL_library_init();
    return JS_NewInt32(ctx, ret);
}

static JSValue js_wolfSSLv23_client_method(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    WOLFSSL_METHOD *method = wolfSSLv23_client_method();
    return JS_NewInt64(ctx, (int64_t)(size_t)method);
}

static JSValue js_wolfTLSv1_2_client_method(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    WOLFSSL_METHOD *method = wolfTLSv1_2_client_method();
    return JS_NewInt64(ctx, (int64_t)(size_t)method);
}

static JSValue js_wolfTLSv1_3_client_method(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    /* This build has TLS1.3 disabled — no method pointer to return. */
    return JS_NewInt32(ctx, 0);
}

static JSValue js_wolfSSL_CTX_new(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t method_ptr;
    if (JS_ToInt64(ctx, &method_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "method pointer required");
    
    WOLFSSL_METHOD *method = (WOLFSSL_METHOD *)(size_t)method_ptr;
    WOLFSSL_CTX *ssl_ctx = wolfSSL_CTX_new(method);
    if (!ssl_ctx) return JS_NULL;
    return JS_NewInt64(ctx, (int64_t)(size_t)ssl_ctx);
}

static JSValue js_wolfSSL_CTX_free(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t ctx_ptr;
    if (JS_ToInt64(ctx, &ctx_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ctx pointer required");
    
    WOLFSSL_CTX *ssl_ctx = (WOLFSSL_CTX *)(size_t)ctx_ptr;
    wolfSSL_CTX_free(ssl_ctx);
    
    return JS_UNDEFINED;
}

static JSValue js_wolfSSL_new(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t ctx_ptr;
    if (JS_ToInt64(ctx, &ctx_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ctx pointer required");
    
    WOLFSSL_CTX *ssl_ctx = (WOLFSSL_CTX *)(size_t)ctx_ptr;
    WOLFSSL *ssl = wolfSSL_new(ssl_ctx);
    if (!ssl) return JS_NULL;
    return JS_NewInt64(ctx, (int64_t)(size_t)ssl);
}

static JSValue js_wolfSSL_free(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t ssl_ptr;
    if (JS_ToInt64(ctx, &ssl_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ssl pointer required");
    
    WOLFSSL *ssl = (WOLFSSL *)(size_t)ssl_ptr;
    wolfSSL_free(ssl);
    
    return JS_UNDEFINED;
}

static JSValue js_wolfSSL_set_fd(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t ssl_ptr;
    if (JS_ToInt64(ctx, &ssl_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ssl pointer required");
    int fd;
    if (JS_ToInt32(ctx, &fd, argv[1]))
        return JS_ThrowTypeError(ctx, "fd required");
    
    WOLFSSL *ssl = (WOLFSSL *)(size_t)ssl_ptr;
    int ret = wolfSSL_set_fd(ssl, fd);
    
    return JS_NewInt32(ctx, ret);
}

static JSValue js_wolfSSL_connect(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t ssl_ptr;
    if (JS_ToInt64(ctx, &ssl_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ssl pointer required");
    
    WOLFSSL *ssl = (WOLFSSL *)(size_t)ssl_ptr;
    int ret = wolfSSL_connect(ssl);
    
    return JS_NewInt32(ctx, ret);
}

static JSValue js_wolfSSL_read(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t ssl_ptr;

    if (JS_ToInt64(ctx, &ssl_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ssl pointer required");

    size_t size;
    uint8_t *buf = JS_GetArrayBuffer(ctx, &size, argv[1]);
    if (!buf)
        return JS_ThrowTypeError(ctx, "buf must be ArrayBuffer");

    WOLFSSL *ssl = (WOLFSSL *)(size_t)ssl_ptr;
    int ret = wolfSSL_read(ssl, buf, (int)size);

    /* Raw wolfSSL result: >0 bytes, 0 clean close, <0 error. The caller
     * interprets it via wolfSSL_get_error(ssl, ret). */
    return JS_NewInt32(ctx, ret);
}

static JSValue js_wolfSSL_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t ssl_ptr;
    
    if (JS_ToInt64(ctx, &ssl_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ssl pointer required");
    
    size_t size;
    uint8_t *buf = JS_GetArrayBuffer(ctx, &size, argv[1]);
    if (!buf)
        return JS_ThrowTypeError(ctx, "data must be ArrayBuffer");
    
    WOLFSSL *ssl = (WOLFSSL *)(size_t)ssl_ptr;
    int ret = wolfSSL_write(ssl, buf, (int)size);
    
    return JS_NewInt32(ctx, ret);
}

static JSValue js_wolfSSL_shutdown(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t ssl_ptr;
    if (JS_ToInt64(ctx, &ssl_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ssl pointer required");
    
    WOLFSSL *ssl = (WOLFSSL *)(size_t)ssl_ptr;
    int ret = wolfSSL_shutdown(ssl);
    
    return JS_NewInt32(ctx, ret);
}

static JSValue js_wolfSSL_get_error(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t ssl_ptr;
    if (JS_ToInt64(ctx, &ssl_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ssl pointer required");
    int ret;
    if (JS_ToInt32(ctx, &ret, argv[1]))
        return JS_ThrowTypeError(ctx, "ret required");
    
    WOLFSSL *ssl = (WOLFSSL *)(size_t)ssl_ptr;
    int err = wolfSSL_get_error(ssl, ret);
    
    return JS_NewInt32(ctx, err);
}

static JSValue js_wolfSSL_ERR_error_string(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    unsigned long err;
    
    if (JS_ToInt64(ctx, (int64_t*)&err, argv[0]))
        return JS_ThrowTypeError(ctx, "error code required");
    
    char buf[256];
    char *str = wolfSSL_ERR_error_string(err, buf);
    
    return JS_NewString(ctx, str ? str : "");
}

static JSValue js_wolfSSL_CTX_set_verify(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t ctx_ptr;
    if (JS_ToInt64(ctx, &ctx_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ctx pointer required");
    int mode;
    if (JS_ToInt32(ctx, &mode, argv[1]))
        return JS_ThrowTypeError(ctx, "mode required");
    
    WOLFSSL_CTX *ssl_ctx = (WOLFSSL_CTX *)(size_t)ctx_ptr;
    wolfSSL_CTX_set_verify(ssl_ctx, mode, NULL);
    
    return JS_UNDEFINED;
}

/* Process-wide trusted CA store: fixed slots, append-only, guarded by a
 * zero-init spin lock (a PEM memcpy or short read is too short to block on
 * a real mutex). Process scope is deliberate: worker threads run their own
 * contexts and would never reach the JS-side registration code. Rationale
 * for the design lives in .agents/TLS_TRUST_STORE.md. */

#define QW_CA_SLOTS 8

typedef struct {
    unsigned char *data;
    size_t len;
} QwCaEntry;

static QwCaEntry g_ca_entries[QW_CA_SLOTS];
static int g_ca_count = 0;
static volatile LONG g_ca_lock = 0;

static void qw_ca_lock(void)
{
    while (InterlockedCompareExchange(&g_ca_lock, 1L, 0L) != 0)
        Sleep(1);
}

static void qw_ca_unlock(void)
{
    InterlockedExchange(&g_ca_lock, 0L);
}

static int qw_ca_is_empty(const char *p, size_t len)
{
    size_t i;
    for (i = 0; i < len; i++)
        if (p[i] != ' ' && p[i] != '\t' && p[i] != '\r' && p[i] != '\n')
            return 0;
    return len == 0;
}

int qw_ca_store_add(const char *pem, size_t len)
{
    unsigned char *dup;
    int n = -1;

    if (!pem || len == 0 || qw_ca_is_empty(pem, len))
        return -1;

    dup = (unsigned char *)malloc(len);
    if (!dup)
        return -1;
    memcpy(dup, pem, len);

    qw_ca_lock();
    if (g_ca_count < QW_CA_SLOTS) {
        g_ca_entries[g_ca_count].data = dup;
        g_ca_entries[g_ca_count].len = len;
        g_ca_count++;
        n = g_ca_count;
    }
    qw_ca_unlock();

    if (n < 0)
        free(dup);
    return n;
}

int qw_tls_load_trusted_certs(void *ctxp)
{
    WOLFSSL_CTX *ctx = (WOLFSSL_CTX *)ctxp;
    int i, loaded = 0;

    if (!ctx)
        return -1;

    (void)wolfSSL_CTX_load_system_CA_certs(ctx);

    qw_ca_lock();
    for (i = 0; i < g_ca_count; i++) {
        if (wolfSSL_CTX_load_verify_buffer(ctx, g_ca_entries[i].data,
                                           (long)g_ca_entries[i].len,
                                           WOLFSSL_FILETYPE_PEM) == WOLFSSL_SUCCESS)
            loaded++;
    }
    qw_ca_unlock();
    return loaded;
}

static JSValue js_wolf_ca_store_add(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *pem;
    size_t len;
    int n;

    (void)this_val; (void)argc;
    pem = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!pem)
        return JS_EXCEPTION;
    n = qw_ca_store_add(pem, len);
    JS_FreeCString(ctx, pem);
    /* n: new entry count (1..QW_CA_SLOTS), or -1 for empty PEM / full store.
     * The throw-vs-fail decision belongs to the JS caller. */
    return JS_NewInt32(ctx, n);
}

static JSValue js_wolf_tls_load_trusted_certs(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t ctx_ptr;

    (void)this_val; (void)argc;
    if (JS_ToInt64(ctx, &ctx_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ctx pointer required");
    return JS_NewInt32(ctx, qw_tls_load_trusted_certs((void *)(size_t)ctx_ptr));
}

static JSValue js_wolfSSL_CTX_load_verify_locations(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t ctx_ptr;
    
    if (JS_ToInt64(ctx, &ctx_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ctx pointer required");
    
    const char *ca_file = JS_IsUndefined(argv[1]) ? NULL : JS_ToCString(ctx, argv[1]);
    const char *ca_path = JS_IsUndefined(argv[2]) ? NULL : JS_ToCString(ctx, argv[2]);
    
    WOLFSSL_CTX *ssl_ctx = (WOLFSSL_CTX *)(size_t)ctx_ptr;
    int ret = wolfSSL_CTX_load_verify_locations(ssl_ctx, ca_file, ca_path);
    
    if (ca_file) JS_FreeCString(ctx, ca_file);
    if (ca_path) JS_FreeCString(ctx, ca_path);
    
    return JS_NewInt32(ctx, ret);
}

static JSValue js_wolfSSL_CTX_use_certificate_file(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t ctx_ptr;
    
    if (JS_ToInt64(ctx, &ctx_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ctx pointer required");
    
    const char *file = JS_ToCString(ctx, argv[1]);
    if (!file)
        return JS_ThrowTypeError(ctx, "file path required");
    
    GET_INT32_OPT(ctx, argv[2], type, SSL_FILETYPE_PEM);
    
    WOLFSSL_CTX *ssl_ctx = (WOLFSSL_CTX *)(size_t)ctx_ptr;
    int ret = wolfSSL_CTX_use_certificate_file(ssl_ctx, file, type);
    
    JS_FreeCString(ctx, file);
    
    return JS_NewInt32(ctx, ret);
}

static JSValue js_wolfSSL_CTX_use_PrivateKey_file(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t ctx_ptr;
    
    if (JS_ToInt64(ctx, &ctx_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ctx pointer required");
    
    const char *file = JS_ToCString(ctx, argv[1]);
    if (!file)
        return JS_ThrowTypeError(ctx, "file path required");
    
    GET_INT32_OPT(ctx, argv[2], type, SSL_FILETYPE_PEM);
    
    WOLFSSL_CTX *ssl_ctx = (WOLFSSL_CTX *)(size_t)ctx_ptr;
    int ret = wolfSSL_CTX_use_PrivateKey_file(ssl_ctx, file, type);
    
    JS_FreeCString(ctx, file);
    
    return JS_NewInt32(ctx, ret);
}

static JSValue js_wolfSSL_UseSNI(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t ssl_ptr;
    if (JS_ToInt64(ctx, &ssl_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ssl pointer required");
    int type;
    if (JS_ToInt32(ctx, &type, argv[1]))
        return JS_ThrowTypeError(ctx, "type required");
    
    const char *data = JS_ToCString(ctx, argv[2]);
    if (!data)
        return JS_ThrowTypeError(ctx, "data required");
    
    size_t size = strlen(data);
    
    WOLFSSL *ssl = (WOLFSSL *)(size_t)ssl_ptr;
    int ret = wolfSSL_UseSNI(ssl, (unsigned char)type, data, (unsigned short)size);
    
    JS_FreeCString(ctx, data);
    
    return JS_NewInt32(ctx, ret);
}

static JSValue js_wolfSSL_check_domain_name(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc;
    int64_t ssl_ptr;
    if (JS_ToInt64(ctx, &ssl_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ssl pointer required");

    const char *name = JS_ToCString(ctx, argv[1]);
    if (!name)
        return JS_ThrowTypeError(ctx, "domain name required");

    WOLFSSL *ssl = (WOLFSSL *)(size_t)ssl_ptr;
    int ret = wolfSSL_check_domain_name(ssl, name);

    JS_FreeCString(ctx, name);

    return JS_NewInt32(ctx, ret);
}

static const JSCFunctionListEntry wolfssl_funcs[] = {
    JS_CFUNC_DEF("wolfSSL_library_init", 0, js_wolfSSL_library_init),
    JS_CFUNC_DEF("wolfSSLv23_client_method", 0, js_wolfSSLv23_client_method),
    JS_CFUNC_DEF("wolfTLSv1_2_client_method", 0, js_wolfTLSv1_2_client_method),
    JS_CFUNC_DEF("wolfTLSv1_3_client_method", 0, js_wolfTLSv1_3_client_method),
    JS_CFUNC_DEF("wolfSSL_CTX_new", 1, js_wolfSSL_CTX_new),
    JS_CFUNC_DEF("wolfSSL_CTX_free", 1, js_wolfSSL_CTX_free),
    JS_CFUNC_DEF("wolfSSL_new", 1, js_wolfSSL_new),
    JS_CFUNC_DEF("wolfSSL_free", 1, js_wolfSSL_free),
    JS_CFUNC_DEF("wolfSSL_set_fd", 2, js_wolfSSL_set_fd),
    JS_CFUNC_DEF("wolfSSL_connect", 1, js_wolfSSL_connect),
    JS_CFUNC_DEF("wolfSSL_read", 1, js_wolfSSL_read),
    JS_CFUNC_DEF("wolfSSL_write", 2, js_wolfSSL_write),
    JS_CFUNC_DEF("wolfSSL_shutdown", 1, js_wolfSSL_shutdown),
    JS_CFUNC_DEF("wolfSSL_get_error", 2, js_wolfSSL_get_error),
    JS_CFUNC_DEF("wolfSSL_ERR_error_string", 1, js_wolfSSL_ERR_error_string),
    JS_CFUNC_DEF("wolfSSL_CTX_set_verify", 2, js_wolfSSL_CTX_set_verify),
    JS_CFUNC_DEF("wolfSSL_CTX_load_verify_locations", 3, js_wolfSSL_CTX_load_verify_locations),
    JS_CFUNC_DEF("wolfSSL_CTX_use_certificate_file", 2, js_wolfSSL_CTX_use_certificate_file),
    JS_CFUNC_DEF("wolfSSL_CTX_use_PrivateKey_file", 2, js_wolfSSL_CTX_use_PrivateKey_file),
    JS_CFUNC_DEF("wolfSSL_UseSNI", 3, js_wolfSSL_UseSNI),
    JS_CFUNC_DEF("wolfSSL_check_domain_name", 2, js_wolfSSL_check_domain_name),
    JS_CFUNC_DEF("addTrustedCA", 1, js_wolf_ca_store_add),
    JS_CFUNC_DEF("loadTrustedCerts", 1, js_wolf_tls_load_trusted_certs),
};

static int wolfssl_init(JSContext *ctx, JSModuleDef *m)
{
    return JS_SetModuleExportList(ctx, m, wolfssl_funcs, countof(wolfssl_funcs));
}

JSModuleDef *js_init_module_wolfssl(JSContext *ctx)
{
    JSModuleDef *m = JS_NewCModule(ctx, "wolfssl", wolfssl_init);
    if (!m)
        return NULL;
    JS_AddModuleExportList(ctx, m, wolfssl_funcs, countof(wolfssl_funcs));
    return m;
}