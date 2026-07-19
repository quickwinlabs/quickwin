import { forwardRef, useEffect, useRef } from 'react'
import * as gui from 'gui'
import type { WStyle } from '../jsx.d.ts'

export interface ProgressBarProps {
  value?: number
  max?: number
  style?: WStyle
  smooth?: boolean
}

export const ProgressBar = forwardRef<gui.HWND, ProgressBarProps>(
  ({ value = 0, max = 100, style, smooth }, ref) => {
    const pbRef = useRef<gui.HWND>(null)

    const ws = gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER
      | (smooth ? gui.ProgressStyle.SMOOTH : 0)

    useEffect(() => {
      const h = pbRef.current
      if (!h) return
      gui.SendMessage(h, gui.ProgressMsg.SETRANGE32, 0, max)
      gui.SendMessage(h, gui.ProgressMsg.SETPOS, Math.min(value, max), 0)
    }, [value, max])

    return (
      <w
        type="msctls_progress32"
        ws={ws}
        style={style}
        ref={(h: gui.HWND) => {
          pbRef.current = h
          if (typeof ref === 'function') ref(h)
          else if (ref) ref.current = h
        }}
      />
    )
  }
)
