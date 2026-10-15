import '../lib/polyfill.js'
import * as gui from 'gui'
import { useState } from 'react'
import { render } from '../lib/react-qw/index.js'
import { WindowStyle, WmMsg } from '../constants'

gui.RegisterClass('ReactCounter', (hwnd, msg, wParam, lParam) => {
  if (!hwnd) return gui.DefWindowProc(hwnd, msg, wParam, lParam)
  if (msg === WmMsg.DESTROY) {
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
      ws={WindowStyle.CHILD | WindowStyle.VISIBLE}
      style={{width:200, height:30}}
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
  WindowStyle.OVERLAPPEDWINDOW,
  200, 200, 500, 400, null, null
)

if (hwnd) {
  gui.ShowWindow(hwnd)
  render(<Counter />, hwnd)
}
