import '../lib/polyfill.js'
import * as gui from 'gui'
import { render } from '../lib/react-qw/index.js'
import { ShowWindowCmd, WindowStyle, WmMsg } from '../constants'
import { PostQuitMessage, ShowWindow } from '../lib/windows/user32.js'

const WS_CHILD = 0x40000000
const WS_VISIBLE = 0x10000000

gui.RegisterClass('ReactTest', (hwnd, msg, wParam, lParam) => {
  if (!hwnd) return gui.DefWindowProc(hwnd, msg, wParam, lParam)
  if (msg === WmMsg.DESTROY) {
    PostQuitMessage(0)
    return 0
  }
  return gui.DefWindowProc(hwnd, msg, wParam, lParam)
})

function Greeting() {
  return <w type="BUTTON" text="Hello" ws={WS_CHILD | WS_VISIBLE} style={{width:200, height:30}} />
}

const hwnd = gui.CreateWindow(
  'ReactTest', 'React Test',
  WindowStyle.OVERLAPPEDWINDOW,
  200, 200, 500, 400, null, null
)

if (hwnd) {
  ShowWindow(hwnd, ShowWindowCmd.SHOWNORMAL)
  render(<Greeting />, hwnd)
}
