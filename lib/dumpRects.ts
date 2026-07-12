import * as os from 'os'
import * as gui from 'gui'

export function startDumpRects(rootHwnd: gui.HWND, intervalMs: number = 3000): void {
  function dumpChild(parent: gui.HWND, indent: string): void {
    var ch = gui.GetWindow(parent, gui.GetWindowCmd.CHILD)
    var n = 0
    while (ch) {
      n++
      var wr = gui.GetWindowRect(ch)
      var cr = gui.GetClientRect(ch)
      var txt = String(gui.GetWindowText(ch) || '').slice(0, 16)
      console.log(indent + '[' + n + '] hwnd=' + String(ch) + ' txt="' + txt + '" wr=' + JSON.stringify(wr) + ' cr=' + JSON.stringify(cr))
      dumpChild(ch, indent + '  ')
      ch = gui.GetWindow(ch, gui.GetWindowCmd.NEXT)
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
