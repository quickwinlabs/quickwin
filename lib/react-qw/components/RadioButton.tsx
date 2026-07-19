import { forwardRef, useState, useEffect, useRef } from 'react'
import * as gui from 'gui'
import type { WStyle } from '../jsx.d.ts'

export interface RadioButtonProps {
  checked?: boolean
  defaultChecked?: boolean
  onChange?: (checked: boolean) => void
  label?: string
  style?: WStyle
  disabled?: boolean
}

export const RadioButton = forwardRef<gui.HWND, RadioButtonProps>(
  ({ checked: controlledChecked, defaultChecked = false, onChange, label, style, disabled }, ref) => {
    const [internalChecked, setInternalChecked] = useState(defaultChecked)
    const isControlled = controlledChecked !== undefined
    const displayChecked = isControlled ? controlledChecked : internalChecked
    const rbRef = useRef<gui.HWND>(null)

    useEffect(() => {
      const h = rbRef.current
      if (!h) return
      gui.SendMessage(h, gui.ButtonMsg.SETCHECK,
        displayChecked ? gui.ButtonCheckState.CHECKED : gui.ButtonCheckState.UNCHECKED, 0)
    }, [displayChecked])

    return (
      <w
        type="BUTTON"
        text={label ?? ''}
        ws={gui.WindowStyle.VISIBLE | gui.ButtonStyle.AUTORADIOBUTTON}
        style={style}
        disabled={disabled}
        ref={(h: gui.HWND) => {
          rbRef.current = h
          if (typeof ref === 'function') ref(h)
          else if (ref) ref.current = h
        }}
        onEvent={(e) => {
          if (e.msg === gui.WmMsg.LBUTTONUP) {
            const newChecked = gui.SendMessage(e.hwnd, gui.ButtonMsg.GETCHECK, 0, 0) !== 0
            if (newChecked !== displayChecked) {
              if (!isControlled) setInternalChecked(newChecked)
              onChange?.(newChecked)
            }
          }
        }}
      />
    )
  }
)
