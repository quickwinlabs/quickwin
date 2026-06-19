import '../lib/polyfill.js'
import * as gui from 'gui'
import { useState } from 'react'
import { render, Button, Tab } from '../lib/react-qw/index.js'

gui.RegisterClass('TabDemo', (hwnd, msg, wParam, lParam) => {
  if (!hwnd) return gui.DefWindowProc(hwnd, msg, wParam, lParam)
  if (msg === gui.WmMsg.DESTROY) {
    gui.PostQuitMessage(0)
    return 0
  }
  return gui.DefWindowProc(hwnd, msg, wParam, lParam)
})

function App() {
  const [tabIndex, setTabIndex] = useState(0)

  return (
    <w type="STATIC"
      ws={gui.WindowStyle.VISIBLE}
      style={{ flexDirection: 'column', width: 600, height: 400, x: 10, y: 10 }}
    >
      <Tab
        tabs={[
          {
            title: 'Counter',
            content: (
              <w type="STATIC" 
              ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN} 
              style={{ flexDirection: 'column', gap: 10, x: 10, y: 10, width: 580, height: 300 }}>
                <Button onClick={() => setTabIndex(1)}>Go to Tab 2</Button>
              </w>
            ),
          },
          {
            title: 'Buttons',
            content: (
              <w type="STATIC"
              ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN} 
               style={{ flexDirection: 'row', gap: 10, x: 10, y: 10, width: 580, height: 300, alignItems: 'stretch' }}>
                <Button onClick={() => setTabIndex(2)}>Go to Tab 3</Button>
                <Button onClick={() => setTabIndex(0)} style={{ width: 120 }}>Back</Button>
              </w>
            ),
          },
          {
            title: 'Final',
            content: (
              <w type="STATIC"
              ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN} 
               style={{ flexDirection: 'column', gap: 10, x: 10, y: 10, width: 580, height: 300 }}>
                <Button onClick={() => setTabIndex(0)}>Back to Tab 1</Button>
                <Button onClick={() => setTabIndex(1)}>Back to Tab 2</Button>
              </w>
            ),
          },
        ]}
        style={{ flexGrow: 1 }}
        selectedIndex={tabIndex}
        onChange={(i) => setTabIndex(i)}
      />
    </w>
  )
}

const hwnd = gui.CreateWindow(
  'TabDemo', 'Tab Demo',
  gui.WindowStyle.OVERLAPPEDWINDOW,
  100, 100, 640, 480, null, null
)

if (hwnd) {
  gui.ShowWindow(hwnd)
  render(<App />, hwnd)
}
