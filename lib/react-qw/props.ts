import * as gui from 'gui'
import type { Instance, Props } from './reconciler.js'

export function applyProps(
  instance: Instance,
  newProps: Props,
  _oldProps: Props,
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
    gui.ShowWindow(hwnd, newProps.hidden ? gui.ShowWindowCmd.HIDE : gui.ShowWindowCmd.SHOW)
  }
  if ('visible' in newProps) {
    gui.ShowWindow(hwnd, newProps.visible ? gui.ShowWindowCmd.SHOW : gui.ShowWindowCmd.HIDE)
  }
}
