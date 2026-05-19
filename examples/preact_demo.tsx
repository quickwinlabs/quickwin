import '../lib/polyfill.js'
import { options as preactOptions } from '../lib/preact/preact.js'
import { useState } from '../lib/preact/hooks.js'
import { render, setPreactOptions } from '../lib/preact/render.js'

setPreactOptions(preactOptions)

function App() {
    const [count, setCount] = useState(0)

    return (
        <w type="div" style={{ flexDirection: 'column', padding: 10, gap: 8 }}>
            <w type="static" text={`Counter: ${count}`} style={{ height: 24 }} />
            <w type="div" style={{ flexDirection: 'row', gap: 8 }}>
                <w type="button" text="+1" style={{ width: 80, height: 28 }} onEvent={(e: any) => { if (e.type === 'click') setCount(count + 1) }} />
                <w type="button" text="-1" style={{ width: 80, height: 28 }} onEvent={(e: any) => { if (e.type === 'click') setCount(count - 1) }} />
            </w>
            <w type="edit" value="test input" style={{ height: 26 }} />
        </w>
    )
}

render(<App />)
