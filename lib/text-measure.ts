import { NULL, type Ptr } from './ffi/ctype.js'
import * as gui from 'gui'
import { DrawText, GetDC, ReleaseDC } from './windows/user32.js'
import { SelectObject } from './windows/gdi32.js'
import { RECT, SIZE } from './windows/structs.js'

export function measureText(hdc: Ptr<'HDC'>, text: string, maxWidth: number): { width: number; height: number } {
    // rect 双向位不注册 encoder（CALCRECT 就地写回）：encode(初值) 新建 + DeepPartial 初值一步到位
    //（left/top/bottom 缺省跳过保持 0）→ 传 .ptr → decode 读回
    const r = RECT.encode({ right: maxWidth })
    DrawText(hdc, text, -1, r.ptr, gui.DrawTextFlag.CALCRECT)
    const { right, bottom } = RECT.decode(r)
    return { width: right, height: bottom }
}

export function getButtonIdealSize(hwnd: gui.HWND): { width: number; height: number } {
    // SIZE 纯出参位（GETIDEALSIZE 就地写回）：alloc → 传 .ptr → decode 读回
    const size = SIZE.alloc()
    gui.SendMessage(hwnd, gui.ButtonExtMsg.GETIDEALSIZE, 0, size.ptr)
    const { cx, cy } = SIZE.decode(size)
    return { width: cx, height: cy }
}

export function measureTextForHwnd(hwnd: gui.HWND, text: string): { width: number; height: number } {
    const hdc = GetDC(hwnd)
    if (!hdc) return { width: 0, height: 0 }
    // SendMessage 返回 LRESULT 裸数；GETFONT 语义为 HFONT——断言进 GDI 对象品牌链
    const hFont = gui.SendMessage(hwnd, gui.WmMsg.GETFONT, 0, 0) as Ptr<'HGDIOBJ'>
    const oldFont = hFont ? SelectObject(hdc, hFont) : NULL
    const result = measureText(hdc, text, 0)
    if (hFont) SelectObject(hdc, oldFont)
    ReleaseDC(hwnd, hdc)
    const wr = gui.GetWindowRect(hwnd)
    const cr = gui.GetClientRect(hwnd)
    if (wr && cr) {
        result.width += (wr.right - wr.left) - (cr.right - cr.left)
        result.height += (wr.bottom - wr.top) - (cr.bottom - cr.top)
    }
    return result
}
