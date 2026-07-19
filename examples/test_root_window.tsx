import '../lib/polyfill.js'
import { useState } from 'react'
import { Button, Input, createRoot } from '../lib/react-qw/index.js'
import * as gui from 'gui'

function Counter() {
  const [count, setCount] = useState(0)
  return (
    <w type="STATIC" ws={gui.WindowStyle.VISIBLE}
      style={{ flexDirection: 'column', gap: 8, flexGrow: 1 }}>
      <w type="STATIC" ws={gui.WindowStyle.VISIBLE}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Button onClick={() => setCount(c => c + 1)}>Count: {count}</Button>
        <Button onClick={() => setCount(0)}>Reset</Button>
      </w>
      <Input placeholder="Type something..." />
      <w type="STATIC" text={`You clicked ${count} times`} />
    </w>
  )
}

function Logger() {
  const [logs, setLogs] = useState<string[]>([])
  const add = () => setLogs(prev => [...prev, `log ${prev.length + 1}`])
  return (
    <w type="STATIC" ws={gui.WindowStyle.VISIBLE}
      style={{ flexDirection: 'column', gap: 8, flexGrow: 1 }}>
      <Button onClick={add}>Add Log</Button>
      <w type="STATIC" ws={gui.WindowStyle.VISIBLE}
        style={{ flexDirection: 'column', gap: 4, flexGrow: 1 }}>
        {logs.map((l, i) => <w key={String(i)} type="STATIC" text={l} />)}
      </w>
    </w>
  )
}

const win1 = createRoot({ text: 'Counter', x: 100, y: 100, width: 420, height: 340 })
win1.render(<Counter />)

const win2 = createRoot({ text: 'Logger', x: 550, y: 100, width: 420, height: 340 })
win2.render(<Logger />)
