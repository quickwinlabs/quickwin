import '../lib/polyfill.js'
import * as gui from 'gui'
import * as ffi from 'ffi'
import * as win from 'win'
import { useState } from '../lib/preact/hooks.js'
import { render, notifyResize, scaleFactor } from '../lib/preact/render.js'
import { Button } from '../lib/preact/components/Button.js'
import { EditBox } from '../lib/preact/components/EditBox.js'
import { ListBox } from '../lib/preact/components/ListBox.js'
import { Tab } from '../lib/preact/components/Tab.js'
import { ListView } from '../lib/preact/components/ListView.js'

const _user32 = win.LoadLibrary('user32.dll')
const GetSystemMetrics = _user32 ? win.GetProcAddress(_user32, 'GetSystemMetrics') : 0
const winW = 600 * scaleFactor
const winH = 400 * scaleFactor
const cxScreen = GetSystemMetrics ? (ffi.ffiCall(GetSystemMetrics, [ffi.FFI_TYPE_SINT32], [gui.SysMetrics.CXSCREEN], ffi.FFI_TYPE_SINT32) as number) : 1920
const cyScreen = GetSystemMetrics ? (ffi.ffiCall(GetSystemMetrics, [ffi.FFI_TYPE_SINT32], [gui.SysMetrics.CYSCREEN], ffi.FFI_TYPE_SINT32) as number) : 1080
const winX = Math.max(0, (cxScreen - winW) / 2)
const winY = Math.max(0, (cyScreen - winH) / 2)

gui.RegisterClass('DemoApp', (hwnd, msg, wParam, lParam) => {
    switch (msg) {
        case gui.WmMsg.DESTROY:
            gui.PostQuitMessage(0)
            return 0
        case gui.WmMsg.SIZE:
            notifyResize(hwnd)
            return 0
    }
    return gui.DefWindowProc(hwnd, msg, wParam, lParam)
})

const mainWnd = gui.CreateWindow('DemoApp', 'Preact Demo',
    gui.WindowStyle.OVERLAPPEDWINDOW,
    winX, winY, winW, winH, null, null)

const fruits = ['Apple', 'Banana', 'Cherry', 'Durian', 'Elderberry']

function App() {
    const [count, setCount] = useState(0)
    const [text, setText] = useState('hello')
    const [selFruit, setSelFruit] = useState('(none)')

    return (
        <w type="STATIC" style={{ flexDirection: 'column', padding: 10, gap: 8 }}>
            <w type="STATIC" text={`Counter: ${count}`} style={{ height: 24 }} />
            <w type="STATIC" style={{ flexDirection: 'row', gap: 8 }}>
                <Button text="+1" onClick={() => setCount(count + 1)} style={{ width: 80, height: 28 }} />
                <Button text="-1" onClick={() => setCount(count - 1)} style={{ width: 80, height: 28 }} />
            </w>
            <EditBox value={text} onChange={setText} style={{ height: 26 }} />
            <w type="STATIC" text={`echo: ${text}`} style={{ height: 24 }} />
            <w type="STATIC" text={`fruit: ${selFruit}`} style={{ height: 24 }} />
            <ListBox items={fruits} onChange={(i, t) => setSelFruit(t)} style={{ height: 120 }} />
            <ListView columns={[
                { title: 'Name', width: 150 },
                { title: 'Color', width: 100 },
                { title: 'Price', width: 80 },
            ]} items={[
                ['Apple', 'Red', '$1.20'],
                ['Banana', 'Yellow', '$0.80'],
                ['Cherry', 'Dark Red', '$2.50'],
                ['Durian', 'Green', '$5.00'],
                ['Elderberry', 'Purple', '$3.00'],
            ]} onChange={(i) => {
                const row = [['Apple', 'Red', '$1.20'], ['Banana', 'Yellow', '$0.80'], ['Cherry', 'Dark Red', '$2.50'], ['Durian', 'Green', '$5.00'], ['Elderberry', 'Purple', '$3.00']][i]
                setSelFruit(row ? row[0] : '(none)')
            }} style={{ flex: 1 }} />
            <Tab tabs={[
                { title: 'Hello', content: <w type="STATIC" text="Hello tab!" /> },
                { title: 'World', content: <w type="STATIC" text="World tab!" /> },
            ]} style={{ flex: 1 }} />
        </w>
    )
}

gui.ShowWindow(mainWnd)
render(<App />, mainWnd)
