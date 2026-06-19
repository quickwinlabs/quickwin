import { forwardRef, useRef, useEffect } from 'react'
import * as gui from 'gui'
import type { WStyle } from '../jsx.d.ts'

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
      const lParam = ((min as number) & 0xFFFF) | (((max as number) & 0xFFFF) << 16)
      gui.SendMessage(h, gui.TbMsg.SETRANGE, 0, lParam)
      gui.SendMessage(h, gui.TbMsg.SETPOS, 1, value)
    }, [min, max])

    useEffect(() => {
      const h = sliderRef.current
      if (!h) return
      gui.SendMessage(h, gui.TbMsg.SETPOS, 1, value)
    }, [value])

    const tbStyle = gui.WindowStyle.VISIBLE
      | gui.WindowStyle.TABSTOP
      | gui.TrackBarStyle.AUTOTICKS
      | (vertical ? gui.TrackBarStyle.VERT : 0)

    return (
      <w type="STATIC"
        ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN}
        style={style}
        ref={(h: gui.HWND) => {
          wrapperRef.current = h
          if (typeof ref === 'function') ref(h)
          else if (ref) (ref as React.RefObject<gui.HWND | null>).current = h
        }}
        onEvent={(e) => {
          if (e.msg === gui.WmMsg.NCHITTEST ||
              e.msg === gui.WmMsg.NCLBUTTONDOWN) {
            return gui.DefWindowProc(e.hwnd, e.msg, e.wParam, e.lParam)
          }
          if (e.msg === gui.WmMsg.HSCROLL || e.msg === gui.WmMsg.VSCROLL) {
            const h = sliderRef.current
            if (!h) return 0
            const pos = gui.SendMessage(h, gui.TbMsg.GETPOS, 0, 0)
            onChange?.(pos)
            return 0
          }
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
