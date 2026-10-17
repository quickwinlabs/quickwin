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

typedef struct {
    LPCWSTR name;
    int found;
} EnumIconCtx;

static BOOL CALLBACK enum_first_group_icon(HMODULE hModule, LPCWSTR lpszType, LPWSTR lpszName, LONG_PTR lParam)
{
    (void)hModule;
    (void)lpszType;
    EnumIconCtx *ctx = (EnumIconCtx *)lParam;
    ctx->name = lpszName;
    ctx->found = 1;
    return FALSE;
}

/* Load app icon from exe resources (custom icon embedded by rcedit).
   Enumerates RT_GROUP_ICON and takes the first entry, works with any resource ID
   (including ID 0 written by rcedit when the exe had no original icon: the loader
   treats the NULL name from enumeration as ordinal 0 and still loads it).
   Returns NULL if the exe has no icon resource. */
static HICON load_app_icon(int cx, int cy)
{
    HMODULE hmod = GetModuleHandleW(NULL);
    EnumIconCtx ctx = {NULL, 0};
    EnumResourceNamesW(hmod, (LPCWSTR)RT_GROUP_ICON, enum_first_group_icon, (LONG_PTR)&ctx);
    if (ctx.found)
        return (HICON)LoadImageW(hmod, ctx.name, IMAGE_ICON, cx, cy, LR_DEFAULTCOLOR);
    return NULL;
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
    wc.hIcon = load_app_icon(0, 0);
    wc.hIconSm = load_app_icon(GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON));
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

/* ─── Tray icon ─────────────────────────────────────────────── */

static JSValue js_shellNotifyIcon(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    GET_INT32(ctx, argv[0], cmd);

    NOTIFYICONDATAW nid = {0};
    nid.cbSize = sizeof(NOTIFYICONDATAW);

    JSValue obj = argv[1];
    JSValue prop;
    int32_t n;
    int64_t v;
    const char *s;

    prop = JS_GetPropertyStr(ctx, obj, "hwnd");
    if (JS_IsNumber(prop)) { JS_ToInt64(ctx, &v, prop); nid.hWnd = (HWND)v; }
    JS_FreeValue(ctx, prop);

    prop = JS_GetPropertyStr(ctx, obj, "uID");
    if (JS_IsNumber(prop)) { JS_ToInt32(ctx, &n, prop); nid.uID = n; }
    JS_FreeValue(ctx, prop);

    prop = JS_GetPropertyStr(ctx, obj, "flags");
    if (JS_IsNumber(prop)) { JS_ToInt32(ctx, &n, prop); nid.uFlags = n; }
    JS_FreeValue(ctx, prop);

    prop = JS_GetPropertyStr(ctx, obj, "callbackMessage");
    if (JS_IsNumber(prop)) { JS_ToInt32(ctx, &n, prop); nid.uCallbackMessage = n; }
    JS_FreeValue(ctx, prop);

    prop = JS_GetPropertyStr(ctx, obj, "hIcon");
    if (JS_IsNumber(prop)) { JS_ToInt64(ctx, &v, prop); nid.hIcon = (HICON)v; }
    JS_FreeValue(ctx, prop);

    prop = JS_GetPropertyStr(ctx, obj, "tip");
    if (JS_IsString(prop)) {
        s = JS_ToCString(ctx, prop);
        MultiByteToWideChar(CP_UTF8, 0, s, -1, nid.szTip, sizeof(nid.szTip)/sizeof(wchar_t));
        JS_FreeCString(ctx, s);
    }
    JS_FreeValue(ctx, prop);

    return JS_NewBool(ctx, Shell_NotifyIconW(cmd, &nid));
}

/* ─── Icons ─────────────────────────────────────────────────── */

/* Thin wrapper around LoadImageW: (hinst, name, uType?, cx?, cy?, fuLoad?).
   hinst=null for system resources/file path, number for module handle.
   name=string for path/resource name, number for resource ID.
   Returns HICON handle (int64) on success, null on failure. */
static JSValue js_loadImage(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    HINSTANCE hinst = NULL;
    wchar_t *wname = NULL;
    LPCWSTR lpName = NULL;

    if (JS_IsNull(argv[0])) {
        hinst = NULL;
    } else if (JS_IsNumber(argv[0])) {
        GET_INT64(ctx, argv[0], hinst64);
        hinst = (HINSTANCE)hinst64;
    } else {
        return JS_ThrowTypeError(ctx, "LoadImage: first argument must be null or a module handle");
    }

    if (JS_IsString(argv[1])) {
        const char *name = JS_ToCString(ctx, argv[1]);
        wname = utf8ToWide(name);
        lpName = wname;
        JS_FreeCString(ctx, name);
    } else if (JS_IsNumber(argv[1])) {
        GET_INT32(ctx, argv[1], id);
        lpName = MAKEINTRESOURCEW(id);
    }

    GET_INT32_OPT(ctx, argv[2], uType, IMAGE_ICON);
    GET_INT32_OPT(ctx, argv[3], cx, 0);
    GET_INT32_OPT(ctx, argv[4], cy, 0);
    GET_INT32_OPT(ctx, argv[5], fuLoad, 0);

    HANDLE h = LoadImageW(hinst, lpName, uType, cx, cy, fuLoad);

    free(wname);
    if (h && h != INVALID_HANDLE_VALUE) return JS_NewInt64(ctx, (int64_t)h);
    return JS_NULL;
}

/* Load the first RT_GROUP_ICON from this exe (custom icon embedded by rcedit).
   Signature: LoadAppIcon(cx?, cy?). Returns HICON handle (int64) or null. */
static JSValue js_loadAppIcon(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    (void)argc;
    GET_INT32_OPT(ctx, argv[0], cx, 0);
    GET_INT32_OPT(ctx, argv[1], cy, 0);
    HICON h = load_app_icon(cx, cy);
    if (h) return JS_NewInt64(ctx, (int64_t)h);
    return JS_NULL;
}

/* ─── Images (pixels) ────────────────────────────────────────── */

/* 从 BGRA 像素数据创建 32bpp top-down DIB；返回 HBITMAP，失败返回 NULL。
   data 必须是 length >= width*height*4 的 ArrayBuffer。 */
static JSValue js_createBitmapFromPixels(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    int width = 0, height = 0;
    size_t len = 0;
    uint8_t *data = NULL;

    if (argc < 3) return JS_NULL;
    JS_ToInt32(ctx, &width, argv[0]);
    JS_ToInt32(ctx, &height, argv[1]);
    data = JS_GetArrayBuffer(ctx, &len, argv[2]);
    if (!data || width <= 0 || height <= 0 || len < (size_t)width * (size_t)height * 4)
        return JS_NULL;

    BITMAPINFO bi = { .bmiHeader = { sizeof(BITMAPINFOHEADER), width, -height, 1, 32, BI_RGB } };
    void *bits = NULL;
    HBITMAP hbm = CreateDIBSection(NULL, &bi, DIB_RGB_COLORS, &bits, NULL, 0);
    if (!hbm) return JS_NULL;
    memcpy(bits, data, len);
    return JS_NewInt64(ctx, (int64_t)hbm);
}

static const JSCFunctionListEntry gui_funcs[] = {
    JS_CFUNC_DEF("RegisterClass", 2, js_registerClass),
    JS_CFUNC_DEF("CreateWindow", 9, js_createWindow),
    JS_CFUNC_DEF("DestroyWindow", 1, js_destroyWindow),
    JS_CFUNC_DEF("SetWindowProc", 2, js_setWndProc),
    JS_CFUNC_DEF("DefWindowProc", 4, js_DefWindowProc),
    JS_CFUNC_DEF("SendMessage", 4, js_SendMessage),
    JS_CFUNC_DEF("UnsetWindowProc", 1, js_unsetWindowProc),
    JS_CFUNC_DEF("ShellNotifyIcon", 2, js_shellNotifyIcon),
    JS_CFUNC_DEF("LoadImage", 6, js_loadImage),
    JS_CFUNC_DEF("LoadAppIcon", 2, js_loadAppIcon),
    JS_CFUNC_DEF("CreateBitmapFromPixels", 3, js_createBitmapFromPixels),
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