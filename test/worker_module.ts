import * as os from 'os'
import { value } from './worker_helper.js'

const parent = os.Worker.parent
// @ts-ignore
// console.log('Hello from worker', globalThis)

parent.onmessage = (e) => {
    console.log(e)
    const d = e.data as { type: string }
    if (d.type === 'start') {
        console.log(d.type)
        parent.postMessage({ type: 'result', value })
    } else if (d.type === 'done') {
        parent.onmessage = null
    }
}
