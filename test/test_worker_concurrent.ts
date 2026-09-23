import { Tester } from './test_helper.js'
import * as os from 'os'
import * as std from 'std'

interface RoundResults {
    type: string
    value: number
}

function runRound(): Promise<RoundResults[]> {
    const ids = [1, 2]
    return Promise.all(ids.map((id) =>
        new Promise<RoundResults>((resolve, reject) => {
            const worker: any = new os.Worker('./worker_module.js')
            const timer = os.setTimeout(() => {
                worker.onmessage = null
                reject(new Error(`worker ${id} timeout`))
            }, 5000)
            worker.onmessage = (e: any) => {
                os.clearTimeout(timer)
                worker.postMessage({ type: 'done' })
                worker.onmessage = null
                resolve(e.data)
            }
            worker.postMessage({ type: 'start' })
        })
    ))
}

export const suite = {
    name: 'worker-concurrent',
    run: async (t: Tester) => {
        t.section('dual-worker-init')
        const N = 20
        let ok = 0
        let lastErr: unknown = null
        for (let i = 0; i < N; i++) {
            try {
                const results = await runRound()
                if (
                    results.length === 2 &&
                    results.every((r) => r.type === 'result' && r.value === 42)
                ) {
                    ok++
                }
            } catch (e) {
                lastErr = e
                break
            }
        }
        if (ok !== N && lastErr) {
            std.printf('round error: %s\n', String(lastErr))
        }
        t.check('concurrent dual-worker rounds', N, ok)
    }
}
