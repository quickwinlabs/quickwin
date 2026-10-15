import { forwardRef, useLayoutEffect, useRef } from 'react'
import * as gui from 'gui'
import { DefWindowProc, SetWindowPos, ShowScrollBar, GetDC, ReleaseDC } from '../../windows/user32.js'
import { NULL } from '../../ffi/ctype.js'
import { GetDeviceCaps } from '../../windows/gdi32.js'
import type { WStyle } from '../jsx.d.ts'
import { forceFlexLayout } from '../reconciler.js'
import { MouseKeyFlag, ScrollBar, ScrollCmd, SetWindowPosFlag, SetWindowPosHwnd, WindowStyle, WmMsg } from '../../../constants'

export interface ScrollViewProps {
  children?: React.ReactNode
  style?: WStyle
  contentWidth?: number
  contentHeight?: number
}

export const ScrollView = forwardRef<gui.HWND, ScrollViewProps>(
  ({ children, style, contentWidth, contentHeight }, ref) => {
    const svRef = useRef<gui.HWND>(null)
    const contentRef = useRef<gui.HWND>(null)
    const scrollXRef = useRef(0)
    const scrollYRef = useRef(0)

    // Win32 比例滚动条约定：
    //   min   = 0
    //   max   = contentSize - 1（内容最后像素行号）
    //   page  = viewportSize（可见行数）
    //   nPos  = 0 … max - page + 1（即 0 … contentSize - viewportSize）
    function updateScroll(sv: gui.HWND, content: gui.HWND) {
      const svRect = gui.GetClientRect(sv)
      if (!svRect) return
      const svW = svRect.right - svRect.left
      const svH = svRect.bottom - svRect.top

      // GetScaleFactor 等价内联：GetDC → GetDeviceCaps(LOGPIXELSX=88) → ReleaseDC 配对
      const hdc = GetDC(NULL)
      const scale = hdc ? GetDeviceCaps(hdc, 88) / 96 : 1
      if (hdc) ReleaseDC(NULL, hdc)
      const natW = Math.round((contentWidth ?? (svW / scale)) * scale)
      const natH = Math.round((contentHeight ?? (svH / scale)) * scale)

      scrollXRef.current = Math.max(0, Math.min(scrollXRef.current, natW - svW))
      scrollYRef.current = Math.max(0, Math.min(scrollYRef.current, natH - svH))

      SetWindowPos(content, SetWindowPosHwnd.TOP, -scrollXRef.current, -scrollYRef.current, natW, natH,
        SetWindowPosFlag.SWP_NOZORDER)
      forceFlexLayout(content)

      if (natW > svW) {
        gui.SetScrollInfo(sv, ScrollBar.HORZ,
          { min: 0, max: natW - 1, page: svW, pos: scrollXRef.current }, true)
        ShowScrollBar(sv, ScrollBar.HORZ, 1)
      } else {
        scrollXRef.current = 0
        ShowScrollBar(sv, ScrollBar.HORZ, 0)
      }

      if (natH > svH) {
        gui.SetScrollInfo(sv, ScrollBar.VERT,
          { min: 0, max: natH - 1, page: svH, pos: scrollYRef.current }, true)
        ShowScrollBar(sv, ScrollBar.VERT, 1)
      } else {
        scrollYRef.current = 0
        ShowScrollBar(sv, ScrollBar.VERT, 0)
      }
    }

    useLayoutEffect(() => {
      const sv = svRef.current
      const content = contentRef.current
      if (!sv || !content) return
      updateScroll(sv, content)
    }, [contentWidth, contentHeight])

    function setScrollPos(sv: gui.HWND, content: gui.HWND, bar: number, newPos: number) {
      if (bar === ScrollBar.VERT) {
        scrollYRef.current = newPos
      } else {
        scrollXRef.current = newPos
      }
      SetWindowPos(content, SetWindowPosHwnd.TOP, -scrollXRef.current, -scrollYRef.current, 0, 0,
        SetWindowPosFlag.SWP_NOSIZE | SetWindowPosFlag.SWP_NOZORDER)
      gui.SetScrollInfo(sv, bar, { pos: newPos }, true)
    }

    function handleScroll(e: { msg: number; wParam: number }, bar: number) {
      const sv = svRef.current
      const content = contentRef.current
      if (!sv || !content) return
      const info = gui.GetScrollInfo(sv, bar)
      const maxPos = info.max - info.page + 1
      const code = e.wParam & 0xFFFF
      const ref_ = bar === ScrollBar.VERT ? scrollYRef : scrollXRef

      let newPos = ref_.current
      if (code === ScrollCmd.THUMBTRACK) {
        newPos = Math.max(0, Math.min(maxPos, (e.wParam >> 16) & 0xFFFF))
      } else if (code === ScrollCmd.LINEUP) newPos -= 20
      else if (code === ScrollCmd.LINEDOWN) newPos += 20
      else if (code === ScrollCmd.PAGEUP) newPos -= info.page
      else if (code === ScrollCmd.PAGEDOWN) newPos += info.page
      else return
      newPos = Math.max(0, Math.min(maxPos, newPos))
      if (newPos !== ref_.current) setScrollPos(sv, content, bar, newPos)
    }

    function handleMouseWheel(e: { msg: number; wParam: number }) {
      const sv = svRef.current
      const content = contentRef.current
      if (!sv || !content) return
      const wheel = e.wParam >> 16
      const dy = -Math.round(wheel * 40 / 120)
      const isHorz = (e.wParam & MouseKeyFlag.MK_SHIFT) !== 0

      if (isHorz && contentWidth === undefined) return
      if (!isHorz && contentHeight === undefined) return
      const bar = isHorz ? ScrollBar.HORZ : ScrollBar.VERT
      const info = gui.GetScrollInfo(sv, bar)
      const maxPos = info.max - info.page + 1
      const ref_ = isHorz ? scrollXRef : scrollYRef
      let newPos = ref_.current + dy
      newPos = Math.max(0, Math.min(maxPos, newPos))
      if (newPos !== ref_.current) setScrollPos(sv, content, bar, newPos)
    }

    return (
      <w type="STATIC"
        ws={WindowStyle.VISIBLE | WindowStyle.CLIPCHILDREN |
          (contentWidth !== undefined ? WindowStyle.HSCROLL : 0) |
          (contentHeight !== undefined ? WindowStyle.VSCROLL : 0)}
        style={style}
        ref={(h: gui.HWND) => {
          svRef.current = h
          if (typeof ref === 'function') ref(h)
          else if (ref) ref.current = h
        }}
        onEvent={{
          fn: (e) => {
            if (e.msg === WmMsg.NCHITTEST ||
                e.msg === WmMsg.NCLBUTTONDOWN) {
              return DefWindowProc(e.hwnd, e.msg, e.wParam, e.lParam)
            }
            if (e.msg === WmMsg.VSCROLL) { handleScroll(e, ScrollBar.VERT); return 0 }
            if (e.msg === WmMsg.HSCROLL) { handleScroll(e, ScrollBar.HORZ); return 0 }
            if (e.msg === WmMsg.MOUSEWHEEL) { handleMouseWheel(e); return 0 }
            return e.callOldWndProc()
          }
        }}
      >
        <w type="STATIC"
          ws={WindowStyle.VISIBLE | WindowStyle.CLIPCHILDREN}
          style={{flexDirection:'column', alignItems:'flex-start'}}
          ref={(h: gui.HWND) => { contentRef.current = h }}
        >
          {children}
        </w>
      </w>
    )
  }
)
