import { forwardRef, useState, useRef, useEffect } from 'react'
import * as gui from 'gui'
import { WCHAR } from '../../ffi/bind.js'
import { GetWindowText, GetWindowTextLength } from '../../windows/user32.js'
import type { WStyle } from '../jsx.d.ts'
import { EditMsg, EditStyle, WindowStyle, WmMsg } from '../../../constants'

export interface InputProps {
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
  placeholder?: string
  password?: boolean
  multiline?: boolean
  readonly?: boolean
  number?: boolean
  disabled?: boolean
  style?: WStyle
}

export const Input = forwardRef<gui.HWND, InputProps>(
  ({ value: controlledValue, defaultValue = '', onChange, placeholder, password,
     multiline, readonly, number, disabled, style }, ref) => {
    const [internalValue, setInternalValue] = useState(defaultValue)
    const isControlled = controlledValue !== undefined
    const displayValue = isControlled ? controlledValue : internalValue
    const inputRef = useRef<gui.HWND>(null)

    let ws = WindowStyle.VISIBLE | WindowStyle.BORDER
    if (multiline) ws |= EditStyle.MULTILINE | EditStyle.AUTOVSCROLL | WindowStyle.VSCROLL
    if (readonly) ws |= EditStyle.READONLY
    if (number) ws |= EditStyle.NUMBER
    if (password) ws |= EditStyle.PASSWORD | EditStyle.AUTOHSCROLL

    useEffect(() => {
      const h = inputRef.current
      if (!h || !placeholder) return
      const buf = WCHAR.encode(placeholder)
      gui.SendMessage(h, EditMsg.SETCUEBANNER, 1, buf.ptr)
    }, [placeholder])

    return (
      <w
        type="EDIT"
        text={displayValue}
        ws={ws}
        style={style}
        disabled={disabled}
        ref={(h: gui.HWND) => {
          inputRef.current = h
          if (typeof ref === 'function') ref(h)
          else if (ref) ref.current = h
        }}
        onEvent={(e) => {
          if (e.msg === WmMsg.CHAR) {
            const h = inputRef.current
            if (!h) return
            const cap = GetWindowTextLength(h) + 1
            const buf = WCHAR.alloc(cap)
            GetWindowText(h, buf, cap)
            const newText = WCHAR.decode(buf)
            if (!isControlled) setInternalValue(newText)
            onChange?.(newText)
          }
        }}
      />
    )
  }
)
