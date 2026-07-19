import * as os from 'os'
import { value } from './worker_helper.js'

const parent = os.Worker.parent

parent.onmessage = (e) => {
    const d = e.data as { type: string }
    if (d.type === 'start') {
        parent.postMessage({ type: 'result', value })
    } else if (d.type === 'done') {
        parent.onmessage = null
    }
}
