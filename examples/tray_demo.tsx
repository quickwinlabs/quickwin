import * as gui from 'gui'
import * as std from 'std'
import { NULL, type MaybePtr } from '../lib/ffi/ctype.js'
import { GetCursorPos, CreatePopupMenu, AppendMenu, TrackPopupMenu, DestroyMenu, GetSystemMetrics, LoadImageOrdinal, PostQuitMessage, SetForegroundWindow, ShowWindow } from '../lib/windows/user32.js'
import { NOTIFYICONDATAW, POINT } from '../lib/windows/structs.js'
import { ShellNotifyIcon } from '../lib/windows/shell32.js'
import { createSystemDpiFont } from '../lib/dpi.js'
import { EditStyle, IDI, ImageType, LoadImageFlag, MenuFlag, NotifyIconCmd, NotifyIconFlag, ShowWindowCmd, SysMetrics, TrackPopupMenuFlag, WindowStyle, WmMsg } from '../constants'

const WM_TRAY = 0x8001

gui.RegisterClass('TrayApp', (hwnd, msg, wParam, lParam) => {
    if (msg === WM_TRAY) {
        const evt = lParam
        if (evt === WmMsg.LBUTTONDOWN) {
            ShowWindow(hwnd, ShowWindowCmd.SHOW)
            SetForegroundWindow(hwnd)
        } else if (evt === WmMsg.RBUTTONDOWN || evt === WmMsg.CONTEXTMENU) {
            SetForegroundWindow(hwnd)
            const pt = POINT.alloc()
            const pos = GetCursorPos(pt.ptr) ? POINT.decode(pt) : null
            const x = pos ? pos.x : 0
            const y = pos ? pos.y : 0
            const hMenu = CreatePopupMenu()
            if (hMenu !== NULL) {
                AppendMenu(hMenu, 0, 1, '显示窗口')
                AppendMenu(hMenu, MenuFlag.SEPARATOR, 0, NULL)
                AppendMenu(hMenu, 0, 2, '退出')
                const cmd = TrackPopupMenu(hMenu, TrackPopupMenuFlag.RETURNCMD | TrackPopupMenuFlag.RIGHTBUTTON, x, y, 0, hwnd, NULL)
                DestroyMenu(hMenu)
                if (cmd === 1) {
                    ShowWindow(hwnd, ShowWindowCmd.SHOW)
                } else if (cmd === 2) {
                    ShellNotifyIcon(NotifyIconCmd.DELETE, { cbSize: NOTIFYICONDATAW.size, hWnd: hwnd, uID: 1 })
                    PostQuitMessage(0)
                }
            }
        }
        return 0
    }
    if (msg === WmMsg.CLOSE) {
        ShowWindow(hwnd, ShowWindowCmd.HIDE)
        return 0
    }
    return gui.DefWindowProc(hwnd, msg, wParam, lParam)
})

// 创建窗口
const W = 500, H = 400
const scr: [number, number] = [GetSystemMetrics(SysMetrics.CXSCREEN), GetSystemMetrics(SysMetrics.CYSCREEN)]
const x = (scr[0] - W) >> 1
const y = (scr[1] - H) >> 1
const hwnd = gui.CreateWindow('TrayApp', '系统托盘示例', WindowStyle.OVERLAPPEDWINDOW, x, y, W, H, null, null)
if (!hwnd) std.exit(0)
ShowWindow(hwnd, ShowWindowCmd.SHOWNORMAL)

// 添加说明文字
const style = WindowStyle.CHILD | WindowStyle.VISIBLE | EditStyle.MULTILINE | EditStyle.READONLY
const text = gui.CreateWindow('EDIT',
    'QuickWin 系统托盘示例\r\n'
    + '\r\n'
    + '右键点击托盘图标打开上下文菜单。\r\n'
    + '关闭此窗口将隐藏到托盘。\r\n'
    + '从菜单中选择"显示窗口"恢复窗口，"退出"结束程序。',
    style, 15, 15, W - 30, H - 70, hwnd, null)
if (text) {
    const font = createSystemDpiFont()
    if (font)
        gui.SendMessage(text, WmMsg.SETFONT, font, 1)
}

// LoadImageW 返回的句柄随 uType 变（HICON/HCURSOR/HBITMAP），绑定只能给裸地址档；
// LoadAppIcon 的 HICON 是同一档的品牌子型，故变量按裸地址声明
let hIcon: MaybePtr<''> | null = gui.LoadAppIcon()
if (!hIcon) hIcon = LoadImageOrdinal(NULL, IDI.APPLICATION, ImageType.ICON, 0, 0, LoadImageFlag.SHARED)
if (hIcon) {
    const ok = ShellNotifyIcon(NotifyIconCmd.ADD, {
        cbSize: NOTIFYICONDATAW.size,
        hWnd: hwnd, uID: 1,
        uFlags: NotifyIconFlag.MESSAGE | NotifyIconFlag.ICON,
        uCallbackMessage: WM_TRAY,
        hIcon,
    })
    std.out.printf('tray icon %s\n', ok ? 'added' : 'FAILED')
    std.out.flush()
} else {
    std.out.printf('failed to load icon\n')
    std.out.flush()
}
