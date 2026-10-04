import { forwardRef, useRef } from 'react'
import * as gui from 'gui'
import { bind } from '../lib/ffi/bind.js'
import type { WStyle } from '../lib/react-qw/jsx.d.ts'

const GetDC_ = bind('user32.dll', 'GetDC', '<>ptr -> <>ptr')
const ReleaseDC_ = bind('user32.dll', 'ReleaseDC', '<>ptr <>ptr -> i32')
const SetDIBitsToDevice_ = bind('gdi32.dll', 'SetDIBitsToDevice', '<>ptr i32 i32 u32 u32 i32 i32 u32 u32 <BYTE>ptr <BYTE>ptr u32 -> i32')

function makeBitmapInfo(w: number, h: number): ArrayBuffer {
  const bmi = new ArrayBuffer(40)
  const bv = new DataView(bmi)
  bv.setUint32(0, 40, true)
  bv.setInt32(4, w, true)
  bv.setInt32(8, -h, true)
  bv.setUint16(12, 1, true)
  bv.setUint16(14, 24, true)
  return bmi
}

export interface PdfCanvasProps {
  pixmap?: { data: ArrayBuffer; w: number; h: number }
  style?: WStyle
}

export const PdfCanvas = forwardRef<gui.HWND, PdfCanvasProps>(
  ({ pixmap, style }, ref) => {
    const canvasRef = useRef<gui.HWND>(null)
    const pixmapRef = useRef(pixmap)
    pixmapRef.current = pixmap

    return (
      <w type="STATIC"
        ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN}
        style={style}
        ref={(h: gui.HWND) => {
          canvasRef.current = h
          if (typeof ref === 'function') ref(h)
          else if (ref) (ref as React.RefObject<gui.HWND | null>).current = h
        }}
        onEvent={(e) => {
          const hwnd = e.hwnd
          if (e.msg === 0x14) return 1
          if (e.msg === gui.WmMsg.PAINT) {
            const pm = pixmapRef.current
            if (!pm) return 0
            const hdc = GetDC_(hwnd)
            if (hdc) {
              const bmi = makeBitmapInfo(pm.w, pm.h)
              SetDIBitsToDevice_(hdc, 0, 0, pm.w, pm.h, 0, 0, 0, pm.h, pm.data, bmi, 0)
              ReleaseDC_(hwnd, hdc)
            }
            return 0
          }
          return
        }}
      />
    )
  }
)
