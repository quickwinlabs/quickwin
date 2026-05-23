import * as gui from 'gui'
import * as std from 'std'

const WM_TRAY = 0x8001

gui.RegisterClass('TrayApp', (hwnd, msg, wParam, lParam) => {
    if (msg === WM_TRAY) {
        const evt = lParam
        if (evt === 0x0201) { // WM_LBUTTONDOWN
            gui.ShowWindow(hwnd, 5) // SW_SHOW
            gui.SetForegroundWindow(hwnd)
        } else if (evt === 0x0204 || evt === 0x007B) { // WM_RBUTTONDOWN or WM_CONTEXTMENU
            gui.SetForegroundWindow(hwnd)
            const pos = gui.GetCursorPos()
            const x = pos ? pos[0] : 0
            const y = pos ? pos[1] : 0
            const hMenu = gui.CreatePopupMenu()
            if (hMenu) {
                gui.AppendMenu(hMenu, 0, 1, '显示窗口')
                gui.AppendMenu(hMenu, 0x0800, 0, '')
                gui.AppendMenu(hMenu, 0, 2, '退出')
                const cmd = gui.TrackPopupMenu(hMenu, x, y, undefined, hwnd)
                gui.DestroyMenu(hMenu)
                if (cmd === 1) {
                    gui.ShowWindow(hwnd, 5) // SW_SHOW
                } else if (cmd === 2) {
                    gui.ShellNotifyIcon(gui.NotifyIconCmd.DELETE, { hwnd, uID: 1 })
                    gui.PostQuitMessage(0)
                }
            }
        }
        return 0
    }
    if (msg === gui.WmMsg.CLOSE) {
        gui.ShowWindow(hwnd, 0) // SW_HIDE
        return 0
    }
    return gui.DefWindowProc(hwnd, msg, wParam, lParam)
})

// 创建窗口
const W = 500, H = 400
const scr = gui.GetScreenSize()
const x = (scr[0] - W) >> 1
const y = (scr[1] - H) >> 1
const hwnd = gui.CreateWindow('TrayApp', '系统托盘示例', gui.WindowStyle.OVERLAPPEDWINDOW, x, y, W, H, null, null)
gui.ShowWindow(hwnd)

// 添加说明文字
const ES_MULTILINE = 0x0004
const ES_READONLY = 0x0800
const style = gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | ES_MULTILINE | ES_READONLY
const text = gui.CreateWindow('EDIT',
    'QuickWin 系统托盘示例\r\n'
    + '\r\n'
    + '右键点击托盘图标打开上下文菜单。\r\n'
    + '关闭此窗口将隐藏到托盘。\r\n'
    + '从菜单中选择"显示窗口"恢复窗口，"退出"结束程序。',
    style, 15, 15, W - 30, H - 70, hwnd, null)
if (text) {
    const font = gui.CreateSystemDpiFont()
    if (font)
        gui.SendMessage(text, gui.WmMsg.SETFONT, font, 1)
}

const hIcon = gui.LoadIcon('APPLICATION')
if (hIcon) {
    const ok = gui.ShellNotifyIcon(gui.NotifyIconCmd.ADD, {
        hwnd, uID: 1,
        flags: gui.NotifyIconFlag.MESSAGE | gui.NotifyIconFlag.ICON,
        callbackMessage: WM_TRAY,
        hIcon,
    })
    std.out.printf('tray icon %s\n', ok ? 'added' : 'FAILED')
    std.out.flush()
} else {
    std.out.printf('failed to load icon\n')
    std.out.flush()
}
