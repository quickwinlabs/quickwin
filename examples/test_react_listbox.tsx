import '../lib/polyfill.js'
import * as gui from 'gui'
import { useState } from 'react'
import { render, ListBox } from '../lib/react-qw/index.js'

let itemCounter = 10

function App() {
  const [items, setItems] = useState(() => {
    const a: string[] = []
    for (let i = 0; i < 10; i++) a.push(`Item ${i}`)
    return a
  })
  const [selectedText, setSelectedText] = useState('none')
  const [selIndex, setSelIndex] = useState(0)

  return (
    <w
      type="STATIC"
      ws={gui.WindowStyle.VISIBLE}
      style={{ width: 400, height: 500, flexDirection: 'column', alignItems: 'flex-start' }}
    >
      <w
        type="STATIC"
        ws={gui.WindowStyle.VISIBLE}
        style={{ flexDirection: 'row', width: 400, height: 26 }}
      >
        <w
          type="BUTTON"
          text="Add Item"
          ws={gui.WindowStyle.VISIBLE}
          style={{ width: 80, height: 26 }}
          onEvent={(e) => {
            if (e.msg === gui.WmMsg.LBUTTONDOWN) {
              setItems(prev => [...prev, `Item ${itemCounter++}`])
            }
          }}
        />
        <w
          type="STATIC"
          text={`Selected[${selIndex}]: ${selectedText}`}
          ws={gui.WindowStyle.VISIBLE}
          style={{ width: 200, height: 26 }}
        />
      </w>
      <ListBox
        items={items}
        selectedIndex={selIndex}
        onChange={(i) => {
          setSelIndex(i)
          setSelectedText(items[i]!)
        }}
        style={{ flexGrow: 1, alignSelf: 'stretch' }}
      />
    </w>
  )
}

gui.RegisterClass('ListBoxDemo', (hwnd, msg, wParam, lParam) => {
  if (!hwnd) return gui.DefWindowProc(hwnd, msg, wParam, lParam)
  if (msg === gui.WmMsg.CREATE) {
    render(<App />, hwnd)
    return 0
  }
  // WM_COMMAND 现在由 ListBox wrapper 通过 onEvent 处理
  return gui.DefWindowProc(hwnd, msg, wParam, lParam)
})

const hwnd = gui.CreateWindow('ListBoxDemo', 'ListBox Demo',
  gui.WindowStyle.OVERLAPPEDWINDOW, 200, 100, 400, 500, null, null)
if (hwnd) gui.ShowWindow(hwnd)
