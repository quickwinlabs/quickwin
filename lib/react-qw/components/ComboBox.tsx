import { forwardRef, useRef, useEffect, useState } from 'react'
import * as gui from 'gui'
import { WCHAR } from '../../ffi/bind.js'
import type { WStyle } from '../jsx.d.ts'
import { CbnCode, ComboBoxMsg, ComboBoxStyle, WindowStyle, WmMsg } from '../../../constants'

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

    const cbWs = WindowStyle.VISIBLE | WindowStyle.BORDER
      | ComboBoxStyle.DROPDOWNLIST | ComboBoxStyle.HASSTRINGS

    useEffect(() => {
      const h = cbRef.current
      if (!h) return
      gui.SendMessage(h, ComboBoxMsg.RESETCONTENT, 0, 0)
      for (const item of items) {
        const w = WCHAR.encode(item)
        gui.SendMessage(h, ComboBoxMsg.ADDSTRING, 0, w.ptr)
      }
      if (sel >= 0 && sel < items.length)
        gui.SendMessage(h, ComboBoxMsg.SETCURSEL, sel, 0)
    }, [items])

    useEffect(() => {
      const h = cbRef.current
      if (h) gui.SendMessage(h, ComboBoxMsg.SETCURSEL, sel, 0)
    }, [sel])

    return (
      <w type="STATIC"
        ws={WindowStyle.VISIBLE | WindowStyle.CLIPCHILDREN}
        style={{ ...style, flexDirection: 'column', alignItems: 'stretch' }}
        ref={ref}
        onEvent={(e) => {
          if (e.msg !== WmMsg.COMMAND) return
          const code = (e.wParam >> 16) & 0xFFFF
          if (code === CbnCode.SELCHANGE) {
            const h = cbRef.current
            if (!h) return
            const newSel = gui.SendMessage(h, ComboBoxMsg.GETCURSEL, 0, 0)
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
