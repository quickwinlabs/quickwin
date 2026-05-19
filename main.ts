import {
    CallWindowProc, CreateSystemDpiFont, CreateWindow as CreateWindowWithoutScale, DefWindowProc,
    GetScaleFactor, GetWindowLongPtr, GetWindowText, HWND, WNDPROC,
    MessageBox, RegisterClass, SendMessage, SetWindowProc, ShowWindow,
    WmMsg, WindowStyle, ButtonStyle, Gwlp, LbMsg,
} from "gui";

import { printf } from 'std'
import * as os from 'os';
import  './lib/polyfill.js'
import  './lib/fetch.js'

const scaleFactor = GetScaleFactor();
const dpiFont = CreateSystemDpiFont();
if (!dpiFont) throw new Error('Failed to create DPI font')

const CreateWindow: typeof CreateWindowWithoutScale = (className, title, style, x, y, cx, cy, parent, id) => {
    let hwnd = CreateWindowWithoutScale(className, title, style, x * scaleFactor, y * scaleFactor, cx * scaleFactor, cy * scaleFactor, parent, id);
    SendMessage(hwnd, WmMsg.SETFONT, dpiFont, 1);
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
        let group = CreateWindow("BUTTON", "添加", WindowStyle.CHILD | WindowStyle.VISIBLE | ButtonStyle.GROUPBOX, 10, 180, 100, 30, hwnd, null);
        let check = CreateWindow("BUTTON", "添加到列表", WindowStyle.CHILD | WindowStyle.VISIBLE | ButtonStyle.AUTOCHECKBOX, 10, 280, 100, 30, hwnd, null);
        const oldProc = GetWindowLongPtr(btn, Gwlp.WNDPROC);
        SetWindowProc(btn, (hwnd, msg, wParam, lParam) => {
            if (msg == WmMsg.LBUTTONDOWN) {
                if (!edit) return 0
                if (!list) return 0
                const text = GetWindowText(edit);
                if (text.trim())
                    SendMessage(list, LbMsg.ADDSTRING, 0, text);
                    fetch('https://httpbin.org/get')
                        .then(res => res.json())
                        .then(json => {
                            printf('json: %s\n', JSON.stringify(json))
                        })
                        .catch(err => {
                        printf('Request failed: %s\n', err.message)
                    })
                return 0;
            }
            return CallWindowProc(oldProc as WNDPROC, hwnd, msg, wParam, lParam);
        });
        return 0;
    } else if (msg === WmMsg.COMMAND) {
        return 0;
    }
    return DefWindowProc(hwnd, msg, wParam, lParam);
}


RegisterClass("MainWindow", wndProc);
var hwnd = CreateWindow("MainWindow", "Hello QuickJS", WindowStyle.OVERLAPPEDWINDOW, 0, 0, 600, 400, null, null);
ShowWindow(hwnd);
