import '../lib/polyfill.js'
import * as gui from 'gui'
import { render } from '../lib/react-qw/index.js'

const WS_CHILD = 0x40000000
const WS_VISIBLE = 0x10000000

gui.RegisterClass('ReactTest', (hwnd, msg, wParam, lParam) => {
  if (!hwnd) return gui.DefWindowProc(hwnd, msg, wParam, lParam)
  if (msg === gui.WmMsg.DESTROY) {
    gui.PostQuitMessage(0)
    return 0
  }
  return gui.DefWindowProc(hwnd, msg, wParam, lParam)
})

function Greeting() {
  return <w type="BUTTON" text="Hello" ws={WS_CHILD | WS_VISIBLE} style={{width:200, height:30}} />
}

const hwnd = gui.CreateWindow(
  'ReactTest', 'React Test',
  gui.WindowStyle.OVERLAPPEDWINDOW,
  200, 200, 500, 400, null, null
)

if (hwnd) {
  gui.ShowWindow(hwnd)
  render(<Greeting />, hwnd)
}
