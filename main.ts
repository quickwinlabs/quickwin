import {
    CreateWindow as CreateWindowWithoutScale, DefWindowProc, HWND,
    RegisterClass, SendMessage, SetWindowProc,
} from "gui";
// Win32 直通：CallWindowProc / GetWindowLongPtr / GetWindowText 无引擎状态，
// 已从 gui 模块摘除，走 lib/windows 的 FFI 绑定
import { CallWindowProc, GetWindowLongPtr, GetWindowText, GetWindowTextLength, ShowWindow } from "./lib/windows/user32.js";
import { WCHAR } from "./lib/ffi/bind.js";
import { createSystemDpiFont, getScaleFactor } from "./lib/dpi.js";
import { WmMsg, WindowStyle, ButtonStyle, Gwlp, LbMsg, ShowWindowCmd } from "./constants";

const scaleFactor = getScaleFactor();
const dpiFont = createSystemDpiFont();
if (!dpiFont) throw new Error('Failed to create DPI font')

const CreateWindow: typeof CreateWindowWithoutScale = (className, title, style, x, y, cx, cy, parent, id) => {
    let hwnd = CreateWindowWithoutScale(className, title, style, x * scaleFactor, y * scaleFactor, cx * scaleFactor, cy * scaleFactor, parent, id);
    if (hwnd) SendMessage(hwnd, WmMsg.SETFONT, dpiFont, 1);
    return hwnd;
}

let btn: HWND | null = null;
let edit: HWND | null = null;
let list: HWND | null = null;
function wndProc(hwnd: HWND, msg: number, wParam: number, lParam: number) {
    if (msg === WmMsg.CREATE) {
        btn = CreateWindow("BUTTON", "添加", WindowStyle.CHILD | WindowStyle.VISIBLE | ButtonStyle.PUSHBUTTON, 120, 10, 80, 30, hwnd, null);

        edit = CreateWindow("EDIT", "", WindowStyle.CHILD | WindowStyle.VISIBLE | WindowStyle.BORDER, 10, 10, 100, 20, hwnd, null);
        list = CreateWindow("LISTBOX", "", WindowStyle.CHILD | WindowStyle.VISIBLE | WindowStyle.BORDER, 10, 40, 200, 100, hwnd, null);
        if (!btn) return 0
        const oldProc = GetWindowLongPtr(btn, Gwlp.WNDPROC);
        SetWindowProc(btn, (hwnd, msg, wParam, lParam) => {
            if (msg == WmMsg.LBUTTONDOWN) {
                if (!edit) return 0
                if (!list) return 0
                const cap = GetWindowTextLength(edit) + 1;
                const buf = WCHAR.alloc(cap);
                GetWindowText(edit, buf, cap);
                const text = WCHAR.decode(buf);
                if (text.trim())
                    SendMessage(list, LbMsg.ADDSTRING, 0, WCHAR.encode(text).ptr);
                return 0;
            }
            return CallWindowProc(oldProc, hwnd, msg, wParam, lParam);
        });
        return 0;
    } else if (msg === WmMsg.COMMAND) {
        return 0;
    }
    return DefWindowProc(hwnd, msg, wParam, lParam);
}


RegisterClass("MainWindow", wndProc);
var hwnd = CreateWindow("MainWindow", "Todo List", WindowStyle.OVERLAPPEDWINDOW, 0, 0, 600, 400, null, null);
if (hwnd) ShowWindow(hwnd, ShowWindowCmd.SHOWNORMAL);
