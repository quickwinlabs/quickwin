import { forwardRef, useRef, useEffect, useState, type ReactNode } from 'react'
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

function readI32(ptr: number, offset: number): number {
  return ffi.readByte(ptr + offset) | (ffi.readByte(ptr + offset + 1) << 8) |
    (ffi.readByte(ptr + offset + 2) << 16) | (ffi.readByte(ptr + offset + 3) << 24)
}

export interface TabProps {
  tabs: { title: string; content: ReactNode }[]
  selectedIndex?: number
  defaultSelectedIndex?: number
  onChange?: (index: number) => void
  style?: WStyle
}

export const Tab = forwardRef<gui.HWND, TabProps>(
  ({ tabs, selectedIndex: controlledIndex, defaultSelectedIndex = 0, onChange, style }, ref) => {
    const [internalIndex, setInternalIndex] = useState(defaultSelectedIndex)
    const isControlled = controlledIndex !== undefined
    const sel = isControlled ? controlledIndex : internalIndex
    const tabHwnd = useRef<gui.HWND>(null)

    useEffect(() => {
      const h = tabHwnd.current
      if (!h) return
      gui.SendMessage(h, gui.TcMsg.DELETEALLITEMS, 0, 0)
      for (let i = 0; i < tabs.length; i++) {
        const titleBuf = textToUtf16(tabs[i].title)
        const tci = new ArrayBuffer(40)
        const dv = new DataView(tci)
        dv.setUint32(0, gui.TcItemFlag.TEXT, true)
        dv.setBigUint64(16, BigInt(ffi.bufferPtr(titleBuf)), true)
        dv.setInt32(24, tabs[i].title.length + 1, true)
        const tciPtr = ffi.bufferPtr(tci)
        gui.SendMessage(h, gui.TcMsg.INSERTITEMW, i, tciPtr)
      }
      gui.SendMessage(h, gui.TcMsg.SETCURSEL, sel, 0)
    }, [tabs])

    useEffect(() => {
      const h = tabHwnd.current
      if (h) gui.SendMessage(h, gui.TcMsg.SETCURSEL, sel, 0)
    }, [sel])

    return (
      <w
        type="STATIC"
        ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN}
        style={{ ...style, flexDirection: 'column', alignItems: 'stretch' }}
        ref={ref}
        onEvent={(e) => {
          if (e.msg === gui.WmMsg.NOTIFY) {
            const h = tabHwnd.current
            if (!h) return
            const code = readI32(e.lParam, 16)
            // SysTabControl32 在 comctl32 v6 下不发标准的 TCN_SELCHANGE (-550),
            // 收到 NM_CLICK (-2) 或 TCN_SELCHANGING (-551) 时读实际选中项
            if (code === gui.TcNotifyCode.SELCHANGING || code === gui.SysLinkNotifyCode.CLICK) {
              const newSel = gui.SendMessage(h, gui.TcMsg.GETCURSEL, 0, 0)
              if (newSel !== sel) {
                if (!isControlled) setInternalIndex(newSel)
                onChange?.(newSel)
              }
            }
          }
        }}
      >
        <w
          type="SysTabControl32"
          ws={gui.WindowStyle.VISIBLE | gui.TabStyle.FOCUSNEVER}
          style={{ height: 32 }}
          ref={tabHwnd}
        />
        <w type="STATIC" 
        ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN} 
        style={{ flexGrow: 1, flexDirection: 'column', alignItems: 'stretch' }}>
          {tabs[sel]?.content}
        </w>
      </w>
    )
  }
)
