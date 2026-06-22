import * as os from 'os'
import { value } from './worker_helper.js'

const parent = os.Worker.parent

parent.onmessage = (e) => {
    if (e.data.type === 'start') {
        parent.postMessage({ type: 'result', value })
    } else if (e.data.type === 'done') {
        parent.onmessage = null
    }
}
