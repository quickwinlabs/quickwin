#include <windows.h>
#include <commctrl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs-gui.h"
#include "quickjs-args.h"

JSContext *g_ctx = NULL;

typedef struct {
    HWND hWnd;
    JSValue proc;
    WNDPROC oldProc;
} WindowEntry;
static WindowEntry *g_windows = NULL;
static int g_windowCount = 0;
static int g_windowCapacity = 0;

typedef struct {
    char className[32];
    JSValue proc;
} ClassEntry;
static ClassEntry *g_classes = NULL;
static int g_classCount = 0;
static int g_classCapacity = 0;

void gui_cleanup(void)
{
    for (int i = 0; i < g_windowCount; i++)
        JS_FreeValue(g_ctx, g_windows[i].proc);
    js_free(g_ctx, g_windows);
    g_windows = NULL;
    g_windowCount = 0;
    g_windowCapacity = 0;
    
    for (int i = 0; i < g_classCount; i++)
        JS_FreeValue(g_ctx, g_classes[i].proc);
    js_free(g_ctx, g_classes);
    g_classes = NULL;
    g_classCount = 0;
    g_classCapacity = 0;
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

// 窗口级代理 — 只查 g_windows[hwnd]（由 SetWindowProc 设置）
LRESULT CALLBACK SubProxyWndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    int idx = findWindowIndex(hWnd);
    if (idx >= 0 && !JS_IsUndefined(g_windows[idx].proc))
    {
        JSValue argv[4] = {
            JS_NewInt64(g_ctx, (int64_t)hWnd),
            JS_NewInt32(g_ctx, msg),
            JS_NewInt64(g_ctx, wParam),
            JS_NewInt64(g_ctx, lParam)};
        JSValue ret = JS_Call(g_ctx, g_windows[idx].proc, JS_UNDEFINED, 4, argv);
        if (JS_IsException(ret))
        {
            JSValue err = JS_GetException(g_ctx);
            const char *err_str = JS_ToCString(g_ctx, err);
            showError(err_str);
            JS_FreeCString(g_ctx, err_str);
            JS_FreeValue(g_ctx, err);
            JS_FreeValue(g_ctx, ret);
            if (g_windows[idx].oldProc)
                return CallWindowProcW(g_windows[idx].oldProc, hWnd, msg, wParam, lParam);
            return DefWindowProcW(hWnd, msg, wParam, lParam);
        }
        int64_t result = 0;
        JS_ToInt64(g_ctx, &result, ret);
        JS_FreeValue(g_ctx, ret);
        return (LRESULT)result;
    }
    if (idx >= 0 && g_windows[idx].oldProc)
        return CallWindowProcW(g_windows[idx].oldProc, hWnd, msg, wParam, lParam);
    return DefWindowProcW(hWnd, msg, wParam, lParam);
}

// 类级代理 — 只查 g_classes[className]（由 RegisterClass 设置）
LRESULT CALLBACK ClassProxyWndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    wchar_t classNameW[64];
    if (GetClassNameW(hWnd, classNameW, 64) > 0)
    {
        char className[64];
        WideCharToMultiByte(CP_UTF8, 0, classNameW, -1, className, sizeof(className), NULL, NULL);
        JSValue wndProc = findClassProc(className);
        if (!JS_IsUndefined(wndProc))
        {
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
            int64_t temp_result = 0;
            JS_ToInt64(g_ctx, &temp_result, ret);
            JS_FreeValue(g_ctx, ret);
            return (LRESULT)temp_result;
        }
    }
    return DefWindowProcW(hWnd, msg, wParam, lParam);
}

/* 应用图标组 ID：quickwin 构建链（resedit）固定写 101；rcedit 为 0/1，故不通用。
   用户换别的 ID 时自行 SendMessage(WM_SETICON) 覆盖。 */
#define QW_APP_ICON_ID 101

typedef HRESULT (WINAPI *LoadIconWithScaleDownFn)(HINSTANCE, LPCWSTR, int, int, HICON*);
static LoadIconWithScaleDownFn g_loadIconWithScaleDown = NULL;

static HICON loadAppIconScaled(int resId, int baseCx, int baseCy)
{
    HINSTANCE hInst = GetModuleHandleW(NULL);
    int dpi = 96;
    HDC hdc = GetDC(NULL);
    if (hdc) { dpi = GetDeviceCaps(hdc, LOGPIXELSX); ReleaseDC(NULL, hdc); }
    if (!g_loadIconWithScaleDown) {
        HMODULE hCtl = LoadLibraryW(L"comctl32.dll");
        if (hCtl)
            g_loadIconWithScaleDown = (LoadIconWithScaleDownFn)GetProcAddress(hCtl, "LoadIconWithScaleDown");
    }
    int cx = baseCx * dpi / 96, cy = baseCy * dpi / 96;
    HICON h = NULL;
    if (g_loadIconWithScaleDown)
        g_loadIconWithScaleDown(hInst, MAKEINTRESOURCEW(resId), cx, cy, &h);
    if (!h)
        h = (HICON)LoadImageW(hInst, MAKEINTRESOURCEW(resId), IMAGE_ICON, cx, cy, LR_DEFAULTCOLOR);
    return h;
}

static JSValue js_registerClass(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *className = JS_ToCString(ctx, argv[0]);
    wchar_t *wclassName = utf8ToWide(className);

    JSValue wndProc = JS_UNDEFINED;
    if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1]))
    {
        wndProc = JS_DupValue(ctx, argv[1]);
        if (g_classCount >= g_classCapacity)
        {
            int newCap = g_classCapacity ? g_classCapacity * 2 : 16;
            ClassEntry *p = js_realloc(ctx, g_classes, newCap * sizeof(ClassEntry));
            if (!p) { JS_FreeValue(ctx, wndProc); wndProc = JS_UNDEFINED; goto done; }
            g_classes = p;
            g_classCapacity = newCap;
        }
        if (!JS_IsUndefined(wndProc))
        {
            strcpy(g_classes[g_classCount].className, className);
            g_classes[g_classCount].proc = wndProc;
            g_classCount++;
        }
    }

done:
    WNDCLASSEXW wc = {0};
    wc.cbSize = sizeof(WNDCLASSEXW);
    wc.style = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc = ClassProxyWndProc;
    wc.hInstance = GetModuleHandleW(NULL);
    wc.hCursor = LoadCursorW(NULL, (LPCWSTR)IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    /* 大图标必须显式给：留 NULL 时 Win7 任务栏回退到 hIconSm（16px）放大到 32px，发虚。 */
    wc.hIcon = loadAppIconScaled(QW_APP_ICON_ID, 32, 32);
    wc.hIconSm = loadAppIconScaled(QW_APP_ICON_ID, 16, 16);
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
    return JS_NULL;
}

static JSValue js_setWndProc(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    HWND hwnd = toHWND(ctx, argv[0]);

    int idx = findWindowIndex(hwnd);
    if (idx >= 0)
    {
        JS_FreeValue(ctx, g_windows[idx].proc);
        g_windows[idx].proc = JS_DupValue(ctx, argv[1]);
    }
    else
    {
        if (g_windowCount >= g_windowCapacity)
        {
            int newCap = g_windowCapacity ? g_windowCapacity * 2 : 16;
            WindowEntry *p = js_realloc(ctx, g_windows, newCap * sizeof(WindowEntry));
            if (!p) return JS_UNDEFINED;
            g_windows = p;
            g_windowCapacity = newCap;
        }
        WNDPROC oldProc = (WNDPROC)GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
        SetWindowLongPtrW(hwnd, GWLP_WNDPROC, (LONG_PTR)SubProxyWndProc);
        g_windows[g_windowCount].hWnd = hwnd;
        g_windows[g_windowCount].oldProc = oldProc;
        g_windows[g_windowCount].proc = JS_DupValue(g_ctx, argv[1]);
        g_windowCount++;
    }
    return JS_UNDEFINED;
}

// 内部函数：清理单个窗口的 WNDPROC 和 JS 引用
static BOOL unsetWindowProcInternal(HWND hwnd)
{
    int idx = findWindowIndex(hwnd);
    if (idx >= 0) {
        if (g_windows[idx].oldProc)
            SetWindowLongPtrW(hwnd, GWLP_WNDPROC, (LONG_PTR)g_windows[idx].oldProc);
        JS_FreeValue(g_ctx, g_windows[idx].proc);
        for (int i = idx; i < g_windowCount - 1; i++) {
            g_windows[i] = g_windows[i + 1];
        }
        g_windowCount--;
        return TRUE;
    }
    return FALSE;
}

static JSValue js_unsetWindowProc(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    HWND hwnd = toHWND(ctx, argv[0]);
    return JS_NewBool(ctx, unsetWindowProcInternal(hwnd));
}

// 递归清理窗口及其子窗口的 WNDPROC 和 JS 引用
static void cleanupWindowAndChildren(HWND hwnd)
{
    // 先递归清理子窗口
    HWND child = GetWindow(hwnd, GW_CHILD);
    while (child) {
        HWND next = GetWindow(child, GW_HWNDNEXT);
        cleanupWindowAndChildren(child);
        child = next;
    }
    // 清理当前窗口
    unsetWindowProcInternal(hwnd);
}

static JSValue js_destroyWindow(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    HWND hwnd = toHWND(ctx, argv[0]);
    
    cleanupWindowAndChildren(hwnd);
    BOOL result = DestroyWindow(hwnd);
    return JS_NewBool(ctx, result);
}

static JSValue js_DefWindowProc(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t hwnd, wParam, lParam;
    JS_ToInt64(ctx, &hwnd, argv[0]);
    GET_INT32(ctx, argv[1], msg);
    JS_ToInt64(ctx, &wParam, argv[2]);
    JS_ToInt64(ctx, &lParam, argv[3]);
    LRESULT ret = DefWindowProcW((HWND)hwnd, msg, wParam, lParam);
    return JS_NewInt64(ctx, ret);
}

static JSValue js_SendMessage(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t wParam;
    LRESULT result;
    HWND hwnd = toHWND(ctx, argv[0]);
    GET_INT32(ctx, argv[1], msg);
    JS_ToInt64(ctx, &wParam, argv[2]);
    if (JS_IsString(argv[3]))
    {
        const char *utf8 = JS_ToCString(ctx, argv[3]);
        wchar_t *lParam = utf8ToWide(utf8);
        result = SendMessageW(hwnd, msg, wParam, (LPARAM)lParam);
        free(lParam);
        JS_FreeCString(ctx, utf8);
    }
    else if (JS_IsNumber(argv[3]))
    {
        int64_t lParam;
        JS_ToInt64(ctx, &lParam, argv[3]);
        result = SendMessageW(hwnd, msg, wParam, lParam);
    }
    else
    {
        return JS_ThrowTypeError(ctx, "SendMessage: lParam must be string or number");
    }
    return JS_NewInt64(ctx, result);
}

static const JSCFunctionListEntry gui_funcs[] = {
    JS_CFUNC_DEF("RegisterClass", 2, js_registerClass),
    JS_CFUNC_DEF("CreateWindow", 9, js_createWindow),
    JS_CFUNC_DEF("DestroyWindow", 1, js_destroyWindow),
    JS_CFUNC_DEF("SetWindowProc", 2, js_setWndProc),
    JS_CFUNC_DEF("DefWindowProc", 4, js_DefWindowProc),
    JS_CFUNC_DEF("SendMessage", 4, js_SendMessage),
    JS_CFUNC_DEF("UnsetWindowProc", 1, js_unsetWindowProc),
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