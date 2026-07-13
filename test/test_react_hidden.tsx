import '../lib/polyfill.js'
import * as gui from 'gui'
import * as os from 'os'
import { useState, useEffect } from 'react'
import { render } from '../lib/react-qw/index.js'

const WS_CHILD = 0x40000000
const WS_VISIBLE = 0x10000000

gui.RegisterClass('ReactHidden', (hwnd, msg, wParam, lParam) => {
  if (!hwnd) return gui.DefWindowProc(hwnd, msg, wParam, lParam)
  if (msg === gui.WmMsg.DESTROY) {
    gui.PostQuitMessage(0)
    return 0
  }
  if (msg === gui.WmMsg.LBUTTONDOWN) {
    gui.PostQuitMessage(0)
    return 0
  }
  return gui.DefWindowProc(hwnd, msg, wParam, lParam)
})

function App() {
  const [hidden, setHidden] = useState(true)
  useEffect(() => {
    os.setTimeout(() => setHidden(false), 2000)
  }, [])
  return (
    <w type="STATIC" ws={WS_CHILD | WS_VISIBLE} style={{width:480, height:360, flexDirection:'column', padding:10, gap:10}}>
      <w type="STATIC" text="Click to close" ws={WS_CHILD | WS_VISIBLE}
        style={{width:200, height:30}} />
      <w type="STATIC" text={hidden ? 'HIDDEN' : 'VISIBLE'} ws={WS_CHILD | WS_VISIBLE}
        hidden={hidden}
        style={{width:200, height:100}} />
    </w>
  )
}

const hwnd = gui.CreateWindow(
  'ReactHidden', 'Hidden Prop Test',
  gui.WindowStyle.OVERLAPPEDWINDOW,
  200, 200, 500, 400, null, null
)

if (hwnd) {
  gui.ShowWindow(hwnd)
  render(<App />, hwnd)
}
