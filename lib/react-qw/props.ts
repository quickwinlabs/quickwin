import * as gui from 'gui'
import { SetWindowText, EnableWindow } from '../windows/user32.js'
import type { Instance, Props } from './reconciler.js'

export function applyProps(
  instance: Instance,
  newProps: Props,
  _oldProps: Props,
) {
  const hwnd = instance.hwnd
  instance.props = newProps
  // 延迟控件（DELAYED_CONTROLS）建窗前 hwnd 为 null：窗口操作此刻全是 no-op
  // （text/ws/style 在 ensureChildWindow 建窗时应用），FFI 位不收 JS null——早退。
  if (hwnd === null) return

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
    SetWindowText(hwnd, textVal)
    if (instance.type === 'EDIT' && cursor >= 0) {
      gui.SendMessage(hwnd, gui.EditMsg.SETSEL, cursor, cursor)
    }
  }
  if ('disabled' in newProps) {
    EnableWindow(hwnd, !newProps.disabled ? 1 : 0)
  }
  if ('hidden' in newProps) {
    gui.ShowWindow(hwnd, newProps.hidden ? gui.ShowWindowCmd.HIDE : gui.ShowWindowCmd.SHOW)
  }
  if ('visible' in newProps) {
    gui.ShowWindow(hwnd, newProps.visible ? gui.ShowWindowCmd.SHOW : gui.ShowWindowCmd.HIDE)
  }
}
