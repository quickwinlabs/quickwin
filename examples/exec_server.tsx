import { createServer } from '../lib/http-server.js'
import * as os from 'os'
import * as std from 'std'
import * as gui from 'gui'
import { RequestLog, type LogEntry } from '../lib/exec-log.js'
import { createRoot, ListBox } from '../lib/react-qw/index.js'
import { useEffect, useState } from 'react'

// WORKER_DATA_URL 由 esbuild --define 在 build.ts 中注入（base64 data: URL）
declare const WORKER_DATA_URL: string

interface ExecHandle {
    stream: ReadableStream<Uint8Array>
    ready: Promise<{ ok: boolean; error?: string }>
    trailers: Promise<HeadersInit>
    kill: () => void
}

// ── CLI 参数 ──

interface Cfg {
    /** 是否创建 GUI 日志窗口（--gui 0 关闭） */
    gui: boolean
    /** token 鉴权配置；null = 未配置（放行，兼容 CI） */
    token: string | null
}

// 只支持无值开关(--nogui)与等号形式(--gui=0/--token=x)。
// 不支持空格分隔值形式 "--gui 0"/"--token x"：main.c 的 js_file 探测(main.c:214-250)
// 会把裸值("0"/"x")当成脚本文件名,进程启动即 Failed to load 退出(见 .agents/TODO.md)。
function parseArgs(): Cfg {
    let gui = true
    let token: string | null = null
    const args = typeof scriptArgs === 'undefined' ? [] : scriptArgs
    for (let i = 0; i < args.length; i++) {
        const a = args[i] ?? ''
        if (a === '--nogui') { gui = false }
        else if (a.startsWith('--gui=')) { gui = a.slice(6) !== '0' }
        else if (a.startsWith('--token=')) {
            // 空串归一为 null(未配置放行)：要求 Bearer 空串的"鉴权"无意义
            const v = a.slice(8)
            token = v === '' ? null : v
        }
    }
    return { gui, token }
}

const cfg = parseArgs()

// ── GUI 日志状态 ──

const log = new RequestLog(100)
let activeWorkers = 0
let boundPort = 0

type GuiUpdater = (lines: string[], info: string) => void
let guiUpdater: GuiUpdater | null = null
let guiTimer: ReturnType<typeof os.setTimeout> | null = null

function two(n: number): string { return n < 10 ? '0' + String(n) : String(n) }

function fmtTime(ts: number): string {
    const d = new Date(ts * 1000)
    return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds())
}

function formatLine(e: LogEntry): string {
    let res: string
    if (e.status === 200) {
        res = e.exit === null ? 'ok' : (e.exit === 0 ? 'exit 0' : 'exit ' + e.exit)
    } else if (e.status === 401) {
        res = 'unauthorized'
    } else if (e.status === 404) {
        res = '404'
    } else if (e.status === 504) {
        res = 'timeout'
    } else {
        res = e.note ?? 'http ' + e.status
    }
    return fmtTime(e.ts) + ' · ' + e.cmd + ' · ' + res + ' (' + e.durMs + 'ms)'
}

function formatInfo(): string {
    return 'token: ' + (cfg.token !== null ? 'on' : 'off') + ' · port: ' + (boundPort || 8080) + ' · workers: ' + activeWorkers
}

// GUI 重渲必须离开 HTTP / worker 回调栈：react-qw 的 reconciler 是同步 flush，
// 在请求处理中直接 setState 会与 http-server 状态机重入把事件循环锁死。
// 统一丢到 timer 0 异步执行，并合并同一 tick 内的多次更新。
function refreshGui(): void {
    if (!guiUpdater || guiTimer !== null) return
    guiTimer = os.setTimeout(() => {
        guiTimer = null
        const u = guiUpdater
        if (u) u(log.list().map(formatLine), formatInfo())
    }, 0)
}

function appendLog(e: LogEntry): void {
    log.push(e)
    refreshGui()
}

function bumpWorkers(d: number): void {
    activeWorkers += d
    refreshGui()
}

function initGui(): void {
    if (!cfg.gui) return
    try {
        const root = createRoot({
            text: 'exec_server · :' + (boundPort || 8080),
            x: 200, y: 200, width: 560, height: 420,
        })
        root.render(<LogPanel />)
        // run.bat 用 `start /min` 启动，这里显式还原，避免窗口只留一条标题栏
        gui.ShowWindow(root.hwnd, gui.ShowWindowCmd.RESTORE)
    } catch (ex) {
        // 无桌面/建窗失败时回退 headless，绝不影响服务
        console.error('[exec_server] gui init failed (fallback headless):', ex)
    }
}

function LogPanel() {
    const [lines, setLines] = useState<string[]>([])
    const [info, setInfo] = useState<string>(formatInfo())

    useEffect(() => {
        guiUpdater = (l, i) => { setLines(l); setInfo(i) }
        setLines(log.list().map(formatLine))
        setInfo(formatInfo())
    }, [])

    return (
        <w type="STATIC" ws={gui.WindowStyle.VISIBLE} style={{ flexDirection: 'column', gap: 4, flexGrow: 1 }}>
            <w type="STATIC" ws={gui.WindowStyle.VISIBLE} text={info} style={{ height: 24 }} />
            <ListBox items={lines} scrollToBottom style={{ flexGrow: 1 }} />
        </w>
    )
}

// token 鉴权：未配置 token 时放行（兼容现状）；配置后 /exec、/screenshot、/window_list 需 Bearer。
function authCheck(req: Request): Response | null {
    if (cfg.token === null) return null
    const h = req.headers.get('authorization')
    if (h !== null && h === 'Bearer ' + cfg.token) return null
    return jsonError(401, 'unauthorized')
}

// timeoutMs <= 0 / null/NaN → 无上限：连接活着命令就一直跑，断连才 kill。
function runInWorker(cmd: string, signal: AbortSignal | null, timeoutMs: number | null): ExecHandle {
    // worker 内以 "system32\cmd.exe /c <cmd>" 启动，保留 cmd shell 语义（内部命令/管道/for），
    // cmd.exe 路径由 worker 用 GetSystemDirectoryW 拼（CreateProcess 直接 PATH 解析在本环境失败）。
    // 子进程树由 CreateProcessW 返回的 pid 定位，超时/断开时 taskkill /T 递归杀掉。
    const spawnCmd = cmd
    const worker = new os.Worker(WORKER_DATA_URL)
    bumpWorkers(1)
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
        bumpWorkers(-1)
        fn()
    }

    // kill 整棵树：CreateProcessW 返回的 pid 即 cmd.exe 根，taskkill /T 递归。
    // 杀掉后 worker 侧 ReadFile 断管道自动收尾。
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

// /screenshot 与 /window_list 复用同一个 worker（同一份 WORKER_DATA_URL），但消息类型不是 'run'：
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
        bumpWorkers(1)
        const id = 1
        let settled = false
        let timer: ReturnType<typeof os.setTimeout> | null = null

        const settle = (r: R): void => {
            if (settled) return
            settled = true
            if (timer !== null) os.clearTimeout(timer)
            worker.onmessage = null
            bumpWorkers(-1)
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
    const t0 = Date.now()
    const path = new URL(req.url).pathname
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
        return new Response('ok', { headers: { 'Content-Type': 'text/plain' } })
    }
    const denied = authCheck(req)
    if (denied !== null) {
        appendLog({ ts: Date.now() / 1000, cmd: req.method + ' ' + path, status: 401, exit: null, durMs: Date.now() - t0, note: 'missing/invalid token' })
        return denied
    }
    if (req.method === 'GET' && path === '/window_list') {
        const resp = await windowsResponse()
        appendLog({ ts: Date.now() / 1000, cmd: 'GET /window_list', status: resp.status, exit: null, durMs: Date.now() - t0 })
        return resp
    }
    if (req.method === 'GET' && path === '/screenshot') {
        let opts: ShotOpts
        try {
            opts = parseShotOpts(new URL(req.url).searchParams)
        } catch (ex) {
            appendLog({ ts: Date.now() / 1000, cmd: 'GET /screenshot', status: 400, exit: null, durMs: Date.now() - t0, note: String(ex) })
            return jsonError(400, String(ex))
        }
        const resp = await screenshotResponse(opts)
        const target = opts.hwnd !== null ? ' hwnd=' + opts.hwnd + ' ' + opts.area + '/' + opts.mode : ' screen'
        appendLog({ ts: Date.now() / 1000, cmd: 'GET /screenshot' + target, status: resp.status, exit: null, durMs: Date.now() - t0 })
        return resp
    }
    if (req.method === 'POST' && path === '/exec') {
        let out: ExecHandle
        let cmd: string
        try {
            const body = await req.json() as { cmd: string; timeout?: unknown }
            const t = body.timeout
            const timeoutMs: number | null = typeof t === 'number' && Number.isFinite(t) && t > 0
                ? t
                : null
            cmd = body.cmd
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
                appendLog({ ts: Date.now() / 1000, cmd, status: 500, exit: null, durMs: Date.now() - t0, note: rd.error })
                return new Response(JSON.stringify({ error: rd.error }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                })
            }
            out.trailers.then((h) => {
                const code = (h as Record<string, string>)['X-Exit-Code']
                appendLog({
                    ts: Date.now() / 1000,
                    cmd,
                    status: 200,
                    exit: code === undefined ? null : Number(code),
                    durMs: Date.now() - t0,
                })
            }).catch(() => { })
            return new Response(out.stream, {
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Trailer': 'X-Exit-Code',
                },
                trailers: out.trailers
            })
        } catch (ex) {
            appendLog({ ts: Date.now() / 1000, cmd, status: 504, exit: null, durMs: Date.now() - t0, note: 'exec timeout' })
            return new Response(JSON.stringify({ error: String(ex) }), {
                status: 504,
                headers: { 'Content-Type': 'application/json' }
            })
        }
    }
    appendLog({ ts: Date.now() / 1000, cmd: req.method + ' ' + path, status: 404, exit: null, durMs: Date.now() - t0 })
    return new Response('Not Found', { status: 404 })
})

const rc = server.listen(8080, '0.0.0.0')
console.log('listen rc=' + rc + ' addr=' + JSON.stringify(server.address()))
const addr = server.address()
if (addr) boundPort = addr.port
initGui()