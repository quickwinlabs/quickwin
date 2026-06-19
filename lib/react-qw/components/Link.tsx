import { forwardRef, useRef, useEffect, type Ref } from 'react'
import * as gui from 'gui'
import * as ffi from 'ffi'
import type { WStyle } from '../jsx.d.ts'

export interface LinkProps {
  href?: string
  children?: string
  onClick?: (url: string) => void
  style?: WStyle
}

function readI32(ptr: number, offset: number): number {
  return ffi.readByte(ptr + offset) | (ffi.readByte(ptr + offset + 1) << 8) |
    (ffi.readByte(ptr + offset + 2) << 16) | (ffi.readByte(ptr + offset + 3) << 24)
}

function readUtf16(ptr: number, offset: number, maxWords: number): string {
  const chars: string[] = []
  for (let i = 0; i < maxWords; i++) {
    const lo = ffi.readByte(ptr + offset + i * 2)
    const hi = ffi.readByte(ptr + offset + i * 2 + 1)
    const code = (hi << 8) | lo
    if (code === 0) break
    chars.push(String.fromCharCode(code))
  }
  return chars.join('')
}

const Link = forwardRef(function Link(
  { href, children, onClick, style }: LinkProps,
  ref: Ref<gui.HWND>
) {
  const displayText = children != null ? String(children) : (href ?? '')
  const linkText = href ? `<A HREF="${href}">${displayText}</A>` : displayText
  const linkRef = useRef<gui.HWND>(null)
  const onClickRef = useRef(onClick)
  onClickRef.current = onClick

  useEffect(() => {
    const h = linkRef.current
    if (!h) return
    gui.InvalidateRect(h, null, true)
  }, [linkText])

  return (
    <w type="STATIC"
      ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN}
      style={{ ...style, flexDirection: 'column', alignItems: 'stretch' }}
      ref={ref}
      onEvent={(e) => {
        if (e.msg === gui.WmMsg.NOTIFY) {
          const code = readI32(e.lParam, 16)
          if (code === gui.SysLinkNotifyCode.CLICK || code === gui.SysLinkNotifyCode.RETURN) {
            const url = readUtf16(e.lParam, 136, 2048)
            onClickRef.current?.(url)
          }
        }
      }}
    >
      <w type="SysLink" ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.TABSTOP}
        text={linkText}
        style={{flexGrow:1}}
        ref={(h: gui.HWND) => { linkRef.current = h }}
      />
    </w>
  )
}) as (
  props: LinkProps & { ref?: React.Ref<gui.HWND> }
) => React.ReactElement

export { Link }
