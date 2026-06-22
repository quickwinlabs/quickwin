import '../lib/fetch.js'
import * as os from 'os'
const parent = os.Worker.parent

parent.onmessage = (e: any) => {
    if (e.data.type === 'start') {
        fetch('https://example.com/')
            .then(r => parent.postMessage({ type: 'result', ok: r.ok, status: r.status }))
            .catch(err => parent.postMessage({ type: 'error', msg: String(err) }))
    } else if (e.data.type === 'done') {
        parent.onmessage = null
    }
}
