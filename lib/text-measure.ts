import * as ffi from 'ffi'
import * as gui from 'gui'
import { bindLib } from './ffi-bind.js'

const user32 = bindLib('user32.dll', {
    DrawTextW: 'ptr wstr i32 ptr i32 -> i32',
    GetDC: 'ptr -> ptr',
    ReleaseDC: 'ptr ptr -> i32',
})
const gdi32 = bindLib('gdi32.dll', {
    SelectObject: 'ptr ptr -> ptr',
})

export function measureText(hdc: number, text: string, maxWidth: number): { width: number; height: number } {
    const rect = new ArrayBuffer(16)
    const dv = new DataView(rect)
    dv.setInt32(8, maxWidth, true)
    user32.DrawTextW(hdc, text, -1, rect, gui.DrawTextFlag.CALCRECT)
    return { width: dv.getInt32(8, true), height: dv.getInt32(12, true) }
}

export function getButtonIdealSize(hwnd: gui.HWND): { width: number; height: number } {
    const size = new ArrayBuffer(8)
    gui.SendMessage(hwnd, gui.ButtonExtMsg.GETIDEALSIZE, 0, ffi.bufferPtr(size))
    const dv = new DataView(size)
    return { width: dv.getInt32(0, true), height: dv.getInt32(4, true) }
}

export function measureTextForHwnd(hwnd: gui.HWND, text: string): { width: number; height: number } {
    const hdc = user32.GetDC(hwnd)
    if (!hdc) return { width: 0, height: 0 }
    const hFont = gui.SendMessage(hwnd, gui.WmMsg.GETFONT, 0, 0)
    const oldFont = hFont ? gdi32.SelectObject(hdc, hFont) : 0
    const result = measureText(hdc, text, 0)
    if (hFont) gdi32.SelectObject(hdc, oldFont)
    user32.ReleaseDC(hwnd, hdc)
    const wr = gui.GetWindowRect(hwnd)
    const cr = gui.GetClientRect(hwnd)
    if (wr && cr) {
        result.width += (wr.right - wr.left) - (cr.right - cr.left)
        result.height += (wr.bottom - wr.top) - (cr.bottom - cr.top)
    }
    return result
}
