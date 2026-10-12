import { createServer } from '../lib/http-server.js'
import * as os from 'os'
import * as std from 'std'
import * as gui from 'gui'
import { RequestLog, type LogEntry } from '../lib/exec-log.js'
import { createRoot, ListBox } from '../lib/react-qw/index.js'
import { useEffect, useState } from 'react'
import { closure, WCHAR } from '../lib/ffi/bind.js'
import { NULL, type Ptr, PtrArrayBuffer } from '../lib/ffi/ctype.js'
import {
    ChangeDisplaySettings, ClientToScreen, EnumDisplaySettings, EnumWindows, GetClassName,
    GetClientRect, GetDC, GetSystemMetrics, GetWindowRect, GetWindowText, IsIconic,
    IsWindowVisible, PrintWindow, ReleaseDC,
} from '../lib/windows/user32.js'
import {
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, SelectObject,
} from '../lib/windows/gdi32.js'
import { BITMAPFILEHEADER, BITMAPINFOHEADER, DEVMODEW, POINT, RECT } from '../lib/windows/structs.js'

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
// 解析并把剩余全部交给脚本（见 main.c 参数解析段）。因此空格分隔
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

// 路由统一记日志（收敛各路由手写的 ts/durMs 样板）；exit 只在 /exec 完成时非 null
function logReq(t0: number, cmd: string, status: number, note?: string, exit: number | null = null): void {
    appendLog({ ts: Date.now() / 1000, cmd, status, exit, durMs: Date.now() - t0, note })
}

function bumpWorkers(d: number): void {
    activeWorkers += d
    refreshGui()
}

function initGui(): void {
    if (!cfg.gui) return
    try {
        const root = createRoot({
            text: 'execd · :' + (boundPort || 8080),
            x: 200, y: 200, width: 560, height: 420,
        })
        root.render(<LogPanel />)
        // run.bat 用 `start /min` 启动，这里显式还原，避免窗口只留一条标题栏
        gui.ShowWindow(root.hwnd, gui.ShowWindowCmd.RESTORE)
    } catch (ex) {
        // 无桌面/建窗失败时回退 headless，绝不影响服务
        console.error('[execd] gui init failed (fallback headless):', ex)
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

// —— 截屏：BitBlt → 32bpp 顶向下 → BMP 包装（无压缩）——
// 行宽：32bpp 下每行 w*4 字节，天然 4 字节对齐，与 BMP 的行填充规则一致，
// 所以 GetDIBits 拿到的像素可以原样当 BMP 数据体。
const SRCCOPY = 0x00cc0020
const DIB_RGB_COLORS = 0
// 单次捕获像素上限（≈160MB 像素缓冲），挡住畸形 rect 造成的巨量分配
const MAX_CAPTURE_PX = 40000000
const WIDE_BUF_CHARS = 512
const MAX_WINDOWS = 20000

// BMP 文件 = 文件头(14B, pack 2) + 信息头(40B) + 像素
const BMP_HEADERS_SIZE = BITMAPFILEHEADER.size + BITMAPINFOHEADER.size

function bmpHeader(size: number, w: number, h: number): Uint8Array {
    const fileHdr = BITMAPFILEHEADER.encode({
        bfType: 0x4d42,                              // 'BM'
        bfSize: BMP_HEADERS_SIZE + size,             // 文件总长 = 头 + 像素
        bfOffBits: BMP_HEADERS_SIZE,                 // 像素数据偏移
    })
    const infoHdr = BITMAPINFOHEADER.encode({
        biSize: BITMAPINFOHEADER.size,
        biWidth: w,
        biHeight: -h,                                // 负 = 顶向下
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0,                            // BI_RGB
        biSizeImage: size,
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
    const pxB = new PtrArrayBuffer(w * h * 4)
    const px = new Uint8Array(pxB)
    const bmi = BITMAPINFOHEADER.encode({
        biSize: BITMAPINFOHEADER.size,
        biWidth: w,
        biHeight: -h,           // 负 = 顶向下
        biPlanes: 1,
        biBitCount: 32,         // biCompression 缺省 0 = BI_RGB
        biSizeImage: w * h * 4,
    })

    const got = GetDIBits(hdc, hbm, 0, h, pxB, bmi.ptr, DIB_RGB_COLORS)
    if (got !== h) return null

    const out = new Uint8Array(BMP_HEADERS_SIZE + px.byteLength)
    out.set(bmpHeader(px.byteLength, w, h), 0)
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
    [gui.DisplayChangeResult.SUCCESSFUL]: 'SUCCESSFUL',
    [gui.DisplayChangeResult.RESTART]: 'RESTART',
    [gui.DisplayChangeResult.FAILED]: 'FAILED',
    [gui.DisplayChangeResult.BADMODE]: 'BADMODE',
    [gui.DisplayChangeResult.NOTUPDATED]: 'NOTUPDATED',
    [gui.DisplayChangeResult.BADFLAGS]: 'BADFLAGS',
    [gui.DisplayChangeResult.BADPARAM]: 'BADPARAM',
    [gui.DisplayChangeResult.BADDUALVIEW]: 'BADDUALVIEW',
}

function dispChangeName(ret: number): string {
    return DISP_CHANGE_NAME[ret] ?? '?'
}

/** 当前屏幕实测尺寸 'WxH'（模式切换后立即反映） */
function currentScreen(): string {
    return GetSystemMetrics(gui.SysMetrics.CXSCREEN) + 'x' + GetSystemMetrics(gui.SysMetrics.CYSCREEN)
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
    if (!EnumDisplaySettings(NULL, gui.EnumDisplaySetting.CURRENT_SETTINGS, dm.ptr)) {
        throw new Error('applyDisplayMode: EnumDisplaySettings CURRENT failed')
    }
    const cur = DEVMODEW.decode(dm)
    const before = cur.dmPelsWidth + 'x' + cur.dmPelsHeight

    // 同一 buffer 原地改三项（encode 缺省字段跳过 = 保留 Enum 填的其余项）
    DEVMODEW.encode({
        dmFields: cur.dmFields | gui.DevModeField.PELSWIDTH | gui.DevModeField.PELSHEIGHT,
        dmPelsWidth: w,
        dmPelsHeight: h,
    }, dm)

    const testRet = ChangeDisplaySettings(dm.ptr, gui.ChangeDisplayFlag.TEST)
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
        ret = ChangeDisplaySettings(dm.ptr, gui.ChangeDisplayFlag.UPDATEREGISTRY)
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
  POST /set_resolution       ?w=<px>&h=<px>&persist=0|1（默认 1 = 写注册表跨重启）→ JSON
                     {before,after,testRet,ret,retName,modes32}；modes32 恒带 32bpp
                     可用模式（非法宽高会以 BADMODE 拒绝并给本列表）`

function usageResponse(): Response {
    return new Response(USAGE, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

const server = createServer(async (req) => {
    const t0 = Date.now()
    const path = new URL(req.url).pathname
    const isApi = (req.method === 'POST' && (path === '/exec' || path === '/set_resolution')) ||
        (req.method === 'GET' && (path === '/window_list' || path === '/screenshot'))
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
    // isApi 判定已收口所有未匹配路径——此处仅兜 async 回调的返回类型（运行时不可达）
    return usageResponse()
})

const rc = server.listen(8080, '0.0.0.0')
console.log('listen rc=' + rc + ' addr=' + JSON.stringify(server.address()))
const addr = server.address()
if (addr) boundPort = addr.port
initGui()