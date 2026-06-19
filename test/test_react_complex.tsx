import '../lib/polyfill.js'
import * as gui from 'gui'
import * as os from 'os'
import React, { useState, useEffect, useRef } from 'react'
import { render } from '../lib/react-qw/index.js'

// 打印窗口树
function printWindowTree(hwnd: gui.HWND, indent: number = 0) {
  if (!hwnd) return
  const prefix = '  '.repeat(indent)
  let text = '(no text)'
  try {
    text = gui.GetWindowText(hwnd) || '(no text)'
  } catch (e) {
    text = '(error)'
  }
  const isWindow = gui.IsWindow(hwnd)
  console.log(`${prefix}hwnd=${hwnd}, text="${text}", IsWindow=${isWindow}`)
  
  let child = gui.GetWindow(hwnd, gui.GetWindowCmd.CHILD)
  while (child) {
    printWindowTree(child, indent + 1)
    child = gui.GetWindow(child, gui.GetWindowCmd.NEXT)
  }
}

function mockSetInterval(func: () => void, delay: number) {
  function loop() {
    func()
    os.setTimeout(loop, delay)
  }
  os.setTimeout(loop, delay)
}

gui.RegisterClass('ComplexTest', (hwnd, msg, wParam, lParam) => {
  if (!hwnd) return gui.DefWindowProc(hwnd, msg, wParam, lParam)
  if (msg === gui.WmMsg.DESTROY) {
    gui.PostQuitMessage(0)
    return 0
  }
  return gui.DefWindowProc(hwnd, msg, wParam, lParam)
})

const SS_LEFT = 0x00000000
const SS_SUNKEN = 0x00000100
const WM_LBUTTONUP = 0x202

function Counter({ label, initial = 0, x = 10, y = 10 }: { label: string; initial?: number; x?: number; y?: number }) {
  const [count, setCount] = useState(initial)
  return (
    <w
      type="BUTTON"
      text={`${label}: ${count}`}
      ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
      style={{x, y, width:180, height:30}}
      onEvent={(e: any) => {
        if (e.msg === WM_LBUTTONUP) {
          setCount(count + 1)
        }
      }}
    />
  )
}

function NestedButtons() {
  const [clicks, setClicks] = useState(0)
  return (
    <w
      type="STATIC"
      text="Nested Panel"
      ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER | gui.WindowStyle.CLIPCHILDREN}
      style={{x:10, y:90, width:460, height:100}}
    >
      <w
        type="BUTTON"
        text={`Nested A: ${clicks}`}
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
        style={{x:15, y:20, width:160, height:25}}
        onEvent={(e: any) => {
          if (e.msg === WM_LBUTTONUP) {
            setClicks((c: number) => c + 1)
          }
        }}
      />
      <w
        type="BUTTON"
        text={`Nested B: ${clicks * 2}`}
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
        style={{x:190, y:20, width:160, height:25}}
      />
      <w
        type="BUTTON"
        text="Reset"
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
        style={{x:360, y:18, width:60, height:29}}
        onEvent={(e: any) => {
          if (e.msg === WM_LBUTTONUP) {
            setClicks(0)
          }
        }}
      />
    </w>
  )
}

function InputField({ x, y }: { x: number; y: number }) {
  const [text, setText] = useState('')
  const editRef = useRef<gui.HWND>(null)

  return (
    <>
      <w
        type="EDIT"
        text="type here"
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER}
        style={{x, y, width:160, height:24}}
        ref={editRef}
      />
      <w
        type="BUTTON"
        text="Read"
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
        style={{x: x + 170, y, width:60, height:24}}
        onEvent={(e: any) => {
          if (e.msg === WM_LBUTTONUP && editRef.current) {
            setText(gui.GetWindowText(editRef.current))
          }
        }}
      />
      <w
        type="STATIC"
        text={`Input: ${text}`}
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER}
        style={{x, y: y + 30, width:300, height:22}}
      />
    </>
  )
}

function CounterWithInput({ x, y }: { x: number; y: number }) {
  const [count, setCount] = useState(0)
  const [displayValue, setDisplayValue] = useState(0)
  const inputRef = useRef<gui.HWND>(null)

  return (
    <>
      <w
        type="EDIT"
        text="0"
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER}
        style={{x, y, width:60, height:24}}
        ref={inputRef}
      />
      <w
        type="BUTTON"
        text="Start"
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
        style={{x: x + 70, y, width:60, height:24}}
        onEvent={(e: any) => {
          if (e.msg === WM_LBUTTONUP && inputRef.current) {
            const val = parseInt(gui.GetWindowText(inputRef.current) || '0', 10)
            setDisplayValue(val)
            setCount(0)
          }
        }}
      />
      <w
        type="BUTTON"
        text={`Count: ${displayValue + count}`}
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
        style={{x: x + 140, y, width:160, height:24}}
        onEvent={(e: any) => {
          if (e.msg === WM_LBUTTONUP) {
            setCount((c: number) => c + 1)
          }
        }}
      />
    </>
  )
}

function EffectLogger({ x, y }: { x: number; y: number }) {
  const [log, setLog] = useState('pending')

  useEffect(() => {
    setLog('mounted!')
    return () => { setLog('cleaned up') }
  }, [])

  return (
    <w
      type="STATIC"
      text={`useEffect: ${log}`}
      ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER}
      style={{x, y, width:200, height:22}}
    />
  )
}

function ControlledInput({ x, y }: { x: number; y: number }) {
  const [value, setValue] = useState('')

  return (
    <>
      <w
        type="EDIT"
        text={value}
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER}
        style={{x, y, width:200, height:24}}
        onEvent={(e: any) => {
          if (e.msg === gui.WmMsg.CHAR) {
            setValue(gui.GetWindowText(e.hwnd))
          }
        }}
      />
      <w
        type="STATIC"
        text={`Controlled: "${value}"`}
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER}
        style={{x, y: y + 30, width:300, height:22}}
      />
    </>
  )
}

function App() {
  const [showExtra, setShowExtra] = useState(false)
  const [showNested, setShowNested] = useState(true)

  return (
    <>
      <Counter label="Counter A" initial={0} />
      <Counter label="Counter B" initial={100} x={200} y={10} />

      <w
        type="BUTTON"
        text="Toggle Extra"
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
        style={{x:10, y:50, width:120, height:30}}
        onEvent={(e: any) => {
          if (e.msg === WM_LBUTTONUP) {
            console.log('[App] Toggle button clicked, current showExtra:', showExtra)
            setShowExtra(!showExtra)
          }
        }}
      />
      <w
        type="BUTTON"
        text={showNested ? 'Hide Panel' : 'Show Panel'}
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
        style={{x:140, y:50, width:120, height:30}}
        onEvent={(e: any) => {
          if (e.msg === WM_LBUTTONUP) {
            console.log('[App] Toggle Nested button clicked, current showNested:', showNested)
            setShowNested(!showNested)
          }
        }}
      />

      {showNested && <NestedButtons />}

      {showExtra && (
        <Counter label="Extra" initial={100} x={280} y={50} />
      )}

      <InputField x={10} y={210} />
      <CounterWithInput x={10} y={280} />
      <ControlledInput x={10} y={330} />
      <EffectLogger x={10} y={390} />
    </>
  )
}

const hwnd = gui.CreateWindow(
  'ComplexTest', 'Complex React Test',
  gui.WindowStyle.OVERLAPPEDWINDOW,
  100, 100, 520, 480, null, null
)

if (hwnd) {
  gui.ShowWindow(hwnd)
  render(<App />, hwnd)
  
  mockSetInterval(() => {
    console.log('\n=== Window Tree ===')
    printWindowTree(hwnd)
    console.log('===================\n')
  }, 3000)
}
