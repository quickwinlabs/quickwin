#ifndef QUICKJS_WOLFSSL_H
#define QUICKJS_WOLFSSL_H

#include <stddef.h>
#include "quickjs.h"

JSModuleDef *js_init_module_wolfssl(JSContext *ctx);

/* Process-wide trusted CA store, fixed QW_CA_SLOTS slots. PEM text is
 * pushed from JS via wolfssl.addTrustedCA(); qw_tls_load_trusted_certs()
 * loads the OS CA store plus every entry into the given WOLFSSL_CTX* and
 * returns the number of store entries loaded. Shared across contexts and
 * worker threads, which is what lets the C module loader (quickjs-http.c)
 * pick up the bundle without its own JS-side registration. */
int qw_ca_store_add(const char *pem, size_t len);
int qw_tls_load_trusted_certs(void *ctx);

#endif