import * as os from 'os'
import { value } from './worker_helper.js'

const parent = os.Worker.parent
// @ts-ignore
// console.log('Hello from worker', globalThis)

parent.onmessage = (e) => {
    console.log(e)
    if (e.data.type === 'start') {
        console.log(e.data.type)
        parent.postMessage({ type: 'result', value })
    } else if (e.data.type === 'done') {
        parent.onmessage = null
    }
}
