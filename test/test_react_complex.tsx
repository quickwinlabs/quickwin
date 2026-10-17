import '../lib/polyfill.js'
import * as gui from 'gui'
import * as os from 'os'
import { useState, useEffect, useRef } from 'react'
import { render } from '../lib/react-qw/index.js'
import { GetWindow, GetWindowText, GetWindowTextLength, IsWindow, PostQuitMessage, ShowWindow } from '../lib/windows/user32.js'
import { WCHAR } from '../lib/ffi/bind.js'
import { GetWindowCmd, ShowWindowCmd, WindowStyle, WmMsg } from '../constants'

// 打印窗口树
function printWindowTree(hwnd: gui.HWND, indent: number = 0) {
  if (!hwnd) return
  const prefix = '  '.repeat(indent)
  let text = '(no text)'
  try {
    const cap = GetWindowTextLength(hwnd) + 1
    const buf = WCHAR.alloc(cap)
    GetWindowText(hwnd, buf, cap)
    text = WCHAR.decode(buf) || '(no text)'
  } catch (e) {
    text = '(error)'
  }
  const isWindow = IsWindow(hwnd)
  console.log(`${prefix}hwnd=${hwnd}, text="${text}", IsWindow=${isWindow}`)
  
  let child = GetWindow(hwnd, GetWindowCmd.CHILD)
  while (child) {
    printWindowTree(child, indent + 1)
    child = GetWindow(child, GetWindowCmd.NEXT)
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
  if (msg === WmMsg.DESTROY) {
    PostQuitMessage(0)
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
      ws={WindowStyle.CHILD | WindowStyle.VISIBLE}
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
      ws={WindowStyle.CHILD | WindowStyle.VISIBLE | WindowStyle.BORDER | WindowStyle.CLIPCHILDREN}
      style={{width:460, height:100, flexDirection:'row', padding:15, gap:10, alignItems:'center'}}
    >
      <w
        type="BUTTON"
        text={`Nested A: ${clicks}`}
        ws={WindowStyle.CHILD | WindowStyle.VISIBLE}
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
        ws={WindowStyle.CHILD | WindowStyle.VISIBLE}
        style={{width:160, height:25}}
      />
      <w
        type="BUTTON"
        text="Reset"
        ws={WindowStyle.CHILD | WindowStyle.VISIBLE}
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
      ws={WindowStyle.CHILD | WindowStyle.VISIBLE}
      style={{flexDirection:'column', gap:4}}
    >
      <w
        type="STATIC"
        ws={WindowStyle.CHILD | WindowStyle.VISIBLE}
        style={{flexDirection:'row', gap:10, alignItems:'center'}}
      >
        <w
          type="EDIT"
          text="type here"
          ws={WindowStyle.CHILD | WindowStyle.VISIBLE | WindowStyle.BORDER}
          style={{width:160, height:24}}
          ref={editRef}
        />
        <w
          type="BUTTON"
          text="Read"
          ws={WindowStyle.CHILD | WindowStyle.VISIBLE}
          style={{width:60, height:24}}
          onEvent={(e: any) => {
            if (e.msg === WM_LBUTTONUP && editRef.current) {
              const cap = GetWindowTextLength(editRef.current) + 1
              const buf = WCHAR.alloc(cap)
              GetWindowText(editRef.current, buf, cap)
              setText(WCHAR.decode(buf))
            }
          }}
        />
      </w>
      <w
        type="STATIC"
        text={`Input: ${text}`}
        ws={WindowStyle.CHILD | WindowStyle.VISIBLE | WindowStyle.BORDER}
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
      ws={WindowStyle.CHILD | WindowStyle.VISIBLE}
      style={{flexDirection:'row', gap:10, alignItems:'center'}}
    >
      <w
        type="EDIT"
        text="0"
        ws={WindowStyle.CHILD | WindowStyle.VISIBLE | WindowStyle.BORDER}
        style={{width:60, height:24}}
        ref={inputRef}
      />
      <w
        type="BUTTON"
        text="Start"
        ws={WindowStyle.CHILD | WindowStyle.VISIBLE}
        style={{width:60, height:24}}
        onEvent={(e: any) => {
          if (e.msg === WM_LBUTTONUP && inputRef.current) {
            const cap = GetWindowTextLength(inputRef.current) + 1
            const buf = WCHAR.alloc(cap)
            GetWindowText(inputRef.current, buf, cap)
            const val = parseInt(WCHAR.decode(buf) || '0', 10)
            setDisplayValue(val)
            setCount(0)
          }
        }}
      />
      <w
        type="BUTTON"
        text={`Count: ${displayValue + count}`}
        ws={WindowStyle.CHILD | WindowStyle.VISIBLE}
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
      ws={WindowStyle.CHILD | WindowStyle.VISIBLE | WindowStyle.BORDER}
      style={{width:200, height:22}}
    />
  )
}

function ControlledInput() {
  const [value, setValue] = useState('')

  return (
    <w
      type="STATIC"
      ws={WindowStyle.CHILD | WindowStyle.VISIBLE}
      style={{flexDirection:'column', gap:4}}
    >
      <w
        type="EDIT"
        text={value}
        ws={WindowStyle.CHILD | WindowStyle.VISIBLE | WindowStyle.BORDER}
        style={{width:200, height:24}}
        onEvent={(e: any) => {
          if (e.msg === WmMsg.CHAR) {
            const cap = GetWindowTextLength(e.hwnd) + 1
            const buf = WCHAR.alloc(cap)
            GetWindowText(e.hwnd, buf, cap)
            setValue(WCHAR.decode(buf))
          }
        }}
      />
      <w
        type="STATIC"
        text={`Controlled: "${value}"`}
        ws={WindowStyle.CHILD | WindowStyle.VISIBLE | WindowStyle.BORDER}
        style={{width:300, height:22}}
      />
    </w>
  )
}

function App() {
  const [showExtra, setShowExtra] = useState(false)
  const [showNested, setShowNested] = useState(true)

  return (
    <w type="STATIC" ws={WindowStyle.VISIBLE} style={{flexDirection:'column', padding:10, gap:8}}>
      <w type="STATIC" ws={WindowStyle.VISIBLE} style={{flexDirection:'row', gap:10}}>
        <Counter label="Counter A" initial={0} />
        <Counter label="Counter B" initial={100} />
      </w>

      <w type="STATIC" ws={WindowStyle.VISIBLE} style={{flexDirection:'row', gap:10}}>
        <w
          type="BUTTON"
          text="Toggle Extra"
          ws={WindowStyle.CHILD | WindowStyle.VISIBLE}
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
          ws={WindowStyle.CHILD | WindowStyle.VISIBLE}
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
  WindowStyle.OVERLAPPEDWINDOW,
  100, 100, 520, 480, null, null
)

if (hwnd) {
  ShowWindow(hwnd, ShowWindowCmd.SHOWNORMAL)
  render(<App />, hwnd)
  
  mockSetInterval(() => {
    console.log('\n=== Window Tree ===')
    printWindowTree(hwnd)
    console.log('===================\n')
  }, 3000)
}
