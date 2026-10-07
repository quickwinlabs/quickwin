import { PtrArrayBuffer, type Ptr } from './ffi/ctype.js'
import * as gui from 'gui'
import { DrawText, GetDC, ReleaseDC } from './windows/user32.js'
import { SelectObject } from './windows/gdi32.js'
import { RECT } from './windows/structs.js'

export function measureText(hdc: Ptr<'HDC'>, text: string, maxWidth: number): { width: number; height: number } {
    // rect 双向位不注册 encoder（CALCRECT 就地写回）：encode() 新建 + DeepPartial 初值一步到位
    //（left/top/bottom 缺省跳过保持 0）→ 传 .ptr → decode 读回
    const r = RECT.encode({ right: maxWidth })
    DrawText(hdc, text, -1, r.ptr, gui.DrawTextFlag.CALCRECT)
    const { right, bottom } = RECT.decode(r)
    return { width: right, height: bottom }
}

export function getButtonIdealSize(hwnd: gui.HWND): { width: number; height: number } {
    const size = new PtrArrayBuffer(8)
    gui.SendMessage(hwnd, gui.ButtonExtMsg.GETIDEALSIZE, 0, size.ptr)
    const dv = new DataView(size)
    return { width: dv.getInt32(0, true), height: dv.getInt32(4, true) }
}

export function measureTextForHwnd(hwnd: gui.HWND, text: string): { width: number; height: number } {
    const hdc = GetDC(hwnd)
    if (!hdc) return { width: 0, height: 0 }
    const hFont = gui.SendMessage(hwnd, gui.WmMsg.GETFONT, 0, 0)
    const oldFont = hFont ? SelectObject(hdc, hFont) : 0
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
