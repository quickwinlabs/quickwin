import { forwardRef, useLayoutEffect, useRef } from 'react'
import * as gui from 'gui'
import type { WStyle } from '../jsx.d.ts'
import { forceFlexLayout } from '../reconciler.js'

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

      const scale = gui.GetScaleFactor()
      const natW = Math.round((contentWidth ?? (svW / scale)) * scale)
      const natH = Math.round((contentHeight ?? (svH / scale)) * scale)

      scrollXRef.current = Math.max(0, Math.min(scrollXRef.current, natW - svW))
      scrollYRef.current = Math.max(0, Math.min(scrollYRef.current, natH - svH))

      gui.SetWindowPos(content, 0, -scrollXRef.current, -scrollYRef.current, natW, natH,
        gui.SetWindowPosFlag.SWP_NOZORDER)
      forceFlexLayout(content)

      if (natW > svW) {
        gui.SetScrollInfo(sv, gui.ScrollBar.HORZ,
          { min: 0, max: natW - 1, page: svW, pos: scrollXRef.current }, true)
        gui.ShowScrollBar(sv, gui.ScrollBar.HORZ, true)
      } else {
        scrollXRef.current = 0
        gui.ShowScrollBar(sv, gui.ScrollBar.HORZ, false)
      }

      if (natH > svH) {
        gui.SetScrollInfo(sv, gui.ScrollBar.VERT,
          { min: 0, max: natH - 1, page: svH, pos: scrollYRef.current }, true)
        gui.ShowScrollBar(sv, gui.ScrollBar.VERT, true)
      } else {
        scrollYRef.current = 0
        gui.ShowScrollBar(sv, gui.ScrollBar.VERT, false)
      }
    }

    useLayoutEffect(() => {
      const sv = svRef.current
      const content = contentRef.current
      if (!sv || !content) return
      updateScroll(sv, content)
    }, [contentWidth, contentHeight])

    function setScrollPos(sv: gui.HWND, content: gui.HWND, bar: number, newPos: number) {
      if (bar === gui.ScrollBar.VERT) {
        scrollYRef.current = newPos
      } else {
        scrollXRef.current = newPos
      }
      gui.SetWindowPos(content, 0, -scrollXRef.current, -scrollYRef.current, 0, 0,
        gui.SetWindowPosFlag.SWP_NOSIZE | gui.SetWindowPosFlag.SWP_NOZORDER)
      gui.SetScrollInfo(sv, bar, { pos: newPos }, true)
    }

    function handleScroll(e: { msg: number; wParam: number }, bar: number) {
      const sv = svRef.current
      const content = contentRef.current
      if (!sv || !content) return
      const info = gui.GetScrollInfo(sv, bar)
      const maxPos = info.max - info.page + 1
      const code = e.wParam & 0xFFFF
      const ref_ = bar === gui.ScrollBar.VERT ? scrollYRef : scrollXRef

      let newPos = ref_.current
      if (code === gui.ScrollCmd.THUMBTRACK) {
        newPos = Math.max(0, Math.min(maxPos, (e.wParam >> 16) & 0xFFFF))
      } else if (code === gui.ScrollCmd.LINEUP) newPos -= 20
      else if (code === gui.ScrollCmd.LINEDOWN) newPos += 20
      else if (code === gui.ScrollCmd.PAGEUP) newPos -= info.page
      else if (code === gui.ScrollCmd.PAGEDOWN) newPos += info.page
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
      const isHorz = (e.wParam & gui.MouseKeyFlag.MK_SHIFT) !== 0

      if (isHorz && contentWidth === undefined) return
      if (!isHorz && contentHeight === undefined) return
      const bar = isHorz ? gui.ScrollBar.HORZ : gui.ScrollBar.VERT
      const info = gui.GetScrollInfo(sv, bar)
      const maxPos = info.max - info.page + 1
      const ref_ = isHorz ? scrollXRef : scrollYRef
      let newPos = ref_.current + dy
      newPos = Math.max(0, Math.min(maxPos, newPos))
      if (newPos !== ref_.current) setScrollPos(sv, content, bar, newPos)
    }

    return (
      <w type="STATIC"
        ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN |
          (contentWidth !== undefined ? gui.WindowStyle.HSCROLL : 0) |
          (contentHeight !== undefined ? gui.WindowStyle.VSCROLL : 0)}
        style={style}
        ref={(h: gui.HWND) => {
          svRef.current = h
          if (typeof ref === 'function') ref(h)
          else if (ref) (ref as React.RefObject<gui.HWND | null>).current = h
        }}
        onEvent={(e) => {
          if (e.msg === gui.WmMsg.NCHITTEST ||
              e.msg === gui.WmMsg.NCLBUTTONDOWN) {
            return gui.DefWindowProc(e.hwnd, e.msg, e.wParam, e.lParam)
          }
          if (e.msg === gui.WmMsg.VSCROLL) { handleScroll(e, gui.ScrollBar.VERT); return 0 }
          if (e.msg === gui.WmMsg.HSCROLL) { handleScroll(e, gui.ScrollBar.HORZ); return 0 }
          if (e.msg === gui.WmMsg.MOUSEWHEEL) { handleMouseWheel(e); return 0 }
        }}
      >
        <w type="STATIC"
          ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN}
          style={{flexDirection:'column', alignItems:'flex-start'}}
          ref={(h: gui.HWND) => { contentRef.current = h }}
        >
          {children}
        </w>
      </w>
    )
  }
)
