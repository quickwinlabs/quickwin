import * as os from 'os'
import * as std from 'std'
import { bind, closure, WCHAR } from '../lib/ffi/bind.js'
import { NULL, type Ptr, PtrArrayBuffer } from '../lib/ffi/ctype.js'
import { struct } from '../lib/ffi/struct.js'
import {
    CloseHandle, CreatePipe, CreateProcess, GetExitCodeProcess, GetLastError, GetSystemDirectory,
    ReadFile, SetHandleInformation, WaitForSingleObject,
} from '../lib/windows/kernel32.js'
import {
    ClientToScreen, EnumWindows, GetClassName, GetClientRect, GetDC, GetSystemMetrics, GetWindowRect,
    GetWindowText, IsIconic, IsWindowVisible, PrintWindow, ReleaseDC,
} from '../lib/windows/user32.js'
import {
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, SelectObject,
} from '../lib/windows/gdi32.js'
import {
    BITMAPFILEHEADER, BITMAPINFOHEADER, POINT, PROCESS_INFORMATION, RECT, STARTUPINFOW,
} from '../lib/windows/structs.js'

// worker 没有可观测的输出通道：绑定失败会静默中断 worker 脚本，主线程永远等不到消息。
// 失败原因落盘 diag.log 以便定位（典型：DLL 位数与进程不匹配 -> ERROR_BAD_EXE_FORMAT 193）。
const diagFile = (stage: string): void => {
    try {
        const f = std.open('diag.log', 'a')
        if (f) { f.puts(`${Date.now()} ${stage}\n`); f.close() }
    } catch (ex) { /* best effort */ }
}

const HANDLE_FLAG_INHERIT = 0x1
const STARTF_USESTDHANDLES = 0x100
const WAIT_INFINITE = 0xffffffff
// STARTUPINFOW / PROCESS_INFORMATION 的布局随进程位宽（x86 68B / x64 104B），由 struct 按 os.arch 推。
// os.arch 是编译期的进程指针宽度（quickjs-libc.c OS_ARCH），WOW64 下的 32 位进程得 ia32 布局——
// 本地 win7 VM 上的 exec_server 就是 32 位进程跑在 64 位系统上。

const parent = os.Worker.parent

// GetSystemDirectoryW 拼 cmd.exe 全路径。
// 探针实测（XP/Win7 均如此）：CreateProcessW 的 lpCommandLine 第一个 token 若是
// 裸 "cmd.exe"，PATH 解析在本环境失败（err 267 ERROR_DIRECTORY / 123 ERROR_INVALID_NAME），
// 用全路径即正常。cmd 内部再解析 ping/dir 等用自己的 PATH，无此问题。
let sysDir = 'C:\\Windows\\System32'
try {
    const out = WCHAR.alloc(256)
    const n = GetSystemDirectory(out, 256)
    const s = n > 0 ? WCHAR.decode(out) : ''
    if (s) sysDir = s
} catch (ex) {
    diagFile('SYS-DIR-FAIL: ' + String(ex))
}

// win11（NT 10.x）上用 `/u` 让 cmd 内置输出直接写 UTF-16LE，绕开 ACP（Tiny11 缺
// c_*.nls 且 ACP=1252，中文会退化成 `?`）。win7/XP 的 ACP=936 本来就无损，保持原样。
// 版本信息缓冲按 148 字节分配并把 dwOSVersionInfoSize 填成同值（尾部 128 字节 = szCSDVersion 区），
// 否则 RtlGetVersion 会越界写坏 worker 堆导致子进程挂起。注意这不是标准 OSVERSIONINFOW
// （宽字符 szCSDVersion[128] 应为 276B）；148 是 win11 上实测过的值，保持不变，故用本地结构而非标准定义。
const OSVERSIONINFO_148 = /* @__PURE__ */ struct('OSVERSIONINFO_148', {
    dwOSVersionInfoSize: 'u32',
    dwMajorVersion: 'u32',
    dwMinorVersion: 'u32',
    dwBuildNumber: 'u32',
    dwPlatformId: 'u32',
    szCSDVersion: 'u8[128]',
})
let IS_WIN11 = false
try {
    // ntdll 仅此一个函数，不单开文件；绑定失败落 VER-FAIL 诊断（见 diagFile）
    const rtlGetVersion = bind('ntdll.dll', 'RtlGetVersion', '<BYTE>ptr -> i32')
    const vi = OSVERSIONINFO_148.encode({ dwOSVersionInfoSize: OSVERSIONINFO_148.size })
    if (rtlGetVersion(vi) === 0) {
        IS_WIN11 = OSVERSIONINFO_148.decode(vi).dwMajorVersion >= 10
    }
} catch (ex) {
    diagFile('VER-FAIL: ' + String(ex))
}

// 用 CreateProcessW + CreatePipe 直接捕获子进程 stdout（替代 winpty）。
// 纯捕获场景（/exec 从不交互），管道方案比 winpty 少一层 agent 中转：
//   - 流式粒度更好：探针实测 XP 上逐行实时到达（winpty 攒批 ~4s）
//   - 无 winpty.dll / winpty-agent.exe 依赖，纯 kernel32
// 编码：无统一代码页转换，各程序输出原生字节（qwin= UTF-8、系统命令= GBK）。
// 同步阻塞读循环（worker 线程自转），主线程事件循环不受影响。
// CreatePipe 的两个 HANDLE 出参槽：一个结构两个指针字段，读回走 decode
// CreatePipe 成功后两端句柄必非零（失败已在下方 throw）——字段标 '!'，decode 直出 Ptr
const PIPE_HANDLES = /* @__PURE__ */ struct('PIPE_HANDLES', { hRead: '<HFILE>ptr!', hWrite: '<HFILE>ptr!' })

function runCmd(id: number, cmd: string): number {
    // —— 管道 + 继承设置（读端不可继承，否则 EOF 永不触发）——
    const pipe = PIPE_HANDLES.alloc()
    if (!CreatePipe(pipe.ptr, pipe.ptr + PIPE_HANDLES.offsetOf('hWrite'), NULL, 0)) {
        throw new Error('CreatePipe err=' + GetLastError())
    }
    const { hRead, hWrite } = PIPE_HANDLES.decode(pipe)
    SetHandleInformation(hWrite, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)
    SetHandleInformation(hRead, HANDLE_FLAG_INHERIT, 0)

    // —— STARTUPINFO（写端作为子进程 stdout/stderr）——
    const pi = PROCESS_INFORMATION.alloc()
    const u = IS_WIN11 ? '/u ' : ''
    const cmdline = `${sysDir}\\cmd.exe ${u}/c ${cmd}`
    if (!CreateProcess(NULL, cmdline, NULL, NULL, 1, 0, NULL, NULL,
        { cb: STARTUPINFOW.size, dwFlags: STARTF_USESTDHANDLES, hStdOutput: hWrite, hStdError: hWrite }, pi.ptr)) {
        CloseHandle(hRead)
        CloseHandle(hWrite)
        throw new Error('CreateProcessW err=' + GetLastError() + ' cmd=' + cmdline)
    }
    const { hProcess, hThread, dwProcessId } = PROCESS_INFORMATION.decode(pi)
    CloseHandle(hThread)
    CloseHandle(hWrite)
    parent.postMessage({ type: 'info', id, pid: dwProcessId })

    // —— 同步阻塞读循环（子进程树全退出、写端全关 -> EOF -> 收尾）——
    const bufB = new PtrArrayBuffer(4096)
    const buf = new Uint8Array(bufB)
    const nReadB = new PtrArrayBuffer(4)
    const nRead = new Uint32Array(nReadB)
    for (;;) {
        nRead[0] = 0
        if (!ReadFile(hRead, bufB, 4096, nReadB, NULL)) break
        const n = nRead[0]!
        if (n === 0) break
        parent.postMessage({ type: 'data', id, chunk: buf.slice(0, n) })
    }

    WaitForSingleObject(hProcess, WAIT_INFINITE)
    const ecB = new PtrArrayBuffer(4)
    const ec = new Int32Array(ecB)
    GetExitCodeProcess(hProcess, ecB)
    const code = ec[0]!
    CloseHandle(hRead)
    CloseHandle(hProcess)
    return code
}

// —— 截屏：全屏 BitBlt → 32bpp 顶向下 → BMP 包装（无压缩）——
// 不 import 'gui'：那个模块的初始化依赖主线程 GUI 循环，exec_server 没有窗口；
// 这里跟 lib/text-measure.ts 一样直接用 bind 绑 user32/gdi32。
// 行宽：32bpp 下每行 w*4 字节，天然 4 字节对齐，与 BMP 的行填充规则一致，
// 所以 GetDIBits 拿到的像素可以原样当 BMP 数据体。
const SRCCOPY = 0x00cc0020
const DIB_RGB_COLORS = 0
const SCREENSHOT_CHUNK = 65536
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

// 取 hdc 当前选中位图的全部像素，按 BMP 分块发出。返回 GetDIBits 是否全量成功。
function emitDib(id: number, hdc: Ptr<'HDC'>, hbm: number, w: number, h: number): boolean {
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
    if (got !== h) return false

    const size = px.byteLength
    parent.postMessage({ type: 'data', id, chunk: bmpHeader(size, w, h) })
    for (let i = 0; i < size; i += SCREENSHOT_CHUNK) {
        parent.postMessage({ type: 'data', id, chunk: px.slice(i, Math.min(i + SCREENSHOT_CHUNK, size)) })
    }
    return true
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

// 抓一张 [outW x outH] 的位图。只做两件事：填内存 DC → GetDIBits 取出 → 发 data 帧。
// hwnd 为 null：srcX/srcY 是屏幕坐标，BitBlt 直接截出结果，没有裁切这一步；
// 非 null：PrintWindow 让窗口自行重绘（可截被遮挡、最小化的窗口），再裁出窗口相对偏移
// (cropX,cropY) 处的子矩形。两条路径的坐标语义不同，所以 crop 只对 print 有意义。
// 只返回尺寸，像素走 parent.postMessage 分块发出（复用 /exec 的 data 帧）。
// 注意：BitBlt 自 GetDC(NULL) 截的是「调用线程所在 session 的输入桌面」，
// 在 sshd / service（session 0）里跑会得到全黑图且**不报错**——调用方要校验像素内容。
function captureRect(id: number, frameW: number, frameH: number, srcX: number, srcY: number,
    cropX: number, cropY: number, outW: number, outH: number, hwnd: Ptr<'HWND'> | null):
    { width: number; height: number } {
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
    const complete = ok && emitDib(id, hdcOut, hbmOut, outW, outH)
    DeleteObject(hbmOut)
    DeleteDC(hdcOut)
    ReleaseDC(NULL, hdcScreen)

    if (!ok) {
        throw new Error('capture failed out=' + outW + 'x' + outH
            + (hwnd === null ? ' at=(' + srcX + ',' + srcY + ')'
                : ' hwnd=' + hwnd + ' crop=(' + cropX + ',' + cropY + ') frame=' + frameW + 'x' + frameH))
    }
    if (!complete) throw new Error('GetDIBits short read out=' + outW + 'x' + outH)
    return { width: outW, height: outH }
}

// 抓主屏全屏
function captureScreen(id: number): { width: number; height: number } {
    const w = GetSystemMetrics(0)
    const h = GetSystemMetrics(1)
    if (w <= 0 || h <= 0) throw new Error('GetSystemMetrics w=' + w + ' h=' + h)
    return captureRect(id, w, h, 0, 0, 0, 0, w, h, null)
}

// 抓单个窗口。area=client 只抓客户区；mode=print 让窗口自行重绘（窗口可被遮挡、可最小化）。
function captureWindow(id: number, hwnd: Ptr<'HWND'>, area: 'window' | 'client', mode: 'screen' | 'print'):
    { width: number; height: number } {
    if (mode === 'screen' && IsIconic(hwnd) !== 0) {
        throw new Error('window minimized：mode=screen 只会截到它下方的桌面，改用 mode=print')
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
    return captureRect(id, ww, wh, sx, sy, cropX, cropY, cw, ch, mode === 'print' ? hwnd : null)
}

// 顶层窗口列表（不递归子控件）。EnumWindows 先拍窗口快照再回调：不像 FindWindowEx 链式遍历
// 那样，在「下一个窗口恰好被销毁」时拿到失效句柄，下一轮返回 NULL 把列表悄悄截断。
// 回调只收集句柄：回调内抛异常会被 closure 吞成返回 0（枚举静默提前结束），所以不在回调里查属性。
// 快照里的窗口在逐个查询时可能已销毁，GetWindowRect 返回 0 即跳过。
// 输出顺序是 EnumWindows 的顺序（与 FindWindowEx 链的顺序不同，集合相同；API 未承诺顺序）。
function listWindows(id: number): void {
    const handles: Ptr<'HWND'>[] = []
    const collect = closure('<HWND>ptr <>ptr -> i32', (h) => {
        if (h) handles.push(h)
        return handles.length < MAX_WINDOWS ? 1 : 0   // 返回 0 = 停止枚举（到上限）
    })
    try { EnumWindows(collect.ptr, NULL) } finally { collect.dispose() }

    const wRect = RECT.alloc()
    const tb = WCHAR.alloc(WIDE_BUF_CHARS)
    const cb = WCHAR.alloc(WIDE_BUF_CHARS)

    const out: Array<Record<string, unknown>> = []
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
    parent.postMessage({ type: 'result', id, code: 0, error: null, windows: out })
}

function handleRequest(msg: {
    type: string; id: number; cmd?: string
    hwnd?: number; area?: 'window' | 'client'; mode?: 'screen' | 'print'
}): void {
    if (msg.type === 'run') {
        if (typeof msg.cmd !== 'string') return
        let code = -1
        let error: string | null = null
        try {
            code = runCmd(msg.id, msg.cmd)
        } catch (ex) {
            error = String(ex)
        }
        parent.postMessage({ type: 'result', id: msg.id, code, error })
        return
    }
    if (msg.type === 'windows') {
        try {
            listWindows(msg.id)
        } catch (ex) {
            parent.postMessage({ type: 'result', id: msg.id, code: -1, error: String(ex) })
        }
        return
    }
    if (msg.type === 'screenshot') {
        try {
            // JSON 来的句柄是普通 number，在消息边界一次性标 HWND 品牌（有效性由 Win32 判定）
            const hwnd = (msg.hwnd ?? null) as Ptr<'HWND'> | null
            const { width, height } = hwnd === null
                ? captureScreen(msg.id)
                : captureWindow(msg.id, hwnd, msg.area ?? 'window', msg.mode ?? 'screen')
            parent.postMessage({ type: 'result', id: msg.id, code: 0, error: null, width, height })
        } catch (ex) {
            parent.postMessage({ type: 'result', id: msg.id, code: -1, error: String(ex) })
        }
    }
}

parent.onmessage = (e) => {
    handleRequest(e.data as { type: string; id: number; cmd?: string })
    // 父侧每个请求起一个新 worker，一次只处理一个请求，处理完立刻释放自己的 port：
    // port_list 清空后 js_os_poll 返回 -1（quickjs-libc.c:2506）→ 本线程退出，
    // JSRuntime 随之释放。不设 null 的话线程常驻（实测 win7 30 次 /screenshot 线程 4→35）。
    // 注意父侧 `worker.onmessage = null` 只释放父侧 port，对本线程无效——必须在这里设。
    // 消息已在 js_post_message_pipe 进队列，父侧读的是同一份 refcount 共享管道，线程退出不影响。
    parent.onmessage = null
}
