import { forwardRef, useRef, useEffect, type Ref } from 'react'
import * as gui from 'gui'
import { InvalidateRect } from '../../windows/user32.js'
import { NULL } from '../../ffi/ctype.js'
import type { Ptr } from '../../ffi/ctype.js'
import { NMLINK } from '../../windows/structs.js'
import { nmCode } from '../nmhdr.js'
import type { WStyle } from '../jsx.d.ts'

export interface LinkProps {
  href?: string
  children?: string
  onClick?: (url: string) => void
  style?: WStyle
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
    InvalidateRect(h, NULL, 1)
  }, [linkText])

  return (
    <w type="STATIC"
      ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN}
      style={{ ...style, flexDirection: 'column', alignItems: 'stretch' }}
      ref={ref}
      onEvent={(e) => {
        if (e.msg === gui.WmMsg.NOTIFY) {
          const code = nmCode(e.lParam)
          if (code === gui.SysLinkNotifyCode.CLICK || code === gui.SysLinkNotifyCode.RETURN) {
            onClickRef.current?.(NMLINK.decode(e.lParam as Ptr<'NMLINK'>).item.szUrl)
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
