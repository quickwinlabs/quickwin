import { createServer } from '../../lib/http-server.js'
import * as os from 'os'
import * as std from 'std'
import { RequestLog, type LogEntry } from '../../lib/exec-log.js'
import { Button, createRoot, ListBox, Tab } from '../../lib/react-qw/index.js'
import { useEffect, useState } from 'react'
import { closure, WCHAR } from '../../lib/ffi/bind.js'
import { NULL, type Ptr, PtrArrayBuffer } from '../../lib/ffi/ctype.js'
import {
    ChangeDisplaySettings, ClientToScreen, EnumDisplaySettings, EnumWindows, GetClassName,
    GetClientRect, GetDC, GetSystemMetrics, GetWindowRect, GetWindowText, IsIconic,
    IsWindowVisible, PrintWindow, ReleaseDC, SendInput, ShowWindow,
} from '../../lib/windows/user32.js'
import {
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, SelectObject,
} from '../../lib/windows/gdi32.js'
import { BITMAPFILEHEADER, BITMAPINFOHEADER, DEVMODEW, INPUT, POINT, RECT } from '../../lib/windows/structs.js'
import { GetLastError, MoveFileEx } from '../../lib/windows/kernel32.js'
import { listTrayIcons, probeTrayIcon } from './tray.js'
import { ChangeDisplayFlag, ColorUse, DisplayModeField, DisplayChangeResult, EnumDisplaySetting, MoveFileFlag, ShowWindowCmd, SysMetrics, WindowStyle } from '../../constants'

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

// 参数经 scriptArgs 透传：C 层只消费 -e/-o/-d，遇到未知选项即停止
// 解析并把剩余全部交给脚本（见 src/main.c 参数解析段）。因此空格分隔
// ("--gui 0") 与等号 ("--gui=0") 两种形式都由本函数自行解析。
function parseArgs(): Cfg {
    let gui = true
    let token: string | null = null
    const args = typeof scriptArgs === 'undefined' ? [] : scriptArgs
    const normToken = (v: string) => (v === '' ? null : v)  // 空串=未配置(放行)
    for (let i = 0; i < args.length; i++) {
        const a = args[i] ?? ''
        if (a === '--nogui') { gui = false }
        else if (a === '--gui') { gui = (args[++i] ?? '') !== '0' }
        else if (a.startsWith('--gui=')) { gui = a.slice(6) !== '0' }
        else if (a === '--token') { token = normToken(args[++i] ?? '') }
        else if (a.startsWith('--token=')) { token = normToken(a.slice(8)) }
    }
    return { gui, token }
}

const cfg = parseArgs()

// ── GUI 日志状态 ──

const log = new RequestLog(100)
let boundPort = 0

// 运行中的 worker 登记表（GUI「Worker(n)」页的数据源）：/exec 每请求一条。
// 登记对象就地更新 pid；投给 GUI 前的快照再浅拷贝一次，React 才看得到新数组。
interface WorkerRow {
    id: number
    cmd: string
    pid: number | null
    startedAt: number
    kill: () => void
}
const workers = new Map<number, WorkerRow>()
let nextWorkerId = 1

type GuiUpdater = (lines: string[], info: string, rows: WorkerRow[]) => void
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
    } else if (e.status === 504) {
        res = 'timeout'
    } else {
        res = e.note ?? 'http ' + e.status
    }
    return fmtTime(e.ts) + ' · ' + e.cmd + ' · ' + res + ' (' + e.durMs + 'ms)'
}

function formatInfo(): string {
    return 'token: ' + (cfg.token !== null ? 'on' : 'off') + ' · port: ' + (boundPort || 8080) + ' · workers: ' + workers.size
}

// GUI 重渲必须离开 HTTP / worker 回调栈：react-qw 的 reconciler 是同步 flush，
// 在请求处理中直接 setState 会与 http-server 状态机重入把事件循环锁死。
// 统一丢到 timer 0 异步执行，并合并同一 tick 内的多次更新。
function refreshGui(): void {
    if (!guiUpdater || guiTimer !== null) return
    guiTimer = os.setTimeout(() => {
        guiTimer = null
        const u = guiUpdater
        if (u) u(log.list().map(formatLine), formatInfo(), [...workers.values()].map((w) => ({ ...w })))
    }, 0)
}

function appendLog(e: LogEntry): void {
    log.push(e)
    refreshGui()
}

// 路由统一记日志（收敛各路由手写的 ts/durMs 样板）；exit 只在 /exec 完成时非 null
function logReq(t0: number, cmd: string, status: number, note?: string, exit: number | null = null): void {
    appendLog({ ts: Date.now() / 1000, cmd, status, exit, durMs: Date.now() - t0, note })
}

function initGui(): void {
    if (!cfg.gui) return
    try {
        const root = createRoot({
            text: 'execd · :' + (boundPort || 8080),
            x: 200, y: 200, width: 560, height: 420,
        })
        root.render(<LogPanel />)
        ShowWindow(root.hwnd, ShowWindowCmd.SHOWMINNOACTIVE)
    } catch (ex) {
        // 无桌面/建窗失败时回退 headless，绝不影响服务
        console.error('[execd] gui init failed (fallback headless):', ex)
    }
}

function LogPanel() {
    const [lines, setLines] = useState<string[]>([])
    const [info, setInfo] = useState<string>(formatInfo())
    const [rows, setRows] = useState<WorkerRow[]>([])

    useEffect(() => {
        guiUpdater = (l, i, w) => { setLines(l); setInfo(i); setRows(w) }
        setLines(log.list().map(formatLine))
        setInfo(formatInfo())
        setRows([...workers.values()])
    }, [])

    return (
        <w type="STATIC" ws={WindowStyle.VISIBLE} style={{ flexDirection: 'column', gap: 4, flexGrow: 1 }}>
            <w type="STATIC" ws={WindowStyle.VISIBLE} text={info} style={{ height: 24 }} />
            <Tab
                defaultSelectedIndex={0}
                style={{ flexGrow: 1 }}
                tabs={[
                    {
                        title: '日志',
                        content: (
                            <w type="STATIC" ws={WindowStyle.VISIBLE | WindowStyle.CLIPCHILDREN}
                                style={{ flexDirection: 'column', flexGrow: 1 }}>
                                <ListBox items={lines} scrollToBottom style={{ flexGrow: 1 }} />
                            </w>
                        ),
                    },
                    {
                        title: 'Worker(' + rows.length + ')',
                        content: (
                            <w type="STATIC" ws={WindowStyle.VISIBLE | WindowStyle.CLIPCHILDREN}
                                style={{ flexDirection: 'column', gap: 4, flexGrow: 1 }}>
                                {rows.length === 0
                                    ? <w type="STATIC" ws={WindowStyle.VISIBLE}
                                        text="没有正在运行的 Worker" style={{ height: 24 }} />
                                    : rows.map((r) => (
                                        <w key={r.id} type="STATIC" ws={WindowStyle.VISIBLE}
                                            style={{ flexDirection: 'row', gap: 6, height: 28 }}>
                                            <w type="STATIC" ws={WindowStyle.VISIBLE}
                                                text={fmtTime(r.startedAt / 1000) + ' · ' +
                                                    (r.pid === null ? 'pid …' : 'pid ' + r.pid) + ' · ' + r.cmd}
                                                style={{ flexGrow: 1, height: 28 }} />
                                            <Button onClick={r.kill} style={{ width: 64, height: 28 }}>停止</Button>
                                        </w>
                                    ))}
                            </w>
                        ),
                    },
                ]}
            />
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
    // id 兼作 worker 消息 id 与 GUI 行 id（原先是恒为 1 的常量，单请求内自洽）
    const id = nextWorkerId++
    let innerPid: number | null = null
    let settled = false
    let readySettled = false
    let stopRequested = false
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
        workers.delete(id)
        refreshGui()
        fn()
    }

    // kill 整棵树：CreateProcessW 返回的 pid 即 cmd.exe 根，taskkill /T 递归。
    // 杀掉后 worker 侧 ReadFile 断管道自动收尾。
    // 注意 taskkill 收不干净"父进程先退出"的情形（如 `cmd /c start /b ...`：pid 早已消失、
    // 后代逃逸，停止后进程还活着、/exec 响应也一直挂着）；要彻底收树得用 Job Object，见 .agents/TODO.md。
    const kill = (): void => {
        if (innerPid === null) return
        try {
            const p = std.popen('taskkill /F /T /PID ' + innerPid, 'r')
            if (p) p.close()
            else console.error('[execd] taskkill spawn failed')
        } catch (ex) {
            console.error('[execd] kill error:', ex)
        }
    }

    // 客户端断连 → 立即 kill（不等 60s 超时）。abort 事件同步触发；
    // 若断连发生在 worker 尚未回报 innerPid 时无法 kill，则在 'info' 到达后补刀。
    const killOnAbort = (): void => { kill() }
    if (signal) {
        signal.addEventListener('abort', killOnAbort)
        if (signal.aborted) killOnAbort()
    }

    // 登记 GUI「Worker(n)」页的一行；pid 尚未回报时点停止只置标记，等 'info' 到了补杀。
    workers.set(id, {
        id, cmd: spawnCmd, pid: null, startedAt: Date.now(),
        kill: (): void => { stopRequested = true; kill() },
    })
    refreshGui()

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
            case 'info': {
                innerPid = msg.pid ?? null
                const row = workers.get(id)
                if (row) row.pid = innerPid
                if (innerPid !== null && (signal?.aborted || stopRequested)) kill()
                refreshGui()
                break
            }
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

interface WindowEntry {
    hwnd: number
    title: string
    className: string
    rect: { left: number; top: number; right: number; bottom: number }
    visible: boolean
    minimized: boolean
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
    if (area !== 'window' && area !== 'client') throw new Error('area must be "window" or "client"')
    const rawMode = params.get('mode')
    if (rawMode !== null && rawMode !== 'screen' && rawMode !== 'print') {
        throw new Error('mode must be "screen" or "print"')
    }

    const raw = params.get('hwnd')
    const hwnd = raw === null || raw === '' ? null : Number(raw)
    if (hwnd !== null && (!Number.isInteger(hwnd) || hwnd <= 0)) {
        throw new Error('hwnd must be a positive integer')
    }
    // 缺省 mode 随 hwnd 变：带 hwnd 默认 print——PrintWindow 让窗口自绘到内存 DC，
    // 遮挡 / 最小化 / 超出屏幕都拿完整像素；screen 只会截可见部分并静默裁剪。
    // 代价：print 依赖目标窗口消息循环响应（卡死窗口约挂 5s），screen 纯 BitBlt 零依赖。
    const mode = rawMode ?? (hwnd === null ? 'screen' : 'print')
    return { hwnd, area, mode }
}

// ── 截屏 / 窗口列表（GET /screenshot、GET /window_list 后端，主进程同步直跑）──────
// 内置端点跑的是我们自己的代码，同步直跑让 bug 当场 throw → 500（有栈有原因），
// 而不是在 worker 里静默挂掉、等 timer 兜底成 504（30s 后才暴露且原因被吞）。
// 耗时实测端到端 win7 ~70ms / XP ~300ms（BitBlt + BMP 编码，有界），低频人用，
// 主循环阻塞可接受。/exec 才进 worker——外部命令不可控，popen 读循环阻塞无上界。
// 像素不走分块消息（原 SCREENSHOT_CHUNK 已删）：整块 BMP 在手直接当 Response body。

// —— 截屏：BitBlt → 24bpp 顶向下 → BMP 包装（无压缩）——
// 为什么 24 而不是 32：截图是不透明内容，但 CreateCompatibleBitmap(hdcScreen) 建出的
// 位图与桌面同宽（常见 32bpp），而 BitBlt/SRCCOPY 对 alpha 通道是未定义行为——实践中
// 不动它，GetDIBits 就把一段恒 0 的垃圾 alpha 原样带出来。文件里多一个无语义通道，
// 任何尊重 alpha 的消费方（ImageMagick、PIL、浏览器）都会把它渲成整幅透明（看起来像黑屏；
// 更坑的是 ImageMagick 的 -alpha remove 把它当预乘处理、除 alpha 除出白噪声）。
// 改向 GetDIBits 要 24bpp：GDI 自己做 32→24 的剥离（原生，JS 端零开销），文件里根本不存在
// alpha。代价是要补 24bpp 的行填充计算——32bpp 的 w*4 天然 4 字节对齐，24bpp 的 w*3 不是
// （如 w=100 → 304），padding 字节由 GDI 一并写进缓冲区，原样落盘正好符合 BMP 规格。
// 注意：截图是 24bpp，而 lib/bitmap.ts 的 createBitmapFromPixels 是 32bpp（喂 ImageList 的
// 图标真需要 alpha），两条路径位深不同是有意的。
const SRCCOPY = 0x00cc0020
// 单次捕获像素上限（≈160MB 像素缓冲），挡住畸形 rect 造成的巨量分配
const MAX_CAPTURE_PX = 40000000
const WIDE_BUF_CHARS = 512
const MAX_WINDOWS = 20000

// BMP 文件 = 文件头(14B, pack 2) + 信息头(40B) + 像素
const BMP_HEADERS_SIZE = BITMAPFILEHEADER.size + BITMAPINFOHEADER.size

// BMP 行填充：每行 (w*3+3) 取整到 4 的倍数。MSDN 的公式即为此式。
function biStride(w: number): number {
    return (w * 3 + 3) & ~3
}

function bmpHeader(pxBytes: number, w: number, h: number): Uint8Array {
    const fileHdr = BITMAPFILEHEADER.encode({
        bfType: 0x4d42,                              // 'BM'
        bfSize: BMP_HEADERS_SIZE + pxBytes,           // 文件总长 = 头 + 像素（含行填充）
        bfOffBits: BMP_HEADERS_SIZE,                  // 像素数据偏移
    })
    const infoHdr = BITMAPINFOHEADER.encode({
        biSize: BITMAPINFOHEADER.size,
        biWidth: w,
        biHeight: -h,                                // 负 = 顶向下
        biPlanes: 1,
        biBitCount: 24,                              // 无 alpha，见上方注释
        biCompression: 0,                            // BI_RGB
        biSizeImage: biStride(w) * h,
        biXPelsPerMeter: 2835,                       // 72dpi
        biYPelsPerMeter: 2835,
    })
    const out = new Uint8Array(BMP_HEADERS_SIZE)
    out.set(new Uint8Array(fileHdr), 0)
    out.set(new Uint8Array(infoHdr), BITMAPFILEHEADER.size)
    return out
}

/** 取 hdc 当前选中位图的全部像素，拼成完整 BMP。GetDIBits 短读返回 null。 */
function emitDib(hdc: Ptr<'HDC'>, hbm: Ptr<'HGDIOBJ'>, w: number, h: number): Uint8Array | null {
    const row = biStride(w)
    const pxBytes = row * h
    const pxB = new PtrArrayBuffer(pxBytes)
    const px = new Uint8Array(pxB)
    const bmi = BITMAPINFOHEADER.encode({
        biSize: BITMAPINFOHEADER.size,
        biWidth: w,
        biHeight: -h,           // 负 = 顶向下
        biPlanes: 1,
        biBitCount: 24,         // GDI 把桌面 32bpp 位图转成 24bpp（剥 alpha）；biCompression 缺省 0 = BI_RGB
        biSizeImage: pxBytes,
    })

    const got = GetDIBits(hdc, hbm, 0, h, pxB, bmi.ptr, ColorUse.RGB_COLORS)
    if (got !== h) return null

    const out = new Uint8Array(BMP_HEADERS_SIZE + pxBytes)
    out.set(bmpHeader(pxBytes, w, h), 0)
    out.set(px, BMP_HEADERS_SIZE)
    return out
}

// PrintWindow 到整窗临时 DC，再用 BitBlt 裁出子矩形到 hdcOut。临时 DC 用完立即归还。
// 裁切在 GDI 里做（第二块 DC + BitBlt），不在 JS 里逐像素拷：既省一份整帧缓冲，
// 也不会把客户区偏移和 BitBlt 的源坐标重复应用。
function printAndCrop(hdcScreen: Ptr<'HDC'>, hwnd: Ptr<'HWND'>, frameW: number, frameH: number,
    hdcOut: Ptr<'HDC'>, cropX: number, cropY: number, outW: number, outH: number): boolean {
    const hdcTmp = CreateCompatibleDC(hdcScreen)
    const hbmTmp = hdcTmp ? CreateCompatibleBitmap(hdcScreen, frameW, frameH) : 0
    if (!hdcTmp || !hbmTmp) {
        if (hdcTmp) DeleteDC(hdcTmp)
        return false
    }
    const oldTmp = SelectObject(hdcTmp, hbmTmp)
    // PrintWindow 从 (0,0) 填整张位图，所以必须给整窗尺寸；nFlags 传 0（XP/Win7 无 PW_* 语义）
    const printed = PrintWindow(hwnd, hdcTmp, 0) !== 0
    const cropped = printed && BitBlt(hdcOut, 0, 0, outW, outH, hdcTmp, cropX, cropY, SRCCOPY) !== 0
    SelectObject(hdcTmp, oldTmp)
    DeleteObject(hbmTmp)
    DeleteDC(hdcTmp)
    return cropped
}

/** 抓一张 [outW x outH] 的 BMP。hwnd 为 null：srcX/srcY 是屏幕坐标，BitBlt 直接截出；
 *  非 null：PrintWindow 让窗口自行重绘（可截被遮挡、最小化的窗口），再裁出相对偏移子矩形。
 *  注意：BitBlt 自 GetDC(NULL) 截的是「调用线程所在 session 的输入桌面」，
 *  在 sshd / service（session 0）里跑会得到全黑图且**不报错**——调用方要校验像素内容。 */
function captureRect(frameW: number, frameH: number, srcX: number, srcY: number,
    cropX: number, cropY: number, outW: number, outH: number, hwnd: Ptr<'HWND'> | null):
    { bmp: Uint8Array; width: number; height: number } {
    // 用否定式判断：NaN 会让 `> 0` 与 `> 上限` 同时为假，正写会漏过
    if (!(outW > 0 && outH > 0 && outW * outH <= MAX_CAPTURE_PX)) {
        throw new Error('capture size invalid w=' + outW + ' h=' + outH)
    }
    if (hwnd !== null
        && !(cropX >= 0 && cropY >= 0 && cropX + outW <= frameW && cropY + outH <= frameH)) {
        throw new Error('capture crop out of range crop=(' + cropX + ',' + cropY + ',' + outW + 'x' + outH
            + ') frame=' + frameW + 'x' + frameH)
    }

    const hdcScreen = GetDC(NULL)
    if (!hdcScreen) {
        throw new Error('GetDC(NULL)=0：无输入桌面（确认在交互 session 启动，而非 sshd/service）')
    }
    // 必须传屏幕 DC 建位图：CreateCompatibleBitmap 按「当前选中对象」决定位图格式，
    // 传 hdcOut 时它选中的是 1×1 单色图 → 建出 1×1 位图，BitBlt 被裁剪到 1 像素
    // （症状：blit=1、getdibits=h 都成功，但缓冲区几乎全 0）。
    const hdcOut = CreateCompatibleDC(hdcScreen)
    const hbmOut = hdcOut ? CreateCompatibleBitmap(hdcScreen, outW, outH) : 0
    if (!hdcOut || !hbmOut) {
        if (hdcOut) DeleteDC(hdcOut)
        ReleaseDC(NULL, hdcScreen)
        throw new Error('CreateCompatibleDC/Bitmap failed')
    }
    const oldOut = SelectObject(hdcOut, hbmOut)
    const ok = hwnd === null
        ? BitBlt(hdcOut, 0, 0, outW, outH, hdcScreen, srcX, srcY, SRCCOPY) !== 0
        : printAndCrop(hdcScreen, hwnd, frameW, frameH, hdcOut, cropX, cropY, outW, outH)
    SelectObject(hdcOut, oldOut)
    const bmp = ok ? emitDib(hdcOut, hbmOut, outW, outH) : null
    DeleteObject(hbmOut)
    DeleteDC(hdcOut)
    ReleaseDC(NULL, hdcScreen)

    if (!ok) {
        throw new Error('capture failed out=' + outW + 'x' + outH
            + (hwnd === null ? ' at=(' + srcX + ',' + srcY + ')'
                : ' hwnd=' + hwnd + ' crop=(' + cropX + ',' + cropY + ') frame=' + frameW + 'x' + frameH))
    }
    if (!bmp) throw new Error('GetDIBits short read out=' + outW + 'x' + outH)
    return { bmp, width: outW, height: outH }
}

/** 抓主屏全屏 */
function captureScreen(): { bmp: Uint8Array; width: number; height: number } {
    const w = GetSystemMetrics(0)
    const h = GetSystemMetrics(1)
    if (w <= 0 || h <= 0) throw new Error('GetSystemMetrics w=' + w + ' h=' + h)
    return captureRect(w, h, 0, 0, 0, 0, w, h, null)
}

/** 抓单个窗口。area=client 只抓客户区；mode=print 让窗口自行重绘（可被遮挡、可最小化）。 */
function captureWindow(hwnd: Ptr<'HWND'>, area: 'window' | 'client', mode: 'screen' | 'print'):
    { bmp: Uint8Array; width: number; height: number } {
    if (mode === 'screen' && IsIconic(hwnd) !== 0) {
        throw new Error('window minimized：mode=screen 只会截到它下方的桌面，去掉 mode=screen 让默认 print 生效')
    }

    const wRect = RECT.alloc()
    if (!GetWindowRect(hwnd, wRect.ptr)) {
        throw new Error('GetWindowRect(hwnd=' + hwnd + ')=0：窗口不存在或已销毁')
    }
    const { left: wl, top: wt, right: wr, bottom: wbot } = RECT.decode(wRect)
    const ww = wr - wl
    const wh = wbot - wt

    let cropX = 0
    let cropY = 0
    let cw = ww
    let ch = wh
    if (area === 'client') {
        const cRect = RECT.alloc()
        if (!GetClientRect(hwnd, cRect.ptr)) throw new Error('GetClientRect(hwnd=' + hwnd + ')=0')
        // 客户区坐标以客户区左上角为原点，left/top 恒为 0，不是窗口→客户的偏移；
        // 边框和标题栏的位移必须用 ClientToScreen(0,0) 单独查。尺寸取差值（同理不假设 left/top）。
        const { left: cl, top: ct, right: cr, bottom: cbot } = RECT.decode(cRect)
        cw = cr - cl
        ch = cbot - ct
        const origin = POINT.encode({ x: 0, y: 0 })
        if (!ClientToScreen(hwnd, origin.ptr)) throw new Error('ClientToScreen(hwnd=' + hwnd + ')=0')
        const org = POINT.decode(origin)
        cropX = org.x - wl
        cropY = org.y - wt
    }
    // screen：srcX/srcY 给绝对屏幕坐标，截出的就是输出本身，crop 无意义（传 0 即可，反正被忽略）；
    // print：PrintWindow 只能从 (0,0) 画整窗，客户区靠 crop 从整窗位图里裁出来。
    // 两条路径只走一种坐标，所以客户区偏移不会被应用两次。
    let sx = mode === 'print' ? 0 : wl + cropX
    let sy = mode === 'print' ? 0 : wt + cropY
    if (mode === 'screen') {
        // clamp 捕获区域到虚拟屏幕内：窗口超出屏幕时 BitBlt 从屏幕外只能截到黑区，
        // 直接把发出的 BMP 裁到窗口在屏幕内的可见部分（dims 也随之收缩）。
        const vsX = GetSystemMetrics(76) // SM_XVIRTUALSCREEN
        const vsY = GetSystemMetrics(77) // SM_YVIRTUALSCREEN
        const vsW = GetSystemMetrics(78) // SM_CXVIRTUALSCREEN
        const vsH = GetSystemMetrics(79) // SM_CYVIRTUALSCREEN
        const ax = Math.max(sx, vsX)
        const ay = Math.max(sy, vsY)
        const ax2 = Math.min(sx + cw, vsX + vsW)
        const ay2 = Math.min(sy + ch, vsY + vsH)
        if (ax2 <= ax || ay2 <= ay) {
            throw new Error('capture area outside virtual screen at=(' + sx + ',' + sy + ',' + cw
                + 'x' + ch + ')')
        }
        sx = ax
        sy = ay
        cw = ax2 - ax
        ch = ay2 - ay
    }
    return captureRect(ww, wh, sx, sy, cropX, cropY, cw, ch, mode === 'print' ? hwnd : null)
}

/** 顶层窗口列表（不递归子控件）。EnumWindows 先拍窗口快照再回调：不像 FindWindowEx 链式遍历
 *  那样，在「下一个窗口恰好被销毁」时拿到失效句柄，下一轮返回 NULL 把列表悄悄截断。
 *  回调只收集句柄：回调内抛异常会被 closure 吞成返回 0（枚举静默提前结束），所以不在回调里查属性。
 *  快照里的窗口在逐个查询时可能已销毁，GetWindowRect 返回 0 即跳过。
 *  输出顺序是 EnumWindows 的顺序（与 FindWindowEx 链的顺序不同，集合相同；API 未承诺顺序）。 */
function listWindows(): WindowEntry[] {
    const handles: Ptr<'HWND'>[] = []
    const collect = closure('<HWND>ptr <>ptr -> i32', (h) => {
        if (h) handles.push(h)
        return handles.length < MAX_WINDOWS ? 1 : 0   // 返回 0 = 停止枚举（到上限）
    })
    try { EnumWindows(collect.ptr, NULL) } finally { collect.dispose() }

    const wRect = RECT.alloc()
    const tb = WCHAR.alloc(WIDE_BUF_CHARS)
    const cb = WCHAR.alloc(WIDE_BUF_CHARS)

    const out: WindowEntry[] = []
    for (const hwnd of handles) {
        if (GetWindowRect(hwnd, wRect.ptr)) {
            const rc = RECT.decode(wRect)
            const tl = GetWindowText(hwnd, tb, WIDE_BUF_CHARS)
            const cl = GetClassName(hwnd, cb, WIDE_BUF_CHARS)
            out.push({
                hwnd,
                // 缓冲跨窗口复用：长度 0 时 API 不保证写回终止符，不能 decode 残留内容
                title: tl > 0 ? WCHAR.decode(tb) : '',
                className: cl > 0 ? WCHAR.decode(cb) : '',
                rect: { left: rc.left, top: rc.top, right: rc.right, bottom: rc.bottom },
                visible: IsWindowVisible(hwnd) !== 0,
                minimized: IsIconic(hwnd) !== 0
            })
        }
    }
    return out
}

// ── 显示模式（POST /set_resolution 后端）────────────────────────────────────
// 流程：Enum 当前模式取基准 → dmFields 置 DM_PELSWIDTH|DM_PELSHEIGHT 原地改宽高 →
// CDS_TEST 预检（被拒不碰实际显示）→ 动态 apply 即时生效 → persist 时再 CDS_UPDATEREGISTRY
// 写注册表跨重启。宽高必须在驱动模式列表内（QEMU -vga std），无任意值仿真；尺寸经
// GetSystemMetrics 实测回读，不信传入值；modes32 恒带（成功/失败都附 32bpp 可用列表）。
// 常量全部 gui const enum（gen_const 从 SDK 头提取）：DM_PELSWIDTH=0x00080000——
// 手写易错成 DM_ICMMETHOD 的 0x00800000（旧 setres.ts 即栽在这 + scriptArgs 错位）。

interface DisplayModeChange {
    /** 变更前分辨率 'WxH'（Enum 当前模式实读） */
    before: string
    /** 变更后分辨率 'WxH'（GetSystemMetrics 实测） */
    after: string
    /** CDS_TEST 预检结果（0 = 驱动接受该模式） */
    testRet: number
    /** 实际 apply 结果；testRet !== 0 时等于 testRet（预检即拒、未 apply） */
    ret: number
    /** ret 的 DISP_CHANGE_* 名（未知值 '?'） */
    retName: string
    /** 恒带：32bpp 可用模式 'WxH@Hz'（成功/失败都给，免二次请求重挑） */
    modes32: string[]
}

const DISP_CHANGE_NAME: Record<number, string> = {
    [DisplayChangeResult.SUCCESSFUL]: 'SUCCESSFUL',
    [DisplayChangeResult.RESTART]: 'RESTART',
    [DisplayChangeResult.FAILED]: 'FAILED',
    [DisplayChangeResult.BADMODE]: 'BADMODE',
    [DisplayChangeResult.NOTUPDATED]: 'NOTUPDATED',
    [DisplayChangeResult.BADFLAGS]: 'BADFLAGS',
    [DisplayChangeResult.BADPARAM]: 'BADPARAM',
    [DisplayChangeResult.BADDUALVIEW]: 'BADDUALVIEW',
}

function dispChangeName(ret: number): string {
    return DISP_CHANGE_NAME[ret] ?? '?'
}

/** 当前屏幕实测尺寸 'WxH'（模式切换后立即反映） */
function currentScreen(): string {
    return GetSystemMetrics(SysMetrics.CXSCREEN) + 'x' + GetSystemMetrics(SysMetrics.CYSCREEN)
}

/** 枚举 32bpp 显示模式 → 'WxH@Hz' 列表（上限 200 次迭代防死循环） */
function listModes32(): string[] {
    const probe = DEVMODEW.encode({ dmSize: DEVMODEW.size })
    const out: string[] = []
    for (let i = 0; i < 200; i++) {
        if (!EnumDisplaySettings(NULL, i, probe.ptr)) break
        const dm = DEVMODEW.decode(probe)
        if (dm.dmBitsPerPel !== 32) continue
        out.push(dm.dmPelsWidth + 'x' + dm.dmPelsHeight + '@' + dm.dmDisplayFrequency)
    }
    return out
}

/** 改显示分辨率。w/h 非法直接 throw；驱动拒绝（BADMODE 等）以结果对象返回。
 *  @param persist true = 动态生效后追加写注册表（跨重启保留）；false = 只即时生效 */
function applyDisplayMode(w: number, h: number, persist: boolean): DisplayModeChange {
    if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
        throw new Error('applyDisplayMode: w/h must be positive integers, got ' + w + 'x' + h)
    }
    // dmSize 先置（Win32 硬要求，否则 API 拒绝）；Enum 就地填当前模式其余字段
    const dm = DEVMODEW.encode({ dmSize: DEVMODEW.size })
    if (!EnumDisplaySettings(NULL, EnumDisplaySetting.CURRENT_SETTINGS, dm.ptr)) {
        throw new Error('applyDisplayMode: EnumDisplaySettings CURRENT failed')
    }
    const cur = DEVMODEW.decode(dm)
    const before = cur.dmPelsWidth + 'x' + cur.dmPelsHeight

    // 同一 buffer 原地改三项（encode 缺省字段跳过 = 保留 Enum 填的其余项）
    DEVMODEW.encode({
        dmFields: cur.dmFields | DisplayModeField.PELSWIDTH | DisplayModeField.PELSHEIGHT,
        dmPelsWidth: w,
        dmPelsHeight: h,
    }, dm)

    const testRet = ChangeDisplaySettings(dm.ptr, ChangeDisplayFlag.TEST)
    if (testRet !== 0) {
        // 预检即拒：不碰实际显示，附可用列表
        return {
            before, after: currentScreen(), testRet,
            ret: testRet, retName: dispChangeName(testRet), modes32: listModes32(),
        }
    }

    // flags=0 = 动态切换即时生效；persist 再写一遍注册表（CDS_UPDATEREGISTRY 跨重启）
    let ret = ChangeDisplaySettings(dm.ptr, 0)
    if (ret === 0 && persist) {
        ret = ChangeDisplaySettings(dm.ptr, ChangeDisplayFlag.UPDATEREGISTRY)
    }
    // 成功也带可用列表：一次请求拿到结果+全量模式，失败再请求才给列表就多一个来回
    return { before, after: currentScreen(), testRet, ret, retName: dispChangeName(ret), modes32: listModes32() }
}

// 非 API 路径的统一应答（/、/health、拼错路径/方法一律 200 免 token）。run.sh/
// http_test.sh 的 curl -sf 健康探针打到的就是这（判据只看状态码不看 body）。
// 不记日志：探针 3s 一打，会刷爆 GUI 环形日志窗。
const USAGE = `quickwin execd —— 本页即用法（API 之外任意路径均返回，HTTP 200）

API（配置 token 后需 Authorization: Bearer <token>，未配置则放行）：
  POST /exec         JSON {"cmd":"命令","timeout":毫秒?} → 流式输出，Trailer X-Exit-Code
  GET  /screenshot   ?hwnd=<十进制>&area=window|client&mode=screen|print → image/bmp
                     （X-Dimensions；不带 hwnd = 整屏 BitBlt；带 hwnd 默认 mode=print
                     让窗口自绘——遮挡/最小化/超屏也拿完整像素，screen 只截可见部分）
  GET  /window_list  → JSON 窗口列表 [{hwnd,title,className,...}]
  GET  /tray_list    → JSON {icons:[{area,index,hWnd,uID,tooltip,rect}]}（跨进程枚举
                      explorer toolbar：可见区 Shell_TrayWnd + 折叠区 NotifyIconOverflowWindow；
                      rect 屏幕物理像素，全 0 → null；折叠面板未展开时 overflow 区 rect
                      仅当展开后可靠）；?probe=<hwnd>&uid=<n> → 附 probe {hr,hrName,rect}
                      （单图标 Shell_NotifyIconGetRect，Win7+：0=found 附容器 rect / 1=hidden
                      / E_FAIL=不存在或 GUID 图标；XP 无此 API → unsupported）
  POST /set_resolution       ?w=<px>&h=<px>&persist=0|1（默认 1 = 写注册表跨重启）→ JSON
                     {before,after,testRet,ret,retName,modes32}；modes32 恒带 32bpp
                     可用模式（非法宽高会以 BADMODE 拒绝并给本列表）
  POST /input        body = JSON 数组（批量注入；x/y 物理像素）：
                     {"t":"move","x":,"y":} | {"t":"down|up","btn":"left|right|middle|x1|x2","x":,"y":?} |
                     {"t":"key","key":"a|enter|0x41","up":true?} | {"t":"sleep","ms":0..5000}
                     → JSON {sent,expected}；按 sleep 切段，段内一次 SendInput 原子注入
  POST /upload       ?path=<目标路径>&mkdir=0 body=原始字节（非空）→ JSON {bytes,path}
                     默认逐层建父目录（mkdir=0 严格要求父目录已存在，防路径 typo）；
                     原子写：先写 <path>.uploading 再 MoveFileEx 覆盖，看不到半截文件。
                     无 SMB 环境的传文件通道，路径全放开。8MB 分块写盘（CRT 单块大写
                     在 XP 网络盘 ~64MiB 边界会被整块拒绝），XP/win7 实测 100MB+ OK
  GET  /download     ?path=<文件路径> → 原始字节流（application/octet-stream，X-Bytes 头；
                     分块读到 EOF 无大小上限）——type 命令的二进制安全版`

function usageResponse(): Response {
    return new Response(USAGE, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

// ── /input 事件词汇（lib/windows/structs.ts 的 INPUT 布局；坐标物理像素，进程
//    DPI-aware 见 src/main.c SetProcessDPIAware——GetSystemMetrics 归一化与 SendInput
//    解释同空间）──
const INPUT_MOUSE = 0, INPUT_KEYBOARD = 1
const MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000, KEYEVENTF_KEYUP = 0x0002
// btn → [down flag, up flag, mouseData]；X 系两键共用 XDOWN/XUP 标志，靠 mouseData
// （XBUTTON1=1 / XBUTTON2=2）区分
const MOUSE_BTNS: Record<string, [number, number, number]> = {
    left: [0x0002, 0x0004, 0], right: [0x0008, 0x0010, 0], middle: [0x0020, 0x0040, 0],
    x1: [0x0080, 0x0100, 1], x2: [0x0080, 0x0100, 2],
}
// 命名键 → VK；单字符 a-z/0-9 由 vkOf 直通（VK 同码），数字整数 0..0xFFFF 直传
const VK_NAMES: Record<string, number> = {
    backspace: 0x08, tab: 0x09, enter: 0x0d, shift: 0x10, ctrl: 0x11, alt: 0x12,
    caps: 0x14, esc: 0x1b, space: 0x20, pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24,
    left: 0x25, up: 0x26, right: 0x27, down: 0x28, insert: 0x2d, delete: 0x2e,
    win: 0x5b, f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
    f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
}
function vkOf(key: unknown): number {
    if (typeof key === 'number' && Number.isInteger(key) && key >= 0 && key <= 0xffff) return key
    if (typeof key === 'string') {
        if (key.length === 1) {
            const c = key.toUpperCase().charCodeAt(0)
            if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a)) return c
        }
        const vk = VK_NAMES[key.toLowerCase()]
        if (vk !== undefined) return vk
    }
    throw new Error('bad key: ' + JSON.stringify(key) + ' (a-z/0-9|name|0..0xFFFF)')
}
// INPUT 的 encode 入参元素形（外部等价 lib 的 EncInOf：Parameters<def.encode>[0]——
// SendInput 的 <INPUT>ptr encoder 值域即本类型的普通数组，tsc 逐元素校验）
type InputEl = Parameters<typeof INPUT.encode>[0]

// /upload mkdir=1 的父目录逐层创建：引擎 os.mkdir 单层且失败即 throw（无 unlink、
// 无 errno 区分），"已存在"与"真失败"不可辨，统一吞掉——目标是让写入尝试自己说话。
// 支持盘符/相对路径；UNC（\\srv\share\...）未适配（execd 场景以本地盘与映射盘为主）。
function mkdirParents(dest: string): void {
    const segs = dest.replace(/\//g, '\\').split('\\')
    let acc = ''
    for (let i = 0; i < segs.length - 1; i++) {   // 末段是文件名，不建
        acc = acc === '' ? segs[i]! : acc + '\\' + segs[i]!
        if (acc === '' || /^[A-Za-z]:$/.test(acc)) continue   // UNC 首空段 / 盘符跳过
        try { os.mkdir(acc) } catch { /* 已存在（或真失败，由后续 open/write 报）*/ }
    }
}

const server = createServer(async (req) => {
    const t0 = Date.now()
    const path = new URL(req.url).pathname
    const isApi = (req.method === 'POST' && (path === '/exec' || path === '/set_resolution' || path === '/input' || path === '/upload')) ||
        (req.method === 'GET' && (path === '/window_list' || path === '/screenshot' || path === '/tray_list' || path === '/download'))
    if (!isApi) return usageResponse()
    const denied = authCheck(req)
    if (denied !== null) {
        logReq(t0, req.method + ' ' + path, 401, 'missing/invalid token')
        return denied
    }
    if (req.method === 'GET' && path === '/window_list') {
        try {
            const wins = listWindows()
            const resp = new Response(JSON.stringify(wins), { headers: { 'Content-Type': 'application/json' } })
            logReq(t0, 'GET /window_list', 200)
            return resp
        } catch (ex) {
            logReq(t0, 'GET /window_list', 500, String(ex))
            return jsonError(500, String(ex))
        }
    }
    // /tray_list：通知区图标枚举（跨进程远程读，主进程直做——同步 FFI 毫秒级）。
    // ?probe=<hwnd>&uid=<n> 附加单图标可见性探针（Shell_NotifyIconGetRect，Win7+）。
    if (req.method === 'GET' && path === '/tray_list') {
        const params = new URL(req.url).searchParams
        let probe: { hWnd: Ptr<'HWND'>; uID: number } | null = null
        const ph = params.get('probe')
        if (ph !== null) {
            const hh = Number(ph), uid = Number(params.get('uid') ?? '')
            if (!Number.isInteger(hh) || hh <= 0 || !Number.isInteger(uid) || uid < 0) {
                logReq(t0, 'GET /tray_list', 400, 'probe=<hwnd>&uid=<n>')
                return jsonError(400, 'probe needs integer hwnd>0 and uid>=0')
            }
            probe = { hWnd: hh as Ptr<'HWND'>, uID: uid }
        }
        try {
            // 双容器枚举 + 远程读全在 tray.ts（execd 配对模块）
            const icons = listTrayIcons()
            const body: Record<string, unknown> = { icons }
            if (probe) body.probe = probeTrayIcon(probe.hWnd, probe.uID)
            const nOv = icons.reduce((n, e) => n + (e.area === 'overflow' ? 1 : 0), 0)
            logReq(t0, 'GET /tray_list', 200, icons.length + ' icons · overflow ' + nOv)
            return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
        } catch (ex) {
            logReq(t0, 'GET /tray_list', 500, String(ex))
            return jsonError(500, String(ex))
        }
    }
    if (req.method === 'GET' && path === '/screenshot') {
        let opts: ShotOpts
        try {
            opts = parseShotOpts(new URL(req.url).searchParams)
        } catch (ex) {
            logReq(t0, 'GET /screenshot', 400, String(ex))
            return jsonError(400, String(ex))
        }
        let cap: { bmp: Uint8Array; width: number; height: number }
        try {
            cap = opts.hwnd === null
                ? captureScreen()
                // JSON 来的句柄是普通 number，标 HWND 品牌即可（有效性由 Win32 判定）
                : captureWindow(opts.hwnd as Ptr<'HWND'>, opts.area, opts.mode)
        } catch (ex) {
            logReq(t0, 'GET /screenshot', 500, String(ex))
            return jsonError(500, String(ex))
        }
        const target = opts.hwnd !== null ? ' hwnd=' + opts.hwnd + ' ' + opts.area + '/' + opts.mode : ' screen'
        logReq(t0, 'GET /screenshot' + target, 200)
        return new Response(cap.bmp, {
            headers: { 'Content-Type': 'image/bmp', 'X-Dimensions': cap.width + 'x' + cap.height }
        })
    }
    // /set_resolution 改系统状态但毫秒级返回（Enum/Test/Apply 皆同步 FFI，无子进程无阻塞），
    // 直接在主进程做（worker 只隔离 /exec 的长 popen——外部命令不可控、阻塞无上界）。
    // 预检被拒（BADMODE 等）以 200 + 结果对象返回（含 modes32 可用列表），语义在 body 不在状态码。
    if (req.method === 'POST' && path === '/set_resolution') {
        let result: DisplayModeChange
        let w = 0, h = 0, persist = true
        try {
            const params = new URL(req.url).searchParams
            w = Number(params.get('w'))
            h = Number(params.get('h'))
            if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
                throw new Error('w/h must be positive integers')
            }
            persist = params.get('persist') !== '0'   // 默认开（写注册表跨重启）；persist=0 只即时生效
            result = applyDisplayMode(w, h, persist)
        } catch (ex) {
            logReq(t0, 'POST /set_resolution', 400, String(ex))
            return jsonError(400, String(ex))
        }
        const resp = new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
        logReq(t0, 'POST /set_resolution ' + w + 'x' + h + (persist ? '' : ' persist=0'), 200,
            result.ret !== 0 ? result.retName : undefined)
        return resp
    }
    // /input：SendInput 批量注入（JSON 数组；主进程直做——同步 FFI、微秒级，与
    // /set_resolution 同列，worker 只隔离长 popen）。数组按 'sleep' 切段：段内一次
    // SendInput = 原子输入块（down/up 不会被外来输入夹入），段间 os.setTimeout 让出
    // 事件循环（菜单弹出等时序，不堵其余请求）。先全量校验后注入：任何一条非法 → 400
    // 且一条不发；注入返回数 < 预期（UIPI 拦截等）→ 200 + {sent,expected} 保真不装成功。
    if (req.method === 'POST' && path === '/input') {
        const bad = (msg: string): Response => {
            logReq(t0, 'POST /input', 400, msg)
            return jsonError(400, msg)
        }
        let raw: unknown
        try { raw = await req.json() } catch (ex) { return bad('bad json: ' + String(ex)) }
        if (!Array.isArray(raw) || raw.length === 0) return bad('body must be a non-empty JSON array')
        if (raw.length > 1000) return bad('too many events: ' + raw.length + ' (max 1000)')
        const sw = GetSystemMetrics(0), sh = GetSystemMetrics(1)   // SM_CXSCREEN/CYSCREEN 物理像素
        const segs: { els: InputEl[]; sleep: number }[] = [{ els: [], sleep: 0 }]
        const cur = () => segs[segs.length - 1]!
        try {
            for (const e of raw) {
                if (typeof e !== 'object' || e === null || Array.isArray(e))
                    throw new Error('event must be an object: ' + JSON.stringify(e))
                const ev = e as Record<string, unknown>
                // 物理像素 → 0..65535 归一化（主屏；x 缺省 = 不移动，纯按键事件）
                const abs = (required: boolean): [number, number, number] => {
                    if (ev.x === undefined && ev.y === undefined) {
                        if (required) throw new Error('x/y required for move')
                        return [0, 0, 0]
                    }
                    const x = ev.x, y = ev.y
                    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isInteger(x) || !Number.isInteger(y))
                        throw new Error('x/y must be integers (physical px)')
                    if (x < 0 || x >= sw || y < 0 || y >= sh)
                        throw new Error('x/y out of screen: 0..' + (sw - 1) + ' / 0..' + (sh - 1))
                    return [Math.round(x * 65535 / (sw - 1)), Math.round(y * 65535 / (sh - 1)),
                        MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE]
                }
                switch (ev.t) {
                    case 'move': {
                        const [dx, dy, f] = abs(true)
                        cur().els.push({ type: INPUT_MOUSE, data: { mi: { dx, dy, dwFlags: f } } })
                        break
                    }
                    case 'down': case 'up': {
                        const btn = typeof ev.btn === 'string' ? MOUSE_BTNS[ev.btn] : undefined
                        if (!btn) throw new Error('bad btn: ' + JSON.stringify(ev.btn) + ' (left|right|middle|x1|x2)')
                        const [downF, upF, mData] = btn
                        const [dx, dy, f] = abs(false)
                        const flag = ev.t === 'down' ? downF : upF
                        cur().els.push({ type: INPUT_MOUSE, data: { mi: { dx, dy, mouseData: mData, dwFlags: f | flag } } })
                        break
                    }
                    case 'key': {
                        const up = ev.up === true
                        cur().els.push({ type: INPUT_KEYBOARD, data: { ki: { wVk: vkOf(ev.key), dwFlags: up ? KEYEVENTF_KEYUP : 0 } } })
                        break
                    }
                    case 'sleep': {
                        const ms = ev.ms
                        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > 5000)
                            throw new Error('sleep ms must be a number in 0..5000')
                        segs.push({ els: [], sleep: ms })
                        break
                    }
                    default:
                        throw new Error('bad t: ' + JSON.stringify(ev.t) + ' (move|down|up|key|sleep)')
                }
            }
        } catch (ex) {
            return bad(ex instanceof Error ? ex.message : String(ex))
        }
        let expected = 0, sent = 0
        for (const s of segs) expected += s.els.length
        try {
            for (const seg of segs) {
                if (seg.sleep > 0) await new Promise<void>((r) => { os.setTimeout(r, seg.sleep) })
                if (seg.els.length === 0) continue
                const n = SendInput(seg.els.length, seg.els, INPUT.size)
                sent += n
                if (n < seg.els.length) break   // 全败/半败（UIPI 等）后续同因，止损停发
            }
        } catch (ex) {
            logReq(t0, 'POST /input', 500, String(ex))
            return jsonError(500, String(ex))
        }
        logReq(t0, 'POST /input ' + raw.length + 'ev', 200,
            sent < expected ? 'sent ' + sent + '/' + expected : undefined)
        return new Response(JSON.stringify({ sent, expected }), { headers: { 'Content-Type': 'application/json' } })
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
            return jsonError(500, 'setup: ' + String(ex))
        }
        try {
            const rd = await out.ready
            if (!rd.ok) {
                logReq(t0, cmd, 500, rd.error)
                return jsonError(500, rd.error ?? 'exec failed')
            }
            out.trailers.then((h) => {
                const code = (h as Record<string, string>)['X-Exit-Code']
                logReq(t0, cmd, 200, undefined, code === undefined ? null : Number(code))
            }).catch(() => { })
            return new Response(out.stream, {
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Trailer': 'X-Exit-Code',
                },
                trailers: out.trailers
            })
        } catch (ex) {
            logReq(t0, cmd, 504, 'exec timeout')
            return jsonError(504, String(ex))
        }
    }
    // /upload、/download：HTTP 直传文件（无 SMB 环境的通道；信任模型与 /exec 同级——
    // 已有任意命令执行权，路径全放开，token 鉴权同其余 API）。body 在 http-server 层
    // 已全量缓冲，此处流式写盘 / 分块读出，内存占用与文件大小同阶。
    if (req.method === 'POST' && path === '/upload') {
        const bad = (msg: string): Response => {
            logReq(t0, 'POST /upload', 400, msg)
            return jsonError(400, msg)
        }
        const params = new URL(req.url).searchParams
        const dest = params.get('path')
        if (!dest) return bad('path=<目标路径>')
        let bytes: Uint8Array
        try {
            bytes = new Uint8Array(await req.arrayBuffer())
        } catch (ex) {
            return bad('bad body: ' + String(ex))
        }
        if (bytes.length === 0) return bad('empty body')
        try {
            if (params.get('mkdir') !== '0') mkdirParents(dest)   // 默认建父目录；mkdir=0 严格模式
            // 原子写：<path>.uploading 落全量再 rename（同卷原子替换）。引擎无 std.unlink，
            // rename 之前失败会残留 .uploading（无害，下次上传覆盖）。
            const tmp = dest + '.uploading'
            const f = std.open(tmp, 'wb')
            if (!f) throw new Error('open for write failed: ' + tmp)
            let w = 0
            try {
                // CRT 单次大块 fwrite 到 XP 网络重定向器在 ~64MiB 边界整块拒绝（0 字节，
                // cmd copy 同路径正常 → 重定向器无罪，是 1GB XP 上大块锁页预算效应）；
                // 8MB 分块写绕开，本地盘/win7 无感
                const CHUNK = 8 * 1024 * 1024
                for (let off = 0; off < bytes.length; off += CHUNK) {
                    const n = f.write(bytes.buffer as ArrayBuffer, off, Math.min(CHUNK, bytes.length - off))
                    if (n <= 0) break
                    w += n
                }
            } finally { f.close() }
            if (w !== bytes.length) throw new Error('short write: ' + w + '/' + bytes.length)
            // MSVCRT C rename 不覆盖已存在目标（EEXIST），qemu 共享文件夹上行为更脆；
            // MoveFileExW + MOVEFILE_REPLACE_EXISTING 同卷原子替换，带 GetLastError 诊断
            if (!MoveFileEx(tmp, dest, MoveFileFlag.REPLACE_EXISTING))
                throw new Error('MoveFileEx failed (GetLastError ' + GetLastError() + '): ' + tmp + ' -> ' + dest)
        } catch (ex) {
            logReq(t0, 'POST /upload', 500, String(ex))
            return jsonError(500, String(ex))
        }
        logReq(t0, 'POST /upload', 200, bytes.length + 'B -> ' + dest)
        return new Response(JSON.stringify({ bytes: bytes.length, path: dest }),
            { headers: { 'Content-Type': 'application/json' } })
    }
    if (req.method === 'GET' && path === '/download') {
        const p = new URL(req.url).searchParams.get('path')
        if (!p) {
            logReq(t0, 'GET /download', 400, 'path=<文件路径>')
            return jsonError(400, 'path=<文件路径>')
        }
        let f: std.FILE | null = null
        try { f = std.open(p, 'rb') } catch (ex) {
            logReq(t0, 'GET /download', 500, String(ex))
            return jsonError(500, String(ex))
        }
        if (f === null) {
            logReq(t0, 'GET /download', 404, p)
            return jsonError(404, 'cannot open: ' + p)
        }
        try {
            // 引擎 FILE 无 tell/fstat（seek 只回 fseek 结果）：64KB 分块读到 EOF 拼接，
            // 大小自适应、一次成型后走整块发送（sendResponse 缓冲/流式均可）
            const chunks: Uint8Array[] = []
            const buf = new Uint8Array(64 * 1024)
            let total = 0
            for (; ;) {
                const n = f.read(buf.buffer, 0, buf.length)
                if (n <= 0) break
                chunks.push(n === buf.length ? buf.slice() : buf.slice(0, n))
                total += n
            }
            const all = new Uint8Array(total)
            let off = 0
            for (const c of chunks) { all.set(c, off); off += c.length }
            logReq(t0, 'GET /download', 200, total + 'B <- ' + p)
            return new Response(all, {
                headers: { 'Content-Type': 'application/octet-stream', 'X-Bytes': String(total) },
            })
        } catch (ex) {
            logReq(t0, 'GET /download', 500, String(ex))
            return jsonError(500, String(ex))
        } finally {
            f.close()
        }
    }
    // isApi 判定已收口所有未匹配路径——此处仅兜 async 回调的返回类型（运行时不可达）
    return usageResponse()
})

const rc = server.listen(8080, '0.0.0.0')
console.log('listen rc=' + rc + ' addr=' + JSON.stringify(server.address()))
const addr = server.address()
if (addr) boundPort = addr.port
initGui()