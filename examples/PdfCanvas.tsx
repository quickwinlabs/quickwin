import { PtrArrayBuffer } from '../lib/ffi/ctype.js'
import { forwardRef, useRef } from 'react'
import * as gui from 'gui'
import { GetDC, ReleaseDC } from '../lib/windows/user32.js'
import { SetDIBitsToDevice } from '../lib/windows/gdi32.js'
import { BITMAPINFOHEADER } from '../lib/windows/structs.js'
import type { WStyle } from '../lib/react-qw/jsx.d.ts'

function makeBitmapInfo(w: number, h: number) {
  // biHeight 负 = 自顶向下（DIB 原点左上）；biCompression 缺省 0 = BI_RGB 无压缩
  return BITMAPINFOHEADER.encode({ biSize: BITMAPINFOHEADER.size, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 24 })
}

export interface PdfCanvasProps {
  pixmap?: { data: PtrArrayBuffer<string>; w: number; h: number }
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
            const hdc = GetDC(hwnd)
            if (hdc) {
              const bmi = makeBitmapInfo(pm.w, pm.h)
              SetDIBitsToDevice(hdc, 0, 0, pm.w, pm.h, 0, 0, 0, pm.h, pm.data, bmi, 0)
              ReleaseDC(hwnd, hdc)
            }
            return 0
          }
          return
        }}
      />
    )
  }
)
