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

static char *wideToUtf8(const wchar_t *utf16)
{
    int len = WideCharToMultiByte(CP_UTF8, 0, utf16, -1, NULL, 0, NULL, NULL);
    char *utf8 = malloc(len * sizeof(char));
    WideCharToMultiByte(CP_UTF8, 0, utf16, -1, utf8, len, NULL, NULL);
    return utf8;
}

static JSValue js_GetModuleFileName(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    HMODULE hModule = NULL;
    if (argc > 0 && !JS_IsUndefined(argv[0]))
    {
        int64_t h;
        JS_ToInt64(ctx, &h, argv[0]);
        hModule = (HMODULE)h;
    }
    wchar_t path[MAX_PATH];
    DWORD len = GetModuleFileNameW(hModule, path, MAX_PATH);
    if (len == 0)
        return JS_UNDEFINED;
    char *utf8 = wideToUtf8(path);
    JSValue ret = JS_NewString(ctx, utf8);
    free(utf8);
    return ret;
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
    JS_CFUNC_DEF("GetModuleFileName", 0, js_GetModuleFileName),
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