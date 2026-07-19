import { forwardRef, useRef, useEffect, useState, useImperativeHandle } from 'react'
import * as gui from 'gui'
import type { WStyle } from '../jsx.d.ts'

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

    const lbWs = gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER | gui.WindowStyle.VSCROLL
      | gui.ListBoxStyle.HASSTRINGS | gui.ListBoxStyle.NOTIFY | gui.ListBoxStyle.NOINTEGRALHEIGHT
      | (sort ? gui.ListBoxStyle.SORT : 0)

    useEffect(() => {
      const h = lbRef.current
      if (!h) return
      gui.SendMessage(h, gui.LbMsg.RESETCONTENT, 0, 0)
      for (const item of items)
        gui.SendMessage(h, gui.LbMsg.ADDSTRING, 0, item)
      if (sel >= 0 && sel < items.length)
        gui.SendMessage(h, gui.LbMsg.SETCURSEL, sel, 0)
      if (scrollToBottom && items.length > 0)
        gui.SendMessage(h, gui.LbMsg.SETTOPINDEX, items.length - 1, 0)
    }, [items])

    useEffect(() => {
      const h = lbRef.current
      if (h) gui.SendMessage(h, gui.LbMsg.SETCURSEL, sel, 0)
    }, [sel])

    return (
      <w
        type="STATIC"
        ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN}
        style={{ ...style, flexDirection: 'column', alignItems: 'stretch' }}
        onEvent={(e) => {
          if (e.msg !== gui.WmMsg.COMMAND) return
          const code = (e.wParam >> 16) & 0xFFFF
          if (code === gui.LbnCode.SELCHANGE) {
            const h = lbRef.current
            if (!h) return
            const newSel = gui.SendMessage(h, gui.LbMsg.GETCURSEL, 0, 0)
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
