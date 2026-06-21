import { forwardRef, useRef } from 'react'
import * as gui from 'gui'
import * as win from 'win'
import * as ffi from 'ffi'
import type { WStyle } from '../jsx.d.ts'

const _user32 = win.LoadLibrary('user32.dll')
const _gdi32 = win.LoadLibrary('gdi32.dll')
if (!_user32 || !_gdi32) throw new Error('Failed to load user32/gdi32')

function loadProc(lib: win.HMODULE, name: string): number {
  const ptr = win.GetProcAddress(lib, name)
  if (!ptr) throw new Error('Failed to load ' + name)
  return ptr
}

const GetDC_ = loadProc(_user32, 'GetDC')
const ReleaseDC_ = loadProc(_user32, 'ReleaseDC')
const SetDIBitsToDevice_ = loadProc(_gdi32, 'SetDIBitsToDevice')

const FFI_PTR = ffi.FFI_TYPE_POINTER
const FFI_U32 = ffi.FFI_TYPE_UINT32
const FFI_S32 = ffi.FFI_TYPE_SINT32

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
          const hwnd = e.hwnd as number
          if (e.msg === 0x14) return 1
          if (e.msg === gui.WmMsg.PAINT) {
            const pm = pixmapRef.current
            if (!pm) return 0
            const hdc = ffi.ffiCall(GetDC_, [ffi.FFI_TYPE_UINT64], [hwnd], ffi.FFI_TYPE_UINT64)
            if (hdc) {
              const bmi = makeBitmapInfo(pm.w, pm.h)
              ffi.ffiCall(SetDIBitsToDevice_, [
                ffi.FFI_TYPE_UINT64, FFI_S32, FFI_S32, FFI_U32, FFI_U32,
                FFI_S32, FFI_S32, FFI_U32, FFI_U32,
                FFI_PTR, FFI_PTR, FFI_U32
              ], [
                hdc, 0, 0, pm.w, pm.h,
                0, 0, 0, pm.h,
                pm.data, bmi, 0
              ], FFI_S32)
              ffi.ffiCall(ReleaseDC_, [ffi.FFI_TYPE_UINT64, ffi.FFI_TYPE_UINT64], [hwnd, hdc], FFI_S32)
            }
            return 0
          }
        }}
      />
    )
  }
)
