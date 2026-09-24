import { createServer } from '../lib/http-server.js'
import * as os from 'os'

// WORKER_DATA_URL 由 esbuild --define 在 build.ts 中注入（base64 data: URL）
declare const WORKER_DATA_URL: string

const EXEC_TIMEOUT_MS = 60_000

interface ExecResult {
    out: Uint8Array
    code: number
    error: string | null
}

function runInWorker(cmd: string): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
        const worker = new os.Worker(WORKER_DATA_URL)
        const id = 1
        let settled = false
        let timer: ReturnType<typeof os.setTimeout>

        const finish = (fn: () => void) => {
            if (settled) return
            settled = true
            os.clearTimeout(timer)
            worker.onmessage = null
            fn()
        }

        timer = os.setTimeout(() => {
            finish(() => reject(new Error('exec timeout')))
        }, EXEC_TIMEOUT_MS)

        worker.onmessage = (e) => {
            const msg = e.data as { type: string; id: number; out?: Uint8Array; code?: number; error?: string | null }
            if (msg.type !== 'result' || msg.id !== id) return
            finish(() => resolve({ out: msg.out ?? new Uint8Array(0), code: msg.code ?? -1, error: msg.error ?? null }))
        }

        try {
            worker.postMessage({ type: 'run', id, cmd })
        } catch (ex) {
            finish(() => reject(ex instanceof Error ? ex : new Error(String(ex))))
        }
    })
}

const server = createServer(async (req) => {
    const path = new URL(req.url).pathname
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
        return new Response('ok', { headers: { 'Content-Type': 'text/plain' } })
    }
    if (req.method === 'POST' && path === '/exec') {
        const body = await req.json() as { cmd: string }
        try {
            const { out, code, error } = await runInWorker(body.cmd)
            if (error) {
                return new Response(JSON.stringify({ error }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                })
            }
            return new Response(out, {
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'X-Exit-Code': String(code),
                }
            })
        } catch (ex) {
            return new Response(JSON.stringify({ error: String(ex) }), {
                status: 504,
                headers: { 'Content-Type': 'application/json' }
            })
        }
    }
    return new Response('Not Found', { status: 404 })
})

const rc = server.listen(8080, '0.0.0.0')
console.log('listen rc=' + rc + ' addr=' + JSON.stringify(server.address()))
