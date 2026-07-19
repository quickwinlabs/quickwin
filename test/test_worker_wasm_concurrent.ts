import { Tester, readWasmFile } from './test_helper.js'
import * as os from 'os'

export const suite = {
    name: 'worker-wasm',
    run: async (t: Tester) => {
        const wasmBuf = readWasmFile('./add.wasm')
        if (!wasmBuf) { t.fail++; return }

        const complexBuf = readWasmFile('./complex.wasm')
        if (!complexBuf) { t.fail++; return }

        t.section('concurrent')

        const worker = new os.Worker('./worker_wasm_concurrent.js')
        const workerResult = new Promise<any>((resolve, reject) => {
            const timer = os.setTimeout(() => reject(new Error('worker timeout')), 5000)
            worker.onmessage = (e: any) => {
                os.clearTimeout(timer)
                resolve(e.data)
            }
            worker.postMessage({
                type: 'start',
                wasmBuf,
                calls: [['add', [1, 2]], ['add', [10, 20]]]
            })
        })

        const mainMod = new WebAssembly.Module(wasmBuf)
        const mainInst = new WebAssembly.Instance<{ add: (a: number, b: number) => number }>(mainMod)
        const mainExp = mainInst.exports
        const mainR1 = mainExp.add(1, 2)
        const mainR2 = mainExp.add(10, 20)

        const wr = await workerResult
        t.check('main add(1, 2)', 3, mainR1)
        t.check('main add(10, 20)', 30, mainR2)
        t.check('worker ok', true, wr.ok)
        t.check('worker add(1, 2)', 3, wr.results[0])
        t.check('worker add(10, 20)', 30, wr.results[1])

        worker.postMessage({ type: 'done' })
    }
}
