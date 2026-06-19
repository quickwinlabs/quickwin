import '../lib/polyfill.js'
import * as gui from 'gui'
import { useState } from 'react'
import { render } from '../lib/react-qw/index.js'

const WS_CHILD = 0x40000000
const WS_VISIBLE = 0x10000000

gui.RegisterClass('ReactCounter', (hwnd, msg, wParam, lParam) => {
  if (!hwnd) return gui.DefWindowProc(hwnd, msg, wParam, lParam)
  if (msg === gui.WmMsg.DESTROY) {
    gui.PostQuitMessage(0)
    return 0
  }
  return gui.DefWindowProc(hwnd, msg, wParam, lParam)
})

const WM_LBUTTONUP = 0x202

function Counter() {
  const [count, setCount] = useState(42)
  return (
    <w
      type="BUTTON"
      text={`Count: ${count}`}
      ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
      style={{x:50, y:50, width:200, height:30}}
      onEvent={(e: any) => {
        if (e.msg === WM_LBUTTONUP) {
          setCount(count + 1)
        }
      }}
    />
  )
}

const hwnd = gui.CreateWindow(
  'ReactCounter', 'React Counter',
  gui.WindowStyle.OVERLAPPEDWINDOW,
  200, 200, 500, 400, null, null
)

if (hwnd) {
  gui.ShowWindow(hwnd)
  render(<Counter />, hwnd)
}
