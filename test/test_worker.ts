import { Tester } from './test_helper.js'
import * as os from 'os'

export const suite = {
    name: 'worker',
    run: async (t: Tester) => {
        t.section('relative-import')
        let worker: any
        const { data: result } = await new Promise<any>((resolve, reject) => {
            worker = new os.Worker('./worker_module.js')
            const timer = os.setTimeout(() => reject(new Error('worker timeout')), 5000)
            worker.onmessage = (e: any) => {
                os.clearTimeout(timer)
                resolve({ data: e.data })
            }
            worker.postMessage({ type: 'start' })
        })
        t.check('message type', 'result', result.type)
        t.check('imported value', 42, result.value)

        worker.postMessage({ type: 'done' })
        worker.onmessage = null
    }
}
