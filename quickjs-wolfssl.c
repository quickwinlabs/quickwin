#include <winsock2.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"
#include "quickjs-wolfssl.h"

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
    return JS_ThrowTypeError(ctx, "TLSv1.3 not supported in this wolfSSL build");
}

static JSValue js_wolfSSL_CTX_new(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t method_ptr;
    if (JS_ToInt64(ctx, &method_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "method pointer required");
    
    WOLFSSL_METHOD *method = (WOLFSSL_METHOD *)(size_t)method_ptr;
    WOLFSSL_CTX *ssl_ctx = wolfSSL_CTX_new(method);
    
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
    int fd;
    
    if (JS_ToInt64(ctx, &ssl_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ssl pointer required");
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
    int size = 4096;
    
    if (JS_ToInt64(ctx, &ssl_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ssl pointer required");
    
    if (argc > 1 && !JS_IsUndefined(argv[1])) {
        JS_ToInt32(ctx, &size, argv[1]);
    }
    
    WOLFSSL *ssl = (WOLFSSL *)(size_t)ssl_ptr;
    uint8_t *buf = malloc(size);
    if (!buf)
        return JS_ThrowTypeError(ctx, "Out of memory");
    
    int ret = wolfSSL_read(ssl, buf, size);
    if (ret <= 0) {
        free(buf);
        return JS_NewInt32(ctx, ret);
    }
    
    JSValue arr = JS_NewArrayBufferCopy(ctx, buf, ret);
    free(buf);
    
    return arr;
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
    int ret;
    
    if (JS_ToInt64(ctx, &ssl_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ssl pointer required");
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
    int mode;
    
    if (JS_ToInt64(ctx, &ctx_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ctx pointer required");
    if (JS_ToInt32(ctx, &mode, argv[1]))
        return JS_ThrowTypeError(ctx, "mode required");
    
    WOLFSSL_CTX *ssl_ctx = (WOLFSSL_CTX *)(size_t)ctx_ptr;
    wolfSSL_CTX_set_verify(ssl_ctx, mode, NULL);
    
    return JS_UNDEFINED;
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
    int type = SSL_FILETYPE_PEM;
    
    if (JS_ToInt64(ctx, &ctx_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ctx pointer required");
    
    const char *file = JS_ToCString(ctx, argv[1]);
    if (!file)
        return JS_ThrowTypeError(ctx, "file path required");
    
    if (argc > 2 && !JS_IsUndefined(argv[2])) {
        JS_ToInt32(ctx, &type, argv[2]);
    }
    
    WOLFSSL_CTX *ssl_ctx = (WOLFSSL_CTX *)(size_t)ctx_ptr;
    int ret = wolfSSL_CTX_use_certificate_file(ssl_ctx, file, type);
    
    JS_FreeCString(ctx, file);
    
    return JS_NewInt32(ctx, ret);
}

static JSValue js_wolfSSL_CTX_use_PrivateKey_file(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t ctx_ptr;
    int type = SSL_FILETYPE_PEM;
    
    if (JS_ToInt64(ctx, &ctx_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ctx pointer required");
    
    const char *file = JS_ToCString(ctx, argv[1]);
    if (!file)
        return JS_ThrowTypeError(ctx, "file path required");
    
    if (argc > 2 && !JS_IsUndefined(argv[2])) {
        JS_ToInt32(ctx, &type, argv[2]);
    }
    
    WOLFSSL_CTX *ssl_ctx = (WOLFSSL_CTX *)(size_t)ctx_ptr;
    int ret = wolfSSL_CTX_use_PrivateKey_file(ssl_ctx, file, type);
    
    JS_FreeCString(ctx, file);
    
    return JS_NewInt32(ctx, ret);
}

static JSValue js_wolfSSL_UseSNI(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t ssl_ptr;
    int type;
    
    if (JS_ToInt64(ctx, &ssl_ptr, argv[0]))
        return JS_ThrowTypeError(ctx, "ssl pointer required");
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