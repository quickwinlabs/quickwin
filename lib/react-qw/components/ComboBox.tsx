import { forwardRef, useRef, useEffect, useState } from 'react'
import * as gui from 'gui'
import type { WStyle } from '../jsx.d.ts'

export interface ComboBoxProps {
  items: string[]
  selectedIndex?: number
  defaultSelectedIndex?: number
  onChange?: (index: number) => void
  style?: WStyle
  disabled?: boolean
}

export const ComboBox = forwardRef<gui.HWND, ComboBoxProps>(
  ({ items, selectedIndex: controlledIndex, defaultSelectedIndex = -1,
     onChange, style }, ref) => {
    const [internalIndex, setInternalIndex] = useState(defaultSelectedIndex)
    const isControlled = controlledIndex !== undefined
    const sel = isControlled ? controlledIndex : internalIndex
    const cbRef = useRef<gui.HWND>(null)

    const cbWs = gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER
      | gui.ComboBoxStyle.DROPDOWNLIST | gui.ComboBoxStyle.HASSTRINGS

    useEffect(() => {
      const h = cbRef.current
      if (!h) return
      gui.SendMessage(h, gui.ComboBoxMsg.RESETCONTENT, 0, 0)
      for (const item of items)
        gui.SendMessage(h, gui.ComboBoxMsg.ADDSTRING, 0, item)
      if (sel >= 0 && sel < items.length)
        gui.SendMessage(h, gui.ComboBoxMsg.SETCURSEL, sel, 0)
    }, [items])

    useEffect(() => {
      const h = cbRef.current
      if (h) gui.SendMessage(h, gui.ComboBoxMsg.SETCURSEL, sel, 0)
    }, [sel])

    return (
      <w type="STATIC"
        ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN}
        style={{ ...style, flexDirection: 'column', alignItems: 'stretch' }}
        ref={ref}
        onEvent={(e) => {
          if (e.msg !== gui.WmMsg.COMMAND) return
          const code = (e.wParam >> 16) & 0xFFFF
          if (code === gui.CbnCode.SELCHANGE) {
            const h = cbRef.current
            if (!h) return
            const newSel = gui.SendMessage(h, gui.ComboBoxMsg.GETCURSEL, 0, 0)
            if (newSel !== sel && newSel >= 0) {
              if (!isControlled) setInternalIndex(newSel)
              onChange?.(newSel)
            }
          }
        }}
      >
        <w type="COMBOBOX" ws={cbWs}
          style={{flexGrow:1}}
          ref={(h: gui.HWND) => { cbRef.current = h }}
        />
      </w>
    )
  }
)
