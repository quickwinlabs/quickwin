#include <winsock2.h>
#include <windows.h>
#include <shellapi.h>
#include <commctrl.h>
#include <stdio.h>
#include <stdlib.h>

#include "quickjs.h"
#include "quickjs-libc.h"
#include "quickjs-win.h"
#include "quickjs-ffi.h"
#include "quickjs-brotli.h"
#include "quickjs-sock.h"
#include "quickjs-http.h"
#include "quickjs-wolfssl.h"
#include "quickjs-gui.h"
#include "quickjs-wamr.h"
#include "quickjs-async-task.h"

#include <wolfssl/options.h>
#include <wolfssl/ssl.h>

static void showError(JSContext *ctx, const char *err_str)
{
    printf("JS Error: %s\n", err_str);
    fflush(stdout);
    int len = MultiByteToWideChar(CP_UTF8, 0, err_str, -1, NULL, 0);
    wchar_t *werr = malloc(len * sizeof(wchar_t));
    MultiByteToWideChar(CP_UTF8, 0, err_str, -1, werr, len);
    wchar_t wtitle[64] = L"JS Error";
    // MessageBoxW(NULL, werr, wtitle, MB_OK);
    free(werr);
}

static JSContext *JS_NewCustomContext(JSRuntime *rt)
{
    JSContext *ctx;
    ctx = JS_NewContext(rt);
    if (!ctx)
        return NULL;
    /* system modules */
    js_init_module_std(ctx, "std");
    js_init_module_os(ctx, "os");

    js_init_module_win(ctx);
    js_init_module_ffi(ctx);
    js_init_module_brotli(ctx);
    js_init_module_sock(ctx);
    js_init_module_wolfssl(ctx);
    js_init_module_wamr(ctx);
    js_init_http_cache_api(ctx);
    return ctx;
}

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPSTR lpCmdLine, int nCmdShow)
{
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);

    wolfSSL_Init();

    INITCOMMONCONTROLSEX icex = { sizeof(INITCOMMONCONTROLSEX), ICC_WIN95_CLASSES };
    InitCommonControlsEx(&icex);
#if _WIN32_WINNT >= 0x0600
    SetProcessDPIAware();
#endif

    int cmd_argc = 0;
    char **cmd_argv = NULL;
    LPWSTR *wargv = CommandLineToArgvW(GetCommandLineW(), &cmd_argc);
    if (wargv && cmd_argc > 0) {
        cmd_argv = malloc((cmd_argc + 1) * sizeof(char *));
        for (int i = 0; i < cmd_argc; i++) {
            int len = WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, NULL, 0, NULL, NULL);
            cmd_argv[i] = malloc(len);
            WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, cmd_argv[i], len, NULL, NULL);
        }
        cmd_argv[cmd_argc] = NULL;
        LocalFree(wargv);
    }
    int optind = 1;
    char *expr = NULL;
    while (optind < cmd_argc && cmd_argv[optind][0] == '-') {
        char *arg = cmd_argv[optind];
        if (strcmp(arg, "--") == 0) { optind++; break; }
        if (strcmp(arg, "-e") == 0) {
            optind++;
            if (optind >= cmd_argc) {
                fprintf(stderr, "Missing expression for -e\n");
                return 2;
            }
            expr = cmd_argv[optind++];
            continue;
        }
        if (strcmp(arg, "-d") == 0) {
            http_debug = 1;
            optind++;
            continue;
        }
        fprintf(stderr, "Unknown option: %s\n", arg);
        return 2;
    }
    const char *js_file = "main.js";
    if (optind < cmd_argc) {
        js_file = cmd_argv[optind];
        for (char *p = cmd_argv[optind]; *p; p++)
            if (*p == '\\') *p = '/';
    }

    JSRuntime *rt = JS_NewRuntime();
    js_async_task_init(rt);
    js_sock_init(rt);
    
    js_std_set_worker_new_context_func(JS_NewCustomContext);
    js_std_init_handlers(rt);
    JS_SetModuleLoaderFunc2(rt, js_module_normalize_name, js_module_loader, NULL, NULL);
    // JS_SetModuleLoaderFunc2(rt, NULL, js_module_loader, NULL, NULL);
    JSContext *ctx = JS_NewCustomContext(rt);
    g_ctx = ctx;

    js_init_module_gui(ctx);

    js_std_add_helpers(ctx, cmd_argc - optind, cmd_argv + optind);

    size_t fsize;
    uint8_t *js_code;
    if (expr) {
        js_code = (uint8_t *)js_malloc(ctx, strlen(expr) + 1);
        memcpy(js_code, expr, strlen(expr) + 1);
        fsize = strlen(expr);
        js_file = "<eval>";
    } else {
        js_code = js_load_file(ctx, &fsize, js_file);
    }

    if (!js_code) {
        char msg[256];
        snprintf(msg, sizeof(msg), "Failed to load '%s'", js_file);
        printf("Error: %s\n", msg);
        fflush(stdout);
        int len = MultiByteToWideChar(CP_UTF8, 0, msg, -1, NULL, 0);
        wchar_t *wmsg = malloc(len * sizeof(wchar_t));
        MultiByteToWideChar(CP_UTF8, 0, msg, -1, wmsg, len);
        // MessageBoxW(NULL, wmsg, L"Error", MB_OK);
        free(wmsg);
        if (cmd_argv) {
            for (int i = 0; i < cmd_argc; i++) free(cmd_argv[i]);
            free(cmd_argv);
        }
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        return 1;
    }

    JSValue result = JS_Eval(ctx, js_code, fsize, js_file, JS_EVAL_TYPE_MODULE);
    if (JS_IsException(result))
    {
        JSValue err = JS_GetException(ctx);
        const char *err_str = JS_ToCString(ctx, err);
        showError(ctx, err_str);
        JS_FreeCString(ctx, err_str);
        JS_FreeValue(ctx, err);
        JS_FreeValue(ctx, result);
        js_free(ctx, js_code);
        if (cmd_argv) {
            for (int i = 0; i < cmd_argc; i++) free(cmd_argv[i]);
            free(cmd_argv);
        }
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        return 1;
    }
    JS_FreeValue(ctx, result);
    js_free(ctx, js_code);
    
    js_std_loop(ctx);

    gui_cleanup();
    js_std_free_handlers(rt);
    js_sock_free_handles(rt);
    js_async_task_destroy(rt);
    js_async_task_cleanup();
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    if (cmd_argv) {
        for (int i = 0; i < cmd_argc; i++) free(cmd_argv[i]);
        free(cmd_argv);
    }
    js_wamr_cleanup(rt);
    wolfSSL_Cleanup();
    WSACleanup();
    return 0;
}