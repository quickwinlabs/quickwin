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

const SCREENSHOT_TIMEOUT_MS = 30_000
const WINDOWS_TIMEOUT_MS = 5_000

interface WindowEntry {
    hwnd: number
    title: string
    className: string
    rect: { left: number; top: number; right: number; bottom: number }
    visible: boolean
    minimized: boolean
}

interface WorkerResult {
    type: string
    id?: number
    chunk?: Uint8Array
    error?: string | null
    width?: number
    height?: number
    windows?: WindowEntry[]
}

// /screenshot 与 /windows 复用同一个 worker（同一份 WORKER_DATA_URL），但消息类型不是 'run'：
// 它们不起子进程，也就没有 innerPid，/exec 那套 kill/超时树杀逻辑天然不适用。
// 帧格式沿用 {type:'data',chunk} / {type:'result'}，这里只是按类型攒块或直接取字段。
function withWorker<R>(
    timeoutMs: number,
    onTimeout: () => R,
    post: Record<string, unknown>,
    onData: (chunk: Uint8Array) => void,
    onResult: (msg: WorkerResult) => R
): Promise<R> {
    return new Promise((resolve) => {
        const worker = new os.Worker(WORKER_DATA_URL)
        const id = 1
        let settled = false
        let timer: ReturnType<typeof os.setTimeout> | null = null

        const settle = (r: R): void => {
            if (settled) return
            settled = true
            if (timer !== null) os.clearTimeout(timer)
            worker.onmessage = null
            resolve(r)
        }

        // 兜底：worker 若静默挂掉（绑定失败等）不会发任何消息，避免请求永久悬挂。
        timer = os.setTimeout(() => settle(onTimeout()), timeoutMs)

        worker.onmessage = (e) => {
            const msg = e.data as WorkerResult
            if (msg.id !== undefined && msg.id !== id) return
            if (msg.type === 'data') { onData(msg.chunk as Uint8Array); return }
            if (msg.type !== 'result') return
            settle(onResult(msg))
        }

        try {
            worker.postMessage(post)
        } catch (ex) {
            settle(onResult({ type: 'error', error: 'spawn: ' + String(ex) }))
        }
    })
}

function jsonError(status: number, msg: string): Response {
    return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    })
}

interface ShotOpts {
    hwnd: number | null
    area: 'window' | 'client'
    mode: 'screen' | 'print'
}

function parseShotOpts(params: URLSearchParams): ShotOpts {
    const area = params.get('area') ?? 'window'
    const mode = params.get('mode') ?? 'screen'
    if (area !== 'window' && area !== 'client') throw new Error('area must be "window" or "client"')
    if (mode !== 'screen' && mode !== 'print') throw new Error('mode must be "screen" or "print"')

    const raw = params.get('hwnd')
    if (raw === null || raw === '') return { hwnd: null, area, mode }
    const hwnd = Number(raw)
    if (!Number.isInteger(hwnd) || hwnd <= 0) throw new Error('hwnd must be a positive integer')
    return { hwnd, area, mode }
}

function windowsResponse(): Promise<Response> {
    return withWorker(WINDOWS_TIMEOUT_MS, () => jsonError(504, 'windows timeout'),
        { type: 'windows', id: 1 },
        () => { },
        (msg) => msg.error
            ? jsonError(500, msg.error)
            : new Response(JSON.stringify(msg.windows ?? []), { headers: { 'Content-Type': 'application/json' } }))
}

function screenshotResponse(opts: ShotOpts): Promise<Response> {
    const parts: Uint8Array[] = []
    let total = 0
    const post: Record<string, unknown> = { type: 'screenshot', id: 1 }
    if (opts.hwnd !== null) {
        post.hwnd = opts.hwnd
        post.area = opts.area
        post.mode = opts.mode
    }
    return withWorker(SCREENSHOT_TIMEOUT_MS, () => jsonError(504, 'screenshot timeout'), post,
        (c) => { parts.push(c); total += c.byteLength },
        (msg) => {
            if (msg.error) return jsonError(500, msg.error)
            if (total === 0) return jsonError(500, 'empty capture')
            const buf = new Uint8Array(total)
            let off = 0
            for (const p of parts) { buf.set(p, off); off += p.byteLength }
            const dims = msg.width !== undefined && msg.height !== undefined
                ? msg.width + 'x' + msg.height
                : ''
            return new Response(buf, {
                headers: { 'Content-Type': 'image/bmp', 'X-Dimensions': dims }
            })
        })
}

const server = createServer(async (req) => {
    const path = new URL(req.url).pathname
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
        return new Response('ok', { headers: { 'Content-Type': 'text/plain' } })
    }
    if (req.method === 'GET' && path === '/windows') {
        return windowsResponse()
    }
    if (req.method === 'GET' && path === '/screenshot') {
        let opts: ShotOpts
        try {
            opts = parseShotOpts(new URL(req.url).searchParams)
        } catch (ex) {
            return jsonError(400, String(ex))
        }
        return screenshotResponse(opts)
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
