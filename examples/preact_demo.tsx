import '../lib/polyfill.js'
import * as gui from 'gui'
import { useState } from '../lib/preact/hooks.js'
import { render, notifyResize } from '../lib/preact/render.js'

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
    100, 100, 600, 400, null, null)

function App() {
    const [count, setCount] = useState(0)

    return (
        <w style={{ flexDirection: 'column', padding: 10, gap: 8 }}>
            <w type="static" text={`Counter: ${count}`} style={{ height: 24 }} />
            <w style={{ flexDirection: 'row', gap: 8 }}>
                <w type="button" text="+1" style={{ width: 80, height: 28 }} onEvent={(e) => { if (e.msg === gui.WmMsg.LBUTTONDOWN) setCount(count + 1) }} />
                <w type="button" text="-1" style={{ width: 80, height: 28 }} onEvent={(e) => { if (e.msg === gui.WmMsg.LBUTTONDOWN) setCount(count - 1) }} />
            </w>
            <w type="edit" value="test input" style={{ height: 26 }} />
        </w>
    )
}

gui.ShowWindow(mainWnd)
render(<App />, mainWnd)
