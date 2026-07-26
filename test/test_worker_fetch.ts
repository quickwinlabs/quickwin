import { Tester } from './test_helper.js'
import * as os from 'os'

export const suite = {
    name: 'worker-fetch',
    run: async (t: Tester) => {
        t.section('fetch-in-worker')
        let worker: any
        const { data: result } = await new Promise<any>((resolve, reject) => {
            worker = new os.Worker('./worker_fetch.js')
            const timer = os.setTimeout(() => reject(new Error('timeout')), 15000)
            worker.onmessage = (e: any) => {
                os.clearTimeout(timer)
                resolve({ worker, data: e.data })
            }
            worker.postMessage({ type: 'start' })
        })
        if (result.type === 'result') {
            t.checkTrue('fetch ok', result.ok)
            t.check('status', result.status, 200)
        } else {
            t.checkTrue('worker fetch failed: ' + result.msg, false)
        }
        worker.postMessage({ type: 'done' })
        worker.onmessage = null
    }
}
