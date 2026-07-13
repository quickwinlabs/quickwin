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

const WM_LBUTTONUP = 0x202

function Counter({ label, initial = 0 }: { label: string; initial?: number }) {
  const [count, setCount] = useState(initial)
  return (
    <w
      type="BUTTON"
      text={`${label}: ${count}`}
      ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
      style={{width:180, height:30}}
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
      style={{width:460, height:100, flexDirection:'row', padding:15, gap:10, alignItems:'center'}}
    >
      <w
        type="BUTTON"
        text={`Nested A: ${clicks}`}
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
        style={{width:160, height:25}}
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
        style={{width:160, height:25}}
      />
      <w
        type="BUTTON"
        text="Reset"
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
        style={{width:60, height:29}}
        onEvent={(e: any) => {
          if (e.msg === WM_LBUTTONUP) {
            setClicks(0)
          }
        }}
      />
    </w>
  )
}

function InputField() {
  const [text, setText] = useState('')
  const editRef = useRef<gui.HWND>(null)

  return (
    <w
      type="STATIC"
      ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
      style={{flexDirection:'column', gap:4}}
    >
      <w
        type="STATIC"
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
        style={{flexDirection:'row', gap:10, alignItems:'center'}}
      >
        <w
          type="EDIT"
          text="type here"
          ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER}
          style={{width:160, height:24}}
          ref={editRef}
        />
        <w
          type="BUTTON"
          text="Read"
          ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
          style={{width:60, height:24}}
          onEvent={(e: any) => {
            if (e.msg === WM_LBUTTONUP && editRef.current) {
              setText(gui.GetWindowText(editRef.current))
            }
          }}
        />
      </w>
      <w
        type="STATIC"
        text={`Input: ${text}`}
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER}
        style={{width:300, height:22}}
      />
    </w>
  )
}

function CounterWithInput() {
  const [count, setCount] = useState(0)
  const [displayValue, setDisplayValue] = useState(0)
  const inputRef = useRef<gui.HWND>(null)

  return (
    <w
      type="STATIC"
      ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
      style={{flexDirection:'row', gap:10, alignItems:'center'}}
    >
      <w
        type="EDIT"
        text="0"
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER}
        style={{width:60, height:24}}
        ref={inputRef}
      />
      <w
        type="BUTTON"
        text="Start"
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
        style={{width:60, height:24}}
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
        style={{width:160, height:24}}
        onEvent={(e: any) => {
          if (e.msg === WM_LBUTTONUP) {
            setCount((c: number) => c + 1)
          }
        }}
      />
    </w>
  )
}

function EffectLogger() {
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
      style={{width:200, height:22}}
    />
  )
}

function ControlledInput() {
  const [value, setValue] = useState('')

  return (
    <w
      type="STATIC"
      ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
      style={{flexDirection:'column', gap:4}}
    >
      <w
        type="EDIT"
        text={value}
        ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER}
        style={{width:200, height:24}}
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
        style={{width:300, height:22}}
      />
    </w>
  )
}

function App() {
  const [showExtra, setShowExtra] = useState(false)
  const [showNested, setShowNested] = useState(true)

  return (
    <w type="STATIC" ws={gui.WindowStyle.VISIBLE} style={{flexDirection:'column', padding:10, gap:8}}>
      <w type="STATIC" ws={gui.WindowStyle.VISIBLE} style={{flexDirection:'row', gap:10}}>
        <Counter label="Counter A" initial={0} />
        <Counter label="Counter B" initial={100} />
      </w>

      <w type="STATIC" ws={gui.WindowStyle.VISIBLE} style={{flexDirection:'row', gap:10}}>
        <w
          type="BUTTON"
          text="Toggle Extra"
          ws={gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE}
          style={{width:120, height:30}}
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
          style={{width:120, height:30}}
          onEvent={(e: any) => {
            if (e.msg === WM_LBUTTONUP) {
              console.log('[App] Toggle Nested button clicked, current showNested:', showNested)
              setShowNested(!showNested)
            }
          }}
        />
        {showExtra && <Counter label="Extra" initial={100} />}
      </w>

      {showNested && <NestedButtons />}

      <InputField />
      <CounterWithInput />
      <ControlledInput />
      <EffectLogger />
    </w>
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
