import * as os from 'os'
import * as gui from 'gui'
import { GetWindowCmd } from '../constants'
import { GetClientRect, GetWindow, GetWindowRect, GetWindowText, GetWindowTextLength } from '../lib/windows/user32.js'
import { WCHAR } from '../lib/ffi/bind.js'
import { RECT } from '../lib/windows/structs.js'

export function startDumpRects(rootHwnd: gui.HWND, intervalMs: number = 3000): void {
  function dumpChild(parent: gui.HWND, indent: string): void {
    var ch = GetWindow(parent, GetWindowCmd.CHILD)
    var n = 0
    while (ch) {
      n++
      const wr = RECT.alloc()
      const cr = RECT.alloc()
      GetWindowRect(ch, wr.ptr)
      GetClientRect(ch, cr.ptr)
      const cap = GetWindowTextLength(ch) + 1
      const textBuf = WCHAR.alloc(cap)
      GetWindowText(ch, textBuf, cap)
      var txt = WCHAR.decode(textBuf).slice(0, 16)
      console.log(indent + '[' + n + '] hwnd=' + String(ch) + ' txt="' + txt + '" wr=' + JSON.stringify(RECT.decode(wr)) + ' cr=' + JSON.stringify(RECT.decode(cr)))
      dumpChild(ch, indent + '  ')
      ch = GetWindow(ch, GetWindowCmd.NEXT)
    }
    if (n === 0) console.log(indent + '(no children)')
  }
  function tick(): void {
    console.log('--- dump rects ---')
    dumpChild(rootHwnd, '')
    os.setTimeout(tick, intervalMs)
  }
  tick()
}
