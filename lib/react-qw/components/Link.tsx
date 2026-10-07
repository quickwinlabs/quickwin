import { forwardRef, useRef, useEffect, type Ref } from 'react'
import * as gui from 'gui'
import { InvalidateRect } from '../../windows/user32.js'
import { NULL } from '../../ffi/ctype.js'
import { struct } from '../../ffi/struct.js'
import { NMHDR, nmCode } from '../nmhdr.js'
import type { WStyle } from '../jsx.d.ts'

export interface LinkProps {
  href?: string
  children?: string
  onClick?: (url: string) => void
  style?: WStyle
}

// NMLINK = NMHDR + LITEM。MAX_LINKID_TEXT = 48，L_MAX_URL_LENGTH = 2048 + 32 + sizeof("://") = 2084；
// 宽字符数组走字符串糖（'u16[N]@utf-16le'），decode 直接得到 string（读到 NUL 为止）。
const LITEM = struct({
  mask: 'u32',
  iLink: 'i32',
  state: 'u32',
  stateMask: 'u32',
  szID: 'u16[48]@utf-16le',
  szUrl: 'u16[2084]@utf-16le',
})
const NMLINK = struct({
  hdr: NMHDR.__struct,
  item: LITEM.__struct,
})

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
            onClickRef.current?.(NMLINK.decode(e.lParam).item.szUrl)
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
