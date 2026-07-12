import { useRef, useEffect, Children, cloneElement } from 'react'
import * as gui from 'gui'
import * as ffi from 'ffi'

export interface TooltipProps {
  text: string
  children: React.ReactElement
  balloon?: boolean
}

const TTTOOLINFO_CBSIZE = 64

function setQword(dv: DataView, offset: number, val: number): void {
  dv.setUint32(offset, val & 0xFFFFFFFF, true)
  dv.setUint32(offset + 4, Math.floor(val / 0x100000000), true)
}

function buildToolInfo(hTarget: number, text: string): ArrayBuffer {
  const textOff = TTTOOLINFO_CBSIZE
  const textLen = (text.length + 1) * 2
  const buf = new ArrayBuffer(TTTOOLINFO_CBSIZE + textLen)
  const dv = new DataView(buf)
  dv.setUint32(0, TTTOOLINFO_CBSIZE, true)
  dv.setUint32(4, gui.TtToolFlag.SUBCLASS | gui.TtToolFlag.IDISHWND, true)
  setQword(dv, 8, hTarget)
  setQword(dv, 16, hTarget)
  for (let i = 0; i < text.length; i++)
    dv.setUint16(textOff + i * 2, text.charCodeAt(i), true)
  dv.setUint16(textOff + text.length * 2, 0, true)
  const bufPtr = ffi.bufferPtr(buf) as number
  setQword(dv, 48, bufPtr + textOff)
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

    const ti = buildToolInfo(hTarget as number, text)
    const tiPtr = ffi.bufferPtr(ti) as number
    gui.SendMessage(hTT, gui.TtMsg.ADDTOOLW, 0, tiPtr)
    gui.SendMessage(hTT, gui.TtMsg.SETMAXTIPWIDTH, 0, 400)
    gui.SendMessage(hTT, gui.TtMsg.ACTIVATE, 1, 0)

    return () => {
      if (hTT) {
        const ti2 = buildToolInfo(hTarget as number, text)
        gui.SendMessage(hTT, gui.TtMsg.DELTOOLW, 0, ffi.bufferPtr(ti2) as number)
        gui.DestroyWindow(hTT)
      }
      hTTRef.current = null
    }
  }, [text, balloon])

  const child = Children.only(children)
  return cloneElement(child as any, { ref: childRef })
}

export { Tooltip }