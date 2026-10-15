import { forwardRef, useRef, useEffect } from 'react'
import * as gui from 'gui'
import { DefWindowProc } from '../../windows/user32.js'
import type { WStyle } from '../jsx.d.ts'
import { TbMsg, TrackBarStyle, WindowStyle, WmMsg } from '../../../constants'

export interface SliderProps {
  value: number
  onChange?: (value: number) => void
  min?: number
  max?: number
  vertical?: boolean
  disabled?: boolean
  style?: WStyle
}

export const Slider = forwardRef<gui.HWND, SliderProps>(
  ({ value, onChange, min = 0, max = 100, vertical = false, disabled, style }, ref) => {
    const wrapperRef = useRef<gui.HWND>(null)
    const sliderRef = useRef<gui.HWND>(null)

    useEffect(() => {
      const h = sliderRef.current
      if (!h) return
      const lParam = (min & 0xFFFF) | ((max & 0xFFFF) << 16)
      gui.SendMessage(h, TbMsg.SETRANGE, 0, lParam)
      gui.SendMessage(h, TbMsg.SETPOS, 1, value)
    }, [min, max])

    useEffect(() => {
      const h = sliderRef.current
      if (!h) return
      gui.SendMessage(h, TbMsg.SETPOS, 1, value)
    }, [value])

    const tbStyle = WindowStyle.VISIBLE
      | WindowStyle.TABSTOP
      | TrackBarStyle.AUTOTICKS
      | (vertical ? TrackBarStyle.VERT : 0)

    return (
      <w type="STATIC"
        ws={WindowStyle.VISIBLE | WindowStyle.CLIPCHILDREN}
        style={style}
        ref={(h: gui.HWND) => {
          wrapperRef.current = h
          if (typeof ref === 'function') ref(h)
          else if (ref) ref.current = h
        }}
        onEvent={(e) => {
          if (e.msg === WmMsg.NCHITTEST ||
              e.msg === WmMsg.NCLBUTTONDOWN) {
            return DefWindowProc(e.hwnd, e.msg, e.wParam, e.lParam)
          }
          if (e.msg === WmMsg.HSCROLL || e.msg === WmMsg.VSCROLL) {
            const h = sliderRef.current
            if (!h) return 0
            const pos = gui.SendMessage(h, TbMsg.GETPOS, 0, 0)
            onChange?.(pos)
            return 0
          }
          return
        }}
      >
        <w type="msctls_trackbar32"
          ws={tbStyle}
          disabled={disabled}
          ref={(h: gui.HWND) => { sliderRef.current = h }}
        />
      </w>
    )
  }
)
