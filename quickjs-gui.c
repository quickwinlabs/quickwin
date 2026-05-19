#include <windows.h>
#include <commctrl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs-gui.h"

JSContext *g_ctx = NULL;

#define MAX_WINDOWS 64
typedef struct {
    HWND hWnd;
    JSValue proc;
} WindowEntry;
static WindowEntry g_windows[MAX_WINDOWS];
static int g_windowCount = 0;

#define MAX_CLASSES 128
typedef struct {
    char className[32];
    JSValue proc;
} ClassEntry;
static ClassEntry g_classes[MAX_CLASSES];
static int g_classCount = 0;

void gui_cleanup(void)
{
    for (int i = 0; i < g_windowCount; i++)
    {
        JS_FreeValue(g_ctx, g_windows[i].proc);
    }
    g_windowCount = 0;
    
    for (int i = 0; i < g_classCount; i++)
    {
        JS_FreeValue(g_ctx, g_classes[i].proc);
    }
    g_classCount = 0;
}

static int findWindowIndex(HWND hwnd)
{
    for (int i = 0; i < g_windowCount; i++)
    {
        if (g_windows[i].hWnd == hwnd)
            return i;
    }
    return -1;
}

static JSValue findClassProc(const char *className)
{
    for (int i = 0; i < g_classCount; i++)
    {
        if (strcmp(g_classes[i].className, className) == 0)
        {
            return g_classes[i].proc;
        }
    }
    return JS_UNDEFINED;
}

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

static void showError(const char *err_str)
{
    wchar_t *werr = utf8ToWide(err_str);
    wchar_t wtitle[64] = L"JS Error";
    MessageBoxW(NULL, werr, wtitle, MB_OK);
    free(werr);
}

static HWND toHWND(JSContext *ctx, JSValueConst v)
{
    if (JS_IsNull(v) || JS_IsUndefined(v))
        return NULL;
    int64_t val;
    JS_ToInt64(ctx, &val, v);
    return (HWND)val;
}

static HMENU toHMENU(JSContext *ctx, JSValueConst v)
{
    if (JS_IsNull(v) || JS_IsUndefined(v))
        return NULL;
    int64_t val;
    JS_ToInt64(ctx, &val, v);
    return (HMENU)val;
}

LRESULT CALLBACK ProxyWndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    int idx = findWindowIndex(hWnd);
    JSValue wndProc = JS_UNDEFINED;
    if (idx >= 0 && !JS_IsUndefined(g_windows[idx].proc))
    {
        wndProc = g_windows[idx].proc;
    }
    else
    {
        wchar_t classNameW[64];
        if (GetClassNameW(hWnd, classNameW, 64) > 0)
        {
            char className[64];
            WideCharToMultiByte(CP_UTF8, 0, classNameW, -1, className, sizeof(className), NULL, NULL);
            wndProc = findClassProc(className);
        }
    }
    if (JS_IsUndefined(wndProc))
        return DefWindowProcW(hWnd, msg, wParam, lParam);

    JSValue argv[4] = {
        JS_NewInt64(g_ctx, (int64_t)hWnd),
        JS_NewInt32(g_ctx, msg),
        JS_NewInt64(g_ctx, wParam),
        JS_NewInt64(g_ctx, lParam)};

    JSValue ret = JS_Call(g_ctx, wndProc, JS_UNDEFINED, 4, argv);

    if (JS_IsException(ret))
    {
        JSValue err = JS_GetException(g_ctx);
        const char *err_str = JS_ToCString(g_ctx, err);
        showError(err_str);
        JS_FreeCString(g_ctx, err_str);
        JS_FreeValue(g_ctx, err);
        JS_FreeValue(g_ctx, ret);
        return DefWindowProcW(hWnd, msg, wParam, lParam);
    }

    LRESULT result = 0;
    JS_ToInt64(g_ctx, &result, ret);
    JS_FreeValue(g_ctx, ret);
    return result;
}

static JSValue js_registerClass(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *className = JS_ToCString(ctx, argv[0]);
    wchar_t *wclassName = utf8ToWide(className);

    JSValue wndProc = JS_UNDEFINED;
    if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1]))
    {
        wndProc = JS_DupValue(ctx, argv[1]);
        if (g_classCount < MAX_CLASSES)
        {
            strcpy(g_classes[g_classCount].className, className);
            g_classes[g_classCount].proc = wndProc;
            g_classCount++;
        }
        else
        {
            JS_FreeValue(ctx, wndProc);
        }
    }

    WNDCLASSEXW wc = {0};
    wc.cbSize = sizeof(WNDCLASSEXW);
    wc.style = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc = ProxyWndProc;
    wc.hInstance = GetModuleHandleW(NULL);
    wc.hCursor = LoadCursorW(NULL, (LPCWSTR)IDC_ARROW);
    wc.lpszClassName = wclassName;
    ATOM atom = RegisterClassExW(&wc);

    free(wclassName);
    JS_FreeCString(ctx, className);
    return JS_NewInt32(ctx, atom);
}

static JSValue js_createWindow(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *className = JS_ToCString(ctx, argv[0]);
    const char *title = JS_ToCString(ctx, argv[1]);
    int32_t style = WS_OVERLAPPEDWINDOW;
    int32_t x = 0, y = 0, w = 0, h = 0;
    JS_ToInt32(ctx, &style, argv[2]);
    JS_ToInt32(ctx, &x, argv[3]);
    JS_ToInt32(ctx, &y, argv[4]);
    JS_ToInt32(ctx, &w, argv[5]);
    JS_ToInt32(ctx, &h, argv[6]);
    HWND parent = toHWND(ctx, argv[7]);
    HMENU menu = toHMENU(ctx, argv[8]);

    wchar_t *wclassName = utf8ToWide(className);
    wchar_t *wtitle = utf8ToWide(title);
    HWND hwnd = CreateWindowExW(0, wclassName, wtitle, style, x, y, w, h, parent, menu, GetModuleHandleW(NULL), NULL);
    free(wclassName);
    free(wtitle);
    JS_FreeCString(ctx, className);
    JS_FreeCString(ctx, title);

    if (hwnd)
    {
        return JS_NewInt64(ctx, (int64_t)hwnd);
    }
    return JS_NewInt64(ctx, 0);
}

static JSValue js_showWindow(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t hwnd_val;
    JS_ToInt64(ctx, &hwnd_val, argv[0]);
    HWND hwnd = (HWND)hwnd_val;
    ShowWindow(hwnd, SW_SHOWNORMAL);
    UpdateWindow(hwnd);
    return JS_UNDEFINED;
}

static JSValue js_setWndProc(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t hwnd_val;
    JS_ToInt64(ctx, &hwnd_val, argv[0]);
    HWND hwnd = (HWND)hwnd_val;

    int idx = findWindowIndex(hwnd);
    if (idx >= 0)
    {
        JS_FreeValue(ctx, g_windows[idx].proc);
        g_windows[idx].proc = JS_DupValue(ctx, argv[1]);
    }
    else if (g_windowCount < MAX_WINDOWS)
    {
        SetWindowLongPtrW(hwnd, GWLP_WNDPROC, (LONG_PTR)ProxyWndProc);
        g_windows[g_windowCount].hWnd = hwnd;
        g_windows[g_windowCount].proc = JS_DupValue(g_ctx, argv[1]);
        g_windowCount++;
    }
    return JS_UNDEFINED;
}

static JSValue js_removeWindow(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t hwnd_val;
    JS_ToInt64(ctx, &hwnd_val, argv[0]);
    HWND hwnd = (HWND)hwnd_val;

    int idx = findWindowIndex(hwnd);
    if (idx >= 0)
    {
        JS_FreeValue(ctx, g_windows[idx].proc);
        for (int i = idx; i < g_windowCount - 1; i++)
        {
            g_windows[i] = g_windows[i + 1];
        }
        g_windowCount--;
        return JS_TRUE;
    }
    return JS_FALSE;
}

static JSValue js_destroyWindow(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t hwnd_val;
    JS_ToInt64(ctx, &hwnd_val, argv[0]);
    HWND hwnd = (HWND)hwnd_val;
    
    BOOL result = DestroyWindow(hwnd);
    return JS_NewBool(ctx, result);
}

static JSValue js_CallWindowProc(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t wndProc, hwnd, wParam, lParam;
    int32_t msg;
    JS_ToInt64(ctx, &wndProc, argv[0]);
    JS_ToInt64(ctx, &hwnd, argv[1]);
    JS_ToInt32(ctx, &msg, argv[2]);
    JS_ToInt64(ctx, &wParam, argv[3]);
    JS_ToInt64(ctx, &lParam, argv[4]);
    LRESULT result = CallWindowProcW((WNDPROC)wndProc, (HWND)hwnd, msg, wParam, lParam);
    return JS_NewInt64(ctx, result);
}

static JSValue js_setWindowText(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t hwnd_val;
    JS_ToInt64(ctx, &hwnd_val, argv[0]);
    HWND hwnd = (HWND)hwnd_val;
    const char *text = JS_ToCString(ctx, argv[1]);
    wchar_t *wtext = utf8ToWide(text);
    SetWindowTextW(hwnd, wtext);
    free(wtext);
    JS_FreeCString(ctx, text);
    return JS_UNDEFINED;
}

static JSValue js_getWindowText(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    HWND hwnd = toHWND(ctx, argv[0]);
    wchar_t wtext[256];
    GetWindowTextW(hwnd, wtext, sizeof(wtext) / sizeof(wtext[0]));
    char *utf8 = wideToUtf8(wtext);
    JSValue ret = JS_NewString(ctx, utf8);
    free(utf8);
    return ret;
}

static JSValue js_DefWindowProc(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t hwnd, wParam, lParam;
    int32_t msg;
    JS_ToInt64(ctx, &hwnd, argv[0]);
    JS_ToInt32(ctx, &msg, argv[1]);
    JS_ToInt64(ctx, &wParam, argv[2]);
    JS_ToInt64(ctx, &lParam, argv[3]);
    LRESULT ret = DefWindowProcW((HWND)hwnd, msg, wParam, lParam);
    return JS_NewInt64(ctx, ret);
}

static JSValue js_PostQuitMessage(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t exitCode;
    JS_ToInt32(ctx, &exitCode, argv[0]);
    PostQuitMessage(exitCode);
    return JS_UNDEFINED;
}

static JSValue js_SendMessage(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t wParam;
    int32_t msg;
    HWND hwnd = toHWND(ctx, argv[0]);
    JS_ToInt32(ctx, &msg, argv[1]);
    JS_ToInt64(ctx, &wParam, argv[2]);
    if (JS_IsString(argv[3]))
    {
        const char *utf8 = JS_ToCString(ctx, argv[3]);
        wchar_t *lParam = utf8ToWide(utf8);
        SendMessageW(hwnd, msg, wParam, (LPARAM)lParam);
        free(lParam);
        JS_FreeCString(ctx, utf8);
    }
    else if (JS_IsNumber(argv[3]))
    {
        int64_t lParam;
        JS_ToInt64(ctx, &lParam, argv[3]);
        SendMessageW(hwnd, msg, wParam, lParam);
    }
    return JS_UNDEFINED;
}

static JSValue js_alert(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *str = JS_ToCString(ctx, argv[0]);
    wchar_t *wstr = utf8ToWide(str);
    wchar_t wtitle[64] = L"JS Alert";
    MessageBoxW(NULL, wstr, wtitle, MB_OK);
    free(wstr);
    JS_FreeCString(ctx, str);
    return JS_UNDEFINED;
}

static JSValue js_getScaleFactor(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    HDC hdc = GetDC(NULL);
    UINT dpi = GetDeviceCaps(hdc, LOGPIXELSX);
    ReleaseDC(NULL, hdc);
    float scaleFactor = (float)dpi / 96.0f;
    return JS_NewFloat64(ctx, scaleFactor);
}

static JSValue js_createSystemDpiFont(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    NONCLIENTMETRICSW ncm = {sizeof(ncm)};
    SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, sizeof(ncm), &ncm, 0);

    HFONT hFont = CreateFontIndirectW(&ncm.lfMessageFont);
    if (hFont)
    {
        return JS_NewInt64(ctx, (int64_t)hFont);
    }
    return JS_NULL;
}

static JSValue js_GetWindowLongPtr(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t hwnd_val;
    int32_t nIndex;
    JS_ToInt64(ctx, &hwnd_val, argv[0]);
    JS_ToInt32(ctx, &nIndex, argv[1]);
    LONG_PTR result = GetWindowLongPtrW((HWND)hwnd_val, nIndex);
    return JS_NewInt64(ctx, result);
}

static JSValue js_SetWindowLongPtr(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t hwnd_val, newLong;
    int32_t nIndex;
    JS_ToInt64(ctx, &hwnd_val, argv[0]);
    JS_ToInt32(ctx, &nIndex, argv[1]);
    JS_ToInt64(ctx, &newLong, argv[2]);
    LONG_PTR result = SetWindowLongPtrW((HWND)hwnd_val, nIndex, newLong);
    return JS_NewInt64(ctx, result);
}

static const JSCFunctionListEntry gui_funcs[] = {
    JS_CFUNC_DEF("RegisterClass", 2, js_registerClass),
    JS_CFUNC_DEF("CreateWindow", 9, js_createWindow),
    JS_CFUNC_DEF("DestroyWindow", 1, js_destroyWindow),
    JS_CFUNC_DEF("ShowWindow", 1, js_showWindow),
    JS_CFUNC_DEF("SetWindowProc", 2, js_setWndProc),
    JS_CFUNC_DEF("DefWindowProc", 4, js_DefWindowProc),
    JS_CFUNC_DEF("PostQuitMessage", 1, js_PostQuitMessage),
    JS_CFUNC_DEF("SendMessage", 4, js_SendMessage),
    JS_CFUNC_DEF("MessageBox", 1, js_alert),
    JS_CFUNC_DEF("SetWindowText", 2, js_setWindowText),
    JS_CFUNC_DEF("GetWindowText", 1, js_getWindowText),
    JS_CFUNC_DEF("GetScaleFactor", 0, js_getScaleFactor),
    JS_CFUNC_DEF("CreateSystemDpiFont", 0, js_createSystemDpiFont),
    JS_CFUNC_DEF("GetWindowLongPtr", 2, js_GetWindowLongPtr),
    JS_CFUNC_DEF("SetWindowLongPtr", 3, js_SetWindowLongPtr),
    JS_CFUNC_DEF("RemoveWindow", 1, js_removeWindow),
    JS_CFUNC_DEF("CallWindowProc", 5, js_CallWindowProc),
};



static int js_gui_init(JSContext *ctx, JSModuleDef *m)
{
    JS_SetModuleExportList(ctx, m, gui_funcs, sizeof(gui_funcs) / sizeof(gui_funcs[0]));
    return 0;
}

JSModuleDef *js_init_module_gui(JSContext *ctx)
{
    JSModuleDef *m;
    m = JS_NewCModule(ctx, "gui", js_gui_init);
    if (!m)
        return NULL;
    JS_AddModuleExportList(ctx, m, gui_funcs, sizeof(gui_funcs) / sizeof(gui_funcs[0]));
    return m;
}