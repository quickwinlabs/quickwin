import { useRef, useEffect, Children, cloneElement } from 'react'
import * as gui from 'gui'
import * as ffi from 'ffi'
import { struct } from '../../ffi-struct.js'

export interface TooltipProps {
  text: string
  children: React.ReactElement
  balloon?: boolean
}

const TTTOOLINFOW = struct({
  cbSize: 'u32',
  uFlags: 'u32',
  hwnd: 'ptr',
  uId: 'ptr',
  rect: 'i32[4]',
  hinst: 'ptr',
  lpszText: 'ptr',
  lParam: 'ptr',
  lpReserved: 'ptr', // WinXP+ 追加字段（系统 sizeof 含之）
})

function buildToolInfo(hTarget: number, text: string): ArrayBuffer {
  const size = TTTOOLINFOW.size
  const textLen = (text.length + 1) * 2
  const buf = new ArrayBuffer(size + textLen)
  TTTOOLINFOW.write({
    cbSize: size,
    uFlags: gui.TtToolFlag.SUBCLASS | gui.TtToolFlag.IDISHWND,
    hwnd: hTarget,
    uId: hTarget,
    rect: [0, 0, 0, 0],
    hinst: 0,
    lpszText: ffi.bufferPtr(buf) + size,
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

    gui.SetWindowPos(hTT, gui.SetWindowPosHwnd.TOPMOST, 0, 0, 0, 0, gui.SetWindowPosFlag.SWP_NOMOVE | gui.SetWindowPosFlag.SWP_NOSIZE | gui.SetWindowPosFlag.SWP_NOACTIVATE)

    const ti = buildToolInfo(hTarget, text)
    const tiPtr = ffi.bufferPtr(ti)
    gui.SendMessage(hTT, gui.TtMsg.ADDTOOLW, 0, tiPtr)
    gui.SendMessage(hTT, gui.TtMsg.SETMAXTIPWIDTH, 0, 400)
    gui.SendMessage(hTT, gui.TtMsg.ACTIVATE, 1, 0)

    return () => {
      if (hTT) {
        const ti2 = buildToolInfo(hTarget, text)
        gui.SendMessage(hTT, gui.TtMsg.DELTOOLW, 0, ffi.bufferPtr(ti2))
        gui.DestroyWindow(hTT)
      }
      hTTRef.current = null
    }
  }, [text, balloon])

  const child = Children.only(children)
  return cloneElement(child as React.ReactElement<Record<string, unknown>>, { ref: childRef })
}

export { Tooltip }