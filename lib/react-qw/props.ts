import * as gui from 'gui'
import type { Instance } from './reconciler.js'
import { scaleFactor } from './reconciler.js'

export function applyProps(
  instance: Instance,
  newProps: Record<string, any>,
  _oldProps: Record<string, any>,
) {
  const hwnd = instance.hwnd!
  instance.props = newProps

  const textVal = 'text' in newProps ? newProps.text : (
    typeof newProps.children === 'string' ? newProps.children :
    typeof newProps.children === 'number' ? String(newProps.children) : undefined
  )
  if (textVal !== undefined) {
    let cursor = -1
    if (instance.type === 'EDIT') {
      const sel = gui.SendMessage(hwnd, gui.EditMsg.GETSEL, 0, 0)
      cursor = sel >>> 16
    }
    gui.SetWindowText(hwnd, textVal)
    if (instance.type === 'EDIT' && cursor >= 0) {
      gui.SendMessage(hwnd, gui.EditMsg.SETSEL, cursor, cursor)
    }
  }
  if ('disabled' in newProps) {
    gui.EnableWindow(hwnd, !newProps.disabled)
  }
  if ('hidden' in newProps) {
    gui.ShowWindow(hwnd, newProps.hidden ? 0 : 5)
  }
  if ('visible' in newProps) {
    gui.ShowWindow(hwnd, newProps.visible)
  }
  const s = newProps.style
  if (s && ('x' in s || 'y' in s || 'width' in s || 'height' in s)) {
    const cur = instance.lastRect ?? { x: 0, y: 0, w: 100, h: 30 }
    const newX = 'x' in s ? s.x : cur.x
    const newY = 'y' in s ? s.y : cur.y
    const newW = 'width' in s ? s.width : cur.w
    const newH = 'height' in s ? s.height : cur.h
    if (newX !== cur.x || newY !== cur.y || newW !== cur.w || newH !== cur.h) {
      gui.SetWindowPos(hwnd, 0, newX * scaleFactor, newY * scaleFactor, newW * scaleFactor, newH * scaleFactor, gui.SetWindowPosFlag.SWP_NOZORDER)
      instance.lastRect = { x: newX, y: newY, w: newW, h: newH }
    }
  }
}
