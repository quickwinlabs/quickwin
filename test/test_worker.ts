import { Tester } from './test_helper.js'
import * as os from 'os'
import * as std from 'std'

export const suite = {
    name: 'worker',
    run: async (t: Tester) => {
        t.section('relative-import')
        let worker: os.Worker
        const { data: result } = await new Promise<any>((resolve, reject) => {
            worker = new os.Worker('./worker_module.js')
            const timer = os.setTimeout(() => reject(new Error('worker timeout')), 5000)
            worker.onmessage = (e: any) => {
                os.clearTimeout(timer)
                resolve({  data: e.data })  // resolve 引用 worker，防止 GC 回收（QuickJS bug workaround）
            }
            worker.postMessage({ type: 'start' })
        })
        t.check('message type', 'result', result.type)
        t.check('imported value', 42, result.value)
    }
}
