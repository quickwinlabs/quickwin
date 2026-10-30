import { useRef, useEffect, Children, cloneElement } from 'react'
import * as gui from 'gui'
import { NULL, PtrArrayBuffer } from '../../ffi/ctype.js'
import { TTTOOLINFOW } from '../../windows/structs.js'
import { SetWindowPos } from '../../windows/user32.js'
import { SetWindowPosFlag, SetWindowPosHwnd, TooltipStyle, TtMsg, TtToolFlag, WindowStyle } from '../../../constants'

export interface TooltipProps {
  text: string
  children: React.ReactElement
  balloon?: boolean
}

function buildToolInfo(hTarget: gui.HWND, text: string): PtrArrayBuffer<'TTTOOLINFOW'> {
  const size = TTTOOLINFOW.size
  const textLen = (text.length + 1) * 2
  const buf = new PtrArrayBuffer<'TTTOOLINFOW'>(size + textLen)
  TTTOOLINFOW.encode({
    cbSize: size,
    uFlags: TtToolFlag.SUBCLASS | TtToolFlag.IDISHWND,
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
      WindowStyle.POPUP | TooltipStyle.ALWAYSTIP | TooltipStyle.NOPREFIX
        | (balloon ? TooltipStyle.BALLOON : 0),
      0, 0, 0, 0,
      hTarget, null
    )
    if (!hTT) return
    hTTRef.current = hTT

    SetWindowPos(hTT, SetWindowPosHwnd.TOPMOST, 0, 0, 0, 0, SetWindowPosFlag.SWP_NOMOVE | SetWindowPosFlag.SWP_NOSIZE | SetWindowPosFlag.SWP_NOACTIVATE)

    const ti = buildToolInfo(hTarget, text)
    gui.SendMessage(hTT, TtMsg.ADDTOOLW, 0, ti.ptr)
    gui.SendMessage(hTT, TtMsg.SETMAXTIPWIDTH, 0, 400)
    gui.SendMessage(hTT, TtMsg.ACTIVATE, 1, 0)

    return () => {
      if (hTT) {
        const ti2 = buildToolInfo(hTarget, text)
        gui.SendMessage(hTT, TtMsg.DELTOOLW, 0, ti2.ptr)
        gui.DestroyWindow(hTT)
      }
      hTTRef.current = null
    }
  }, [text, balloon])

  const child = Children.only(children)
  return cloneElement(child as React.ReactElement<Record<string, unknown>>, { ref: childRef })
}

export { Tooltip }