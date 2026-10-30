import { forwardRef, useRef, useEffect, useState, useImperativeHandle } from 'react'
import * as gui from 'gui'
import { WCHAR } from '../../ffi/bind.js'
import type { WStyle } from '../jsx.d.ts'
import { LbMsg, LbnCode, ListBoxStyle, WindowStyle, WmMsg } from '../../../constants'

export interface ListBoxProps {
  items: string[]
  selectedIndex?: number
  defaultSelectedIndex?: number
  onChange?: (index: number) => void
  style?: WStyle
  disabled?: boolean
  sort?: boolean
  scrollToBottom?: boolean
}

export const ListBox = forwardRef<gui.HWND, ListBoxProps>(
  ({ items, selectedIndex: controlledIndex, defaultSelectedIndex = -1,
     onChange, style, sort, scrollToBottom }, ref) => {
    const [internalIndex, setInternalIndex] = useState(defaultSelectedIndex)
    const isControlled = controlledIndex !== undefined
    const sel = isControlled ? controlledIndex : internalIndex
    const lbRef = useRef<gui.HWND>(null)
    useImperativeHandle(ref, () => lbRef.current!)

    const lbWs = WindowStyle.VISIBLE | WindowStyle.BORDER | WindowStyle.VSCROLL
      | ListBoxStyle.HASSTRINGS | ListBoxStyle.NOTIFY | ListBoxStyle.NOINTEGRALHEIGHT
      | (sort ? ListBoxStyle.SORT : 0)

    useEffect(() => {
      const h = lbRef.current
      if (!h) return
      gui.SendMessage(h, LbMsg.RESETCONTENT, 0, 0)
      for (const item of items)
        gui.SendMessage(h, LbMsg.ADDSTRING, 0, WCHAR.encode(item).ptr)
      if (sel >= 0 && sel < items.length)
        gui.SendMessage(h, LbMsg.SETCURSEL, sel, 0)
      if (scrollToBottom && items.length > 0)
        gui.SendMessage(h, LbMsg.SETTOPINDEX, items.length - 1, 0)
    }, [items])

    useEffect(() => {
      const h = lbRef.current
      if (h) gui.SendMessage(h, LbMsg.SETCURSEL, sel, 0)
    }, [sel])

    return (
      <w
        type="STATIC"
        ws={WindowStyle.VISIBLE | WindowStyle.CLIPCHILDREN}
        style={{ ...style, flexDirection: 'column', alignItems: 'stretch' }}
        onEvent={(e) => {
          if (e.msg !== WmMsg.COMMAND) return
          const code = (e.wParam >> 16) & 0xFFFF
          if (code === LbnCode.SELCHANGE) {
            const h = lbRef.current
            if (!h) return
            const newSel = gui.SendMessage(h, LbMsg.GETCURSEL, 0, 0)
            if (newSel !== sel && newSel >= 0) {
              if (!isControlled) setInternalIndex(newSel)
              onChange?.(newSel)
            }
          }
        }}
      >
        <w type="LISTBOX" ws={lbWs}
          style={{flexGrow:1}}
          ref={(h: gui.HWND) => {
            lbRef.current = h
          }}
        />
      </w>
    )
  }
)
