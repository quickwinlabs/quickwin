import { createServer } from '../lib/http-server.js'
import * as os from 'os'
import * as std from 'std'

// WORKER_DATA_URL 由 esbuild --define 在 build.ts 中注入（base64 data: URL）
declare const WORKER_DATA_URL: string

interface ExecHandle {
    stream: ReadableStream<Uint8Array>
    ready: Promise<{ ok: boolean; error?: string }>
    trailers: Promise<HeadersInit>
    kill: () => void
}

// timeoutMs <= 0 / null/NaN → 无上限：连接活着命令就一直跑，断连才 kill。
function runInWorker(cmd: string, signal: AbortSignal | null, timeoutMs: number | null): ExecHandle {
    // worker 内以 "system32\cmd.exe /c <cmd>" 启动，保留 cmd shell 语义（内部命令/管道/for），
    // cmd.exe 路径由 worker 用 GetSystemDirectoryW 拼（CreateProcess 直接 PATH 解析在本环境失败）。
    // 子进程树由 CreateProcessW 返回的 pid 定位，超时/断开时 taskkill /T 递归杀掉。
    const spawnCmd = cmd
    const worker = new os.Worker(WORKER_DATA_URL)
    const id = 1
    let innerPid: number | null = null
    let settled = false
    let readySettled = false
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    let timer: ReturnType<typeof os.setTimeout> | null = null

    const settleReady = (v: { ok: boolean; error?: string }): void => {
        readySettled = true
        resolveReady(v)
    }
    const failReady = (e: Error): void => {
        readySettled = true
        rejectReady(e)
    }

    let resolveReady!: (v: { ok: boolean; error?: string }) => void
    let rejectReady!: (e: Error) => void
    let resolveTrailers!: (v: HeadersInit) => void
    const ready = new Promise<{ ok: boolean; error?: string }>((res, rej) => {
        resolveReady = res
        rejectReady = rej
    })
    const trailers = new Promise<HeadersInit>((res) => { resolveTrailers = res })

    const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (timer !== null) os.clearTimeout(timer)
        worker.onmessage = null
        fn()
    }

    // kill 整棵树：winpty_spawn 拿到的 pid 即 cmd.exe 根，taskkill /T 递归。
    // 杀掉后 worker 侧 ReadFile 断管道自动收尾、winpty_free 兜底关 console。
    const kill = (): void => {
        if (innerPid === null) return
        try {
            const p = std.popen('taskkill /F /T /PID ' + innerPid, 'r')
            if (p) p.close()
            else console.error('[exec_server] taskkill spawn failed')
        } catch (ex) {
            console.error('[exec_server] kill error:', ex)
        }
    }

    // 客户端断连 → 立即 kill（不等 60s 超时）。abort 事件同步触发；
    // 若断连发生在 worker 尚未回报 innerPid 时无法 kill，则在 'info' 到达后补刀。
    const killOnAbort = (): void => { kill() }
    if (signal) {
        signal.addEventListener('abort', killOnAbort)
        if (signal.aborted) killOnAbort()
    }

    if (timeoutMs != null && timeoutMs > 0) {
        timer = os.setTimeout(() => {
            finish(() => {
                kill()
                resolveTrailers({ 'X-Exit-Code': '-1' })
                if (readySettled) {
                    // 已有输出（200 已发）：正常收尾（尾帧 + trailer -1）
                    if (controller) controller.close()
                } else {
                    // 尚无任何输出：Response 未发，安全地报超时
                    failReady(new Error('exec timeout'))
                }
            })
        }, timeoutMs)
    }

    worker.onmessage = (e) => {
        const msg = e.data as { type: string; id?: number; chunk?: Uint8Array; code?: number; pid?: number; error?: string | null }
        if (msg.id !== undefined && msg.id !== id) return
        switch (msg.type) {
            case 'info':
                innerPid = msg.pid ?? null
                if (innerPid !== null && signal?.aborted) kill()
                break
            case 'data':
                settleReady({ ok: true })
                if (controller) controller.enqueue(msg.chunk as Uint8Array)
                break
            case 'result':
                finish(() => {
                    if (controller) controller.close()
                    if (msg.error) settleReady({ ok: false, error: msg.error })
                    else settleReady({ ok: true })
                })
                resolveTrailers({ 'X-Exit-Code': String(msg.code ?? -1) })
                break
        }
    }

    const stream = new ReadableStream<Uint8Array>({
        start(c) { controller = c },
        cancel() {
            // http-server 在断连时主动 cancel 响应体 → 落这里 kill 子进程
            finish(() => kill())
        }
    })

    try {
        worker.postMessage({ type: 'run', id, cmd: spawnCmd })
    } catch (ex) {
        finish(() => {
            failReady(ex instanceof Error ? ex : new Error(String(ex)))
            resolveTrailers({ 'X-Exit-Code': '-1' })
        })
    }

    return { stream, ready, trailers, kill }
}

const server = createServer(async (req) => {
    const path = new URL(req.url).pathname
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
        return new Response('ok', { headers: { 'Content-Type': 'text/plain' } })
    }
    if (req.method === 'POST' && path === '/exec') {
        let out: ExecHandle
        try {
            const body = await req.json() as { cmd: string; timeout?: unknown }
            const t = body.timeout
            const timeoutMs: number | null = typeof t === 'number' && Number.isFinite(t) && t > 0
                ? t
                : null
            out = runInWorker(body.cmd, req.signal, timeoutMs)
        } catch (ex) {
            return new Response(JSON.stringify({ error: 'setup: ' + String(ex) }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            })
        }
        try {
            const rd = await out.ready
            if (!rd.ok) {
                return new Response(JSON.stringify({ error: rd.error }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                })
            }
            return new Response(out.stream, {
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Trailer': 'X-Exit-Code',
                },
                trailers: out.trailers
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
