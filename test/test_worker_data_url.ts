import { Tester } from './test_helper.js'
import * as os from 'os'

// base64 of worker body (see comment). Split manually to keep lines short.
const B64_WORKER =
    'aW1wb3J0ICogYXMgb3MgZnJvbSAnb3MnCmNvbnN0IHBhcmVudCA9IG9zLldvcmtlci5wYXJl' +
    'bnQKcGFyZW50Lm9ubWVzc2FnZSA9IChlKSA9PiB7CiAgICBjb25zdCBkID0gZS5kYXRhCiAg' +
    'ICBpZiAoZC50eXBlID09PSAnc3RhcnQnKSBwYXJlbnQucG9zdE1lc3NhZ2UoeyB0eXBlOiAn' +
    'cmVzdWx0JywgdmFsdWU6IDQyIH0pCiAgICBlbHNlIGlmIChkLnR5cGUgPT09ICdkb25lJykg' +
    'cGFyZW50Lm9ubWVzc2FnZSA9IG51bGwKfQo='

const DATA_WORKER = 'data:text/javascript;base64,' + B64_WORKER

// export const answer = 42\n
const DATA_MOD = 'data:text/javascript;base64,ZXhwb3J0IGNvbnN0IGFuc3dlciA9IDQyCg=='

export const suite = {
    name: 'worker-data-url',
    run: async (t: Tester) => {
        t.section('base64-worker-entry')
        let worker: any
        try {
            const { data: result } = await new Promise<any>((resolve, reject) => {
                worker = new os.Worker(DATA_WORKER)
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
        } catch (e) {
            t.checkTrue('data url worker failed: ' + e, false)
            if (worker) {
                worker.onmessage = null
            }
        }

        t.section('dynamic-import-data-url')
        try {
            const mod = await import(DATA_MOD)
            t.check('import(data:) answer', 42, (mod as any).answer)
        } catch (e) {
            t.checkTrue('import(data:) failed: ' + e, false)
        }
    }
}
