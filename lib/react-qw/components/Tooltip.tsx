import { useRef, useEffect, Children, cloneElement } from 'react'
import * as gui from 'gui'
import { NULL, PtrArrayBuffer } from '../../ffi/ctype.js'
import { TTTOOLINFOW } from '../../windows/structs.js'
import { SetWindowPos } from '../../windows/user32.js'

export interface TooltipProps {
  text: string
  children: React.ReactElement
  balloon?: boolean
}

function buildToolInfo(hTarget: gui.HWND, text: string): PtrArrayBuffer<string> {
  const size = TTTOOLINFOW.size
  const textLen = (text.length + 1) * 2
  const buf = new PtrArrayBuffer(size + textLen)
  TTTOOLINFOW.encode({
    cbSize: size,
    uFlags: gui.TtToolFlag.SUBCLASS | gui.TtToolFlag.IDISHWND,
    hwnd: hTarget,
    uId: hTarget,
    rect: [0, 0, 0, 0],
    hinst: NULL,
    lpszText: buf.ptr + size,
    lParam: 0,
    lpReserved: 0,
  }, buf)
  const dv = new DataView(buf)
  for (let i = 0; i < text.length; i++)
    dv.setUint16(size + i * 2, text.charCodeAt(i), true)
  dv.setUint16(size + text.length * 2, 0, true)
  return buf
}

function Tooltip({ text, children, balloon }: TooltipProps) {
  const childRef = useRef<gui.HWND>(null)
  const hTTRef = useRef<gui.HWND>(null)

  useEffect(() => {
    const hTarget = childRef.current
    if (!hTarget) return

    const hTT = gui.CreateWindow(
      'tooltips_class32', '',
      gui.WindowStyle.POPUP | gui.TooltipStyle.ALWAYSTIP | gui.TooltipStyle.NOPREFIX
        | (balloon ? gui.TooltipStyle.BALLOON : 0),
      0, 0, 0, 0,
      hTarget, null
    )
    if (!hTT) return
    hTTRef.current = hTT

    SetWindowPos(hTT, gui.SetWindowPosHwnd.TOPMOST, 0, 0, 0, 0, gui.SetWindowPosFlag.SWP_NOMOVE | gui.SetWindowPosFlag.SWP_NOSIZE | gui.SetWindowPosFlag.SWP_NOACTIVATE)

    const ti = buildToolInfo(hTarget, text)
    gui.SendMessage(hTT, gui.TtMsg.ADDTOOLW, 0, ti.ptr)
    gui.SendMessage(hTT, gui.TtMsg.SETMAXTIPWIDTH, 0, 400)
    gui.SendMessage(hTT, gui.TtMsg.ACTIVATE, 1, 0)

    return () => {
      if (hTT) {
        const ti2 = buildToolInfo(hTarget, text)
        gui.SendMessage(hTT, gui.TtMsg.DELTOOLW, 0, ti2.ptr)
        gui.DestroyWindow(hTT)
      }
      hTTRef.current = null
    }
  }, [text, balloon])

  const child = Children.only(children)
  return cloneElement(child as React.ReactElement<Record<string, unknown>>, { ref: childRef })
}

export { Tooltip }