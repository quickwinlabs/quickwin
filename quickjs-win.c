#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"
#include "quickjs-win.h"

static wchar_t *utf8ToWide(const char *utf8)
{
    int len = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, NULL, 0);
    wchar_t *w = malloc(len * sizeof(wchar_t));
    MultiByteToWideChar(CP_UTF8, 0, utf8, -1, w, len);
    return w;
}

static JSValue js_LoadLibrary(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *libName = JS_ToCString(ctx, argv[0]);
    wchar_t *wlibName = utf8ToWide(libName);
    HMODULE hModule = LoadLibraryW(wlibName);
    free(wlibName);
    JS_FreeCString(ctx, libName);
    if (hModule)
    {
        return JS_NewInt64(ctx, (int64_t)hModule);
    }
    return JS_NULL;
}

static JSValue js_GetProcAddress(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t hModule;
    JS_ToInt64(ctx, &hModule, argv[0]);
    const char *procName = JS_ToCString(ctx, argv[1]);
    FARPROC proc = GetProcAddress((HMODULE)hModule, procName);
    JS_FreeCString(ctx, procName);
    if (proc)
    {
        return JS_NewInt64(ctx, (int64_t)proc);
    }
    return JS_NULL;
}

static JSValue js_FreeLibrary(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t hModule;
    JS_ToInt64(ctx, &hModule, argv[0]);
    BOOL result = FreeLibrary((HMODULE)hModule);
    return JS_NewBool(ctx, result);
}

static const JSCFunctionListEntry win_funcs[] = {
    JS_CFUNC_DEF("LoadLibrary", 1, js_LoadLibrary),
    JS_CFUNC_DEF("GetProcAddress", 2, js_GetProcAddress),
    JS_CFUNC_DEF("FreeLibrary", 1, js_FreeLibrary),
};

static int js_win_init(JSContext *ctx, JSModuleDef *m)
{
    JS_SetModuleExportList(ctx, m, win_funcs, sizeof(win_funcs) / sizeof(win_funcs[0]));
    return 0;
}

JSModuleDef *js_init_module_win(JSContext *ctx)
{
    JSModuleDef *m;
    m = JS_NewCModule(ctx, "win", js_win_init);
    if (!m)
        return NULL;
    JS_AddModuleExportList(ctx, m, win_funcs, sizeof(win_funcs) / sizeof(win_funcs[0]));
    return m;
}