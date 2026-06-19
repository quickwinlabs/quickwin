import { forwardRef, useState, useRef, useEffect } from 'react'
import * as gui from 'gui'
import * as ffi from 'ffi'
import type { WStyle } from '../jsx.d.ts'

function textToUtf16(s: string): ArrayBuffer {
  const buf = new ArrayBuffer((s.length + 1) * 2)
  const dv = new DataView(buf)
  for (let i = 0; i < s.length; i++)
    dv.setUint16(i * 2, s.charCodeAt(i), true)
  return buf
}

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

    let ws = gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER
    if (multiline) ws |= gui.EditStyle.MULTILINE | gui.EditStyle.AUTOVSCROLL | gui.WindowStyle.VSCROLL
    if (readonly) ws |= gui.EditStyle.READONLY
    if (number) ws |= gui.EditStyle.NUMBER
    if (password) ws |= gui.EditStyle.PASSWORD | gui.EditStyle.AUTOHSCROLL

    useEffect(() => {
      const h = inputRef.current
      if (!h || !placeholder) return
      const buf = textToUtf16(placeholder)
      gui.SendMessage(h, gui.EditMsg.SETCUEBANNER, 1, ffi.bufferPtr(buf))
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
          else if (ref) (ref as React.RefObject<gui.HWND | null>).current = h
        }}
        onEvent={(e) => {
          if (e.msg === gui.WmMsg.CHAR) {
            const h = inputRef.current
            if (!h) return
            const newText = gui.GetWindowText(h)
            if (!isControlled) setInternalValue(newText)
            onChange?.(newText)
          }
        }}
      />
    )
  }
)
