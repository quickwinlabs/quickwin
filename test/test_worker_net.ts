import { Tester } from './test_helper.js'
import * as os from 'os'

export const suite = {
    name: 'worker-http',
    run: async (t: Tester) => {
        t.section('import-inside')
        let worker1: any
        const { data: r1 } = await new Promise<any>((resolve, reject) => {
            worker1 = new os.Worker('./worker_http.js')
            const timer = os.setTimeout(() => reject(new Error('timeout')), 15000)
            worker1.onmessage = (e: any) => {
                os.clearTimeout(timer)
                resolve({ worker: worker1, data: e.data })
            }
            worker1.postMessage({ type: 'start' })
        })
        t.check('message type', 'result', r1.type)
        t.checkTrue('isArray([])', r1.isArrayWorks)
        t.checkTrue('isArray({}) rejects', r1.isArrayRejects)

        worker1.postMessage({ type: 'done' })

        t.section('http-entry')
        let worker2: any
        try {
            worker2 = new os.Worker('https://esm.sh/isarray')
            await new Promise<void>(resolve => os.setTimeout(() => resolve(), 3000))
            t.checkTrue('worker created with http url', true)
        } catch (e) {
            t.checkTrue('worker creation failed: ' + e, false)
        }

        t.section('npm-package')
        let worker3: any
        try {
            const { data: r3 } = await new Promise<any>((resolve, reject) => {
                worker3 = new os.Worker('https://cdn.jsdelivr.net/npm/quickwin/test/worker_module.js')
                const timer = os.setTimeout(() => reject(new Error('timeout')), 15000)
                worker3.onmessage = (e: any) => {
                    os.clearTimeout(timer)
                    resolve({ worker: worker3, data: e.data })
                }
                worker3.postMessage({ type: 'start' })
            })
            t.check('npm worker message type', 'result', r3.type)
            t.check('npm worker imported value', 42, r3.value)
            worker3.postMessage({ type: 'done' })
        } catch (e) {
            t.checkTrue('npm worker failed: ' + e, false)
        }
    }
}
