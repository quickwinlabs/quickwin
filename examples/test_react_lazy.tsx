import '../lib/polyfill.js'
import * as gui from 'gui'
import React, { Suspense, lazy, useState } from 'react'
import { render } from '../lib/react-qw/index.js'

gui.RegisterClass('LazyTest', (hwnd, msg, wParam, lParam) => {
  if (!hwnd) return gui.DefWindowProc(hwnd, msg, wParam, lParam)
  if (msg === gui.WmMsg.DESTROY) {
    gui.PostQuitMessage(0)
    return 0
  }
  return gui.DefWindowProc(hwnd, msg, wParam, lParam)
})

function SimpleComponent() {
  return (
    <w type="STATIC" text="Hello from lazy component!"
      ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
      style={{width:300, height:30}} />
  )
}

const LazySimple = lazy(async () => {
  await new Promise(r => setTimeout(r, 500))
  return { default: SimpleComponent }
})

function App() {
  const [show, setShow] = useState(false)
  return (
    <w type="STATIC" ws={gui.WindowStyle.VISIBLE}
      style={{flexDirection:'column', padding:10, gap:10, flexGrow:1}}>
      <w type="BUTTON"
        text={show ? 'Hide Lazy' : 'Show Lazy'}
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
        style={{width:150, height:30}}
        onEvent={(e: any) => {
          if (e.msg === 0x0202) setShow(!show)
        }}
      />
      {show && (
        <Suspense fallback={
          <w type="STATIC" text="Loading..."
            ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
            style={{width:200, height:30}} />
        }>
          <LazySimple />
        </Suspense>
      )}
    </w>
  )
}

const hwnd = gui.CreateWindow(
  'LazyTest', 'React.lazy Test',
  gui.WindowStyle.OVERLAPPEDWINDOW,
  200, 200, 400, 300, null, null
)

if (hwnd) {
  gui.ShowWindow(hwnd)
  render(<App />, hwnd)
}
