import { forwardRef } from 'react'
import * as gui from 'gui'
import type { WStyle } from '../jsx.d.ts'

export interface ButtonProps {
  children?: string | number | (string | number)[]
  onClick?: () => void
  style?: WStyle
  disabled?: boolean
}

export const Button = forwardRef<gui.HWND, ButtonProps>(
  ({ children, onClick, style, disabled }, ref) => {
    return (
      <w
        type="BUTTON"
        text={children != null ? (Array.isArray(children) ? children.join('') : String(children)) : ''}
        ws={gui.WindowStyle.VISIBLE}
        style={style}
        disabled={disabled}
        ref={ref}
        onEvent={(e) => {
          if (e.msg === gui.WmMsg.LBUTTONUP) onClick?.()
        }}
      />
    )
  }
)
