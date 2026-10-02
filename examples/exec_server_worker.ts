import * as os from 'os'
import * as std from 'std'
import * as ffi from 'ffi'
import '../lib/text-codec.js'
import { bind } from '../lib/ffi-bind.js'

// worker 没有可观测的输出通道：绑定失败会静默中断 worker 脚本，主线程永远等不到消息。
// 失败原因落盘 diag.log 以便定位（典型：DLL 位数与进程不匹配 -> ERROR_BAD_EXE_FORMAT 193）。
const diagFile = (stage: string): void => {
    try {
        const f = std.open('diag.log', 'a')
        if (f) { f.puts(`${Date.now()} ${stage}\n`); f.close() }
    } catch (ex) { /* best effort */ }
}

// 绑定放 try/catch：任一步 LoadLibrary/GetProcAddress 失败都会中断 worker 脚本
// （主线程将永远等不到消息）——捕获并记下具体原因。
let K: any
try {
    K = {
        createPipe: bind('kernel32.dll', 'CreatePipe', 'ptr ptr ptr u32 -> i32'),
        setHandleInformation: bind('kernel32.dll', 'SetHandleInformation', 'ptr u32 u32 -> i32'),
        createProcessW: bind('kernel32.dll', 'CreateProcessW', 'wchar_ptr wchar_ptr ptr ptr i32 u32 ptr wchar_ptr ptr ptr -> i32'),
        waitForSingleObject: bind('kernel32.dll', 'WaitForSingleObject', 'ptr u32 -> u32'),
        getExitCodeProcess: bind('kernel32.dll', 'GetExitCodeProcess', 'ptr ptr -> i32'),
        readFile: bind('kernel32.dll', 'ReadFile', 'ptr ptr u32 ptr ptr -> i32'),
        closeHandle: bind('kernel32.dll', 'CloseHandle', 'ptr -> i32'),
        getLastError: bind('kernel32.dll', 'GetLastError', ' -> u32'),
        getSystemDirectoryW: bind('kernel32.dll', 'GetSystemDirectoryW', 'ptr u32 -> u32'),
        getSystemInfo: bind('kernel32.dll', 'GetSystemInfo', 'ptr -> void'),
        rtlGetVersion: bind('ntdll.dll', 'RtlGetVersion', 'ptr -> i32'),
    }
} catch (ex) {
    diagFile('K-BIND-FAIL: ' + String(ex))
    throw ex
}

// 布局长度由「调用进程位数」决定（CreateProcessW 以调用进程位数解析 STARTUPINFO）。
// 不能用 os.arch：它报告的是系统原生架构，64 位 Win7 上运行 32 位 exec_server 时
// os.arch='x64'，会误选 64 位布局，使 hStdOutput/hStdError 落在错误偏移，
// 子进程全部 stdout/stderr 丢失（现象：exit code 0 但 body 全空）。
// GetSystemInfo 报告进程视角架构（WOW64 下返回 INTEL=0），用它判定。
const sysinfoBuf = new ArrayBuffer(64)
K.getSystemInfo(ffi.bufferPtr(sysinfoBuf))
const sysinfoPtr = ffi.bufferPtr(sysinfoBuf)
const wArch = ffi.readByte(sysinfoPtr) | (ffi.readByte(sysinfoPtr + 1) << 8)
const IS_PROC_64 = wArch === 9 /* PROCESSOR_ARCHITECTURE_AMD64 */
const PTR = IS_PROC_64 ? 8 : 4
const HANDLE_FLAG_INHERIT = 0x1
const STARTF_USESTDHANDLES = 0x100
const WAIT_INFINITE = 0xffffffff
// STARTUPINFOW 字段偏移随进程位数变化：x64 指针字段 8 字节（对齐后整体 104B），x86 68B。
const L = IS_PROC_64 ? { flags: 60, hOut: 88, hErr: 96, siSize: 104, piSize: 24, pidAt: 16 }
                     : { flags: 44, hOut: 60, hErr: 64, siSize: 68, piSize: 16, pidAt: 8 }

const parent = os.Worker.parent
const nRead = new ArrayBuffer(4)
const nReadPtr = ffi.bufferPtr(nRead)

if (K.setHandleInformation === undefined) {
    diagFile('SetHandleInformation missing')
    throw new Error('SetHandleInformation not available')
}

function u32At(p: number, off: number, v: number): void {
    ffi.writeByte(p + off, v & 0xff)
    ffi.writeByte(p + off + 1, (v >>> 8) & 0xff)
    ffi.writeByte(p + off + 2, (v >>> 16) & 0xff)
    ffi.writeByte(p + off + 3, (v >>> 24) & 0xff)
}

function rdU32(p: number): number {
    return ffi.readByte(p) | (ffi.readByte(p + 1) << 8) | (ffi.readByte(p + 2) << 16) | ((ffi.readByte(p + 3) << 24) >>> 0)
}

function rdI32(p: number): number {
    const v = rdU32(p)
    return v > 0x7fffffff ? v - 0x100000000 : v
}

function rdPtr(p: number, off: number): number {
    if (PTR === 4) return rdU32(p + off)
    // 64 位：JS 位运算移位量取 mod 32（`<< 32` 等价 `<< 0`），
    // 不能逐 8 位移位拼 8 字节；拆高/低两个 u32 各读一次再合成。
    const lo = rdU32(p + off)
    const hi = rdU32(p + off + 4)
    return hi === 0 ? lo : hi * 0x100000000 + lo
}

function wrPtr(p: number, off: number, t: number): void {
    if (PTR === 4) { u32At(p, off, t >>> 0); return }
    // 同上：`t >>> 32` 等价 `t >>> 0`，会把手柄/地址低 32 位重复写进高 32 位，
    // 导致 SI 里 hStdOutput/hStdError 变成 0x000000f4000000f4 这类非法 64 位句柄。
    u32At(p, off, t >>> 0)
    u32At(p, off + 4, (t / 0x100000000) >>> 0)
}

function zeroBuf(n: number): ArrayBuffer {
    const b = new ArrayBuffer(n)
    const p = ffi.bufferPtr(b)
    for (let i = 0; i < n; i++) ffi.writeByte(p + i, 0)
    return b
}

// GetSystemDirectoryW 拼 cmd.exe 全路径。
// 探针实测（XP/Win7 均如此）：CreateProcessW 的 lpCommandLine 第一个 token 若是
// 裸 "cmd.exe"，PATH 解析在本环境失败（err 267 ERROR_DIRECTORY / 123 ERROR_INVALID_NAME），
// 用全路径即正常。cmd 内部再解析 ping/dir 等用自己的 PATH，无此问题。
let sysDir = 'C:\\Windows\\System32'
try {
    const b = zeroBuf(512)
    const n = K.getSystemDirectoryW(ffi.bufferPtr(b), 256)
    let s = ''
    for (let i = 0; i < n * 2; i += 2) {
        const u = ffi.readByte(ffi.bufferPtr(b) + i) | (ffi.readByte(ffi.bufferPtr(b) + i + 1) << 8)
        if (u !== 0) s += String.fromCharCode(u)
    }
    if (s) sysDir = s
} catch (ex) {
    diagFile('SYS-DIR-FAIL: ' + String(ex))
}

// win11（NT 10.x）上用 `/u` 让 cmd 内置输出直接写 UTF-16LE，绕开 ACP（Tiny11 缺
// c_*.nls 且 ACP=1252，中文会退化成 `?`）。win7/XP 的 ACP=936 本来就无损，保持原样。
// OSVERSIONINFOW 的 dwOSVersionInfoSize 必须填满 148（含 128 字节 szCSDVersion 尾部），
// 分配同样 148 字节缓冲区，否则 RtlGetVersion 会越界写坏 worker 堆导致子进程挂起。
let IS_WIN11 = false
try {
    const vb = zeroBuf(148)
    u32At(ffi.bufferPtr(vb), 0, 148)
    if (K.rtlGetVersion(ffi.bufferPtr(vb)) === 0) {
        const maj = rdU32(ffi.bufferPtr(vb) + 4)
        IS_WIN11 = maj >= 10
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
function runCmd(id: number, cmd: string): number {
    // —— 管道 + 继承设置（读端不可继承，否则 EOF 永不触发）——
    const pipes = zeroBuf(PTR * 2)
    if (!K.createPipe(ffi.bufferPtr(pipes), ffi.bufferPtr(pipes) + PTR, 0, 0)) {
        throw new Error('CreatePipe err=' + K.getLastError())
    }
    const hRead = rdPtr(ffi.bufferPtr(pipes), 0)
    const hWrite = rdPtr(ffi.bufferPtr(pipes), PTR)
    K.setHandleInformation(hWrite, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)
    K.setHandleInformation(hRead, HANDLE_FLAG_INHERIT, 0)

    // —— STARTUPINFO（写端作为子进程 stdout/stderr）——
    const si = zeroBuf(L.siSize)
    u32At(ffi.bufferPtr(si), 0, L.siSize)
    u32At(ffi.bufferPtr(si), L.flags, STARTF_USESTDHANDLES)
    wrPtr(ffi.bufferPtr(si), L.hOut, hWrite)
    wrPtr(ffi.bufferPtr(si), L.hErr, hWrite)

    const pi = zeroBuf(L.piSize)
    const u = IS_WIN11 ? '/u ' : ''
    const cmdline = `${sysDir}\\cmd.exe ${u}/c ${cmd}`
    if (!K.createProcessW(null, cmdline, 0, 0, 1, 0, 0, null, ffi.bufferPtr(si), ffi.bufferPtr(pi))) {
        K.closeHandle(hRead)
        K.closeHandle(hWrite)
        throw new Error('CreateProcessW err=' + K.getLastError() + ' cmd=' + cmdline)
    }
    const hProc = rdPtr(ffi.bufferPtr(pi), 0)
    const hThread = rdPtr(ffi.bufferPtr(pi), PTR)
    const pid = rdU32(ffi.bufferPtr(pi) + L.pidAt)
    K.closeHandle(hThread)
    K.closeHandle(hWrite)
    parent.postMessage({ type: 'info', id, pid })

    // —— 同步阻塞读循环（子进程树全退出、写端全关 -> EOF -> 收尾）——
    const buf = new Uint8Array(4096)
    const bufPtr = ffi.bufferPtr(buf.buffer)
    for (;;) {
        u32At(nReadPtr, 0, 0)
        if (!K.readFile(hRead, bufPtr, 4096, nReadPtr, 0)) break
        const n = rdU32(nReadPtr)
        if (n === 0) break
        parent.postMessage({ type: 'data', id, chunk: buf.slice(0, n) })
    }

    K.waitForSingleObject(hProc, WAIT_INFINITE)
    const ec = zeroBuf(4)
    K.getExitCodeProcess(hProc, ffi.bufferPtr(ec))
    const code = rdI32(ffi.bufferPtr(ec))
    K.closeHandle(hRead)
    K.closeHandle(hProc)
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

let GDI: { u: any; g: any } | null = null

// 惰性绑定 + 失败落 diag：worker 没有可观测输出通道，绑定失败会静默中断脚本，
// 主线程永远等不到消息（与 kernel32 那组绑定同样的处理方式）。
function gdi(): { u: any; g: any } {
    if (GDI !== null) return GDI
    try {
        const u = {
            getSystemMetrics: bind('user32.dll', 'GetSystemMetrics', 'i32 -> i32'),
            getDC: bind('user32.dll', 'GetDC', 'ptr -> ptr'),
            releaseDC: bind('user32.dll', 'ReleaseDC', 'ptr ptr -> i32'),
            getWindowRect: bind('user32.dll', 'GetWindowRect', 'HWND ptr -> BOOL'),
            getClientRect: bind('user32.dll', 'GetClientRect', 'HWND ptr -> BOOL'),
            clientToScreen: bind('user32.dll', 'ClientToScreen', 'HWND ptr -> BOOL'),
            isWindowVisible: bind('user32.dll', 'IsWindowVisible', 'HWND -> BOOL'),
            isIconic: bind('user32.dll', 'IsIconic', 'HWND -> BOOL'),
            getWindowTextW: bind('user32.dll', 'GetWindowTextW', 'HWND ptr u32 -> i32'),
            getClassNameW: bind('user32.dll', 'GetClassNameW', 'HWND ptr u32 -> i32'),
            findWindowExW: bind('user32.dll', 'FindWindowExW', 'HWND HWND wchar_ptr wchar_ptr -> HWND'),
            // PrintWindow 第 4 参是 Windows 8.1+ 的 PW_* flags；XP/Win7 忽略之。
            // 多传一个参数在 __cdecl 下无害（调用者清栈），且在 8.1+ 上传 0 即普通行为。
            printWindow: bind('user32.dll', 'PrintWindow', 'HWND HDC i32 u32 -> BOOL'),
        }
        const g = {
            createCompatibleDC: bind('gdi32.dll', 'CreateCompatibleDC', 'HDC -> HDC'),
            createCompatibleBitmap: bind('gdi32.dll', 'CreateCompatibleBitmap', 'HDC i32 i32 -> HBITMAP'),
            selectObject: bind('gdi32.dll', 'SelectObject', 'HDC HBITMAP -> ptr'),
            bitBlt: bind('gdi32.dll', 'BitBlt', 'HDC i32 i32 i32 i32 HDC i32 i32 UINT -> BOOL'),
            getDIBits: bind('gdi32.dll', 'GetDIBits', 'HDC HBITMAP u32 u32 ptr ptr UINT -> i32'),
            deleteObject: bind('gdi32.dll', 'DeleteObject', 'HBITMAP -> i32'),
            deleteDC: bind('gdi32.dll', 'DeleteDC', 'HDC -> i32'),
        }
        GDI = { u, g }
        return GDI
    } catch (ex) {
        diagFile('GDI-BIND-FAIL: ' + String(ex))
        throw ex
    }
}

function bmpHeader(size: number, w: number, h: number): Uint8Array {
    const b = new Uint8Array(54)
    const dv = new DataView(b.buffer)
    b[0] = 0x42                                   // 'B'
    b[1] = 0x4d                                   // 'M'
    dv.setUint32(2, 54 + size, true)              // fileSize = 14(file) + 40(info) + 像素
    dv.setUint32(6, 0, true)                      // reserved
    dv.setUint32(10, 54, true)                    // 数据偏移
    dv.setUint32(14, 40, true)                    // biSize
    dv.setInt32(18, w, true)                      // biWidth
    dv.setInt32(22, -h, true)                     // biHeight：负 = 顶向下
    dv.setUint16(26, 1, true)                     // biPlanes
    dv.setUint16(28, 32, true)                    // biBitCount
    dv.setUint32(30, 0, true)                     // biCompression：0 = BI_RGB
    dv.setUint32(34, size, true)                  // biSizeImage
    dv.setUint32(38, 2835, true)                  // biXPelsPerMeter（72dpi）
    dv.setUint32(42, 2835, true)                  // biYPelsPerMeter
    return b
}

// 取 hdc 当前选中位图的全部像素，按 BMP 分块发出。返回 GetDIBits 是否全量成功。
function emitDib(id: number, hdc: number, hbm: number, w: number, h: number): boolean {
    const { g } = gdi()
    const px = new Uint8Array(w * h * 4)
    const bmi = zeroBuf(40)
    const bp = ffi.bufferPtr(bmi)
    u32At(bp, 0, 40)
    u32At(bp, 4, w)
    u32At(bp, 8, -h | 0)        // biHeight：负 = 顶向下
    u32At(bp, 12, 1)            // biPlanes
    u32At(bp, 14, 32)           // biBitCount（biCompression 落 0 = BI_RGB）
    u32At(bp, 20, w * h * 4)    // biSizeImage

    const got = g.getDIBits(hdc, hbm, 0, h, ffi.bufferPtr(px.buffer), bp, DIB_RGB_COLORS)
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
function printAndCrop(hdcScreen: number, hwnd: number, frameW: number, frameH: number,
    hdcOut: number, cropX: number, cropY: number, outW: number, outH: number): boolean {
    const { u, g } = gdi()
    const hdcTmp = g.createCompatibleDC(hdcScreen)
    const hbmTmp = hdcTmp ? g.createCompatibleBitmap(hdcScreen, frameW, frameH) : 0
    if (!hdcTmp || !hbmTmp) {
        if (hdcTmp) g.deleteDC(hdcTmp)
        return false
    }
    const oldTmp = g.selectObject(hdcTmp, hbmTmp)
    // PrintWindow 从 (0,0) 填整张位图，所以必须给整窗尺寸
    const printed = u.printWindow(hwnd, hdcTmp, 0, 0) !== 0
    const cropped = printed && g.bitBlt(hdcOut, 0, 0, outW, outH, hdcTmp, cropX, cropY, SRCCOPY) !== 0
    g.selectObject(hdcTmp, oldTmp)
    g.deleteObject(hbmTmp)
    g.deleteDC(hdcTmp)
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
    cropX: number, cropY: number, outW: number, outH: number, hwnd: number | null):
    { width: number; height: number } {
    const { u, g } = gdi()
    // 用否定式判断：NaN 会让 `> 0` 与 `> 上限` 同时为假，正写会漏过
    if (!(outW > 0 && outH > 0 && outW * outH <= MAX_CAPTURE_PX)) {
        throw new Error('capture size invalid w=' + outW + ' h=' + outH)
    }
    if (hwnd !== null
        && !(cropX >= 0 && cropY >= 0 && cropX + outW <= frameW && cropY + outH <= frameH)) {
        throw new Error('capture crop out of range crop=(' + cropX + ',' + cropY + ',' + outW + 'x' + outH
            + ') frame=' + frameW + 'x' + frameH)
    }

    const hdcScreen = u.getDC(null)
    if (!hdcScreen) {
        throw new Error('GetDC(null)=0：无输入桌面（确认在交互 session 启动，而非 sshd/service）')
    }
    // 必须传屏幕 DC 建位图：CreateCompatibleBitmap 按「当前选中对象」决定位图格式，
    // 传 hdcOut 时它选中的是 1×1 单色图 → 建出 1×1 位图，BitBlt 被裁剪到 1 像素
    // （症状：blit=1、getdibits=h 都成功，但缓冲区几乎全 0）。
    const hdcOut = g.createCompatibleDC(hdcScreen)
    const hbmOut = hdcOut ? g.createCompatibleBitmap(hdcScreen, outW, outH) : 0
    if (!hdcOut || !hbmOut) {
        if (hdcOut) g.deleteDC(hdcOut)
        u.releaseDC(null, hdcScreen)
        throw new Error('CreateCompatibleDC/Bitmap failed')
    }
    const oldOut = g.selectObject(hdcOut, hbmOut)
    const ok = hwnd === null
        ? g.bitBlt(hdcOut, 0, 0, outW, outH, hdcScreen, srcX, srcY, SRCCOPY) !== 0
        : printAndCrop(hdcScreen, hwnd, frameW, frameH, hdcOut, cropX, cropY, outW, outH)
    g.selectObject(hdcOut, oldOut)
    const complete = ok && emitDib(id, hdcOut, hbmOut, outW, outH)
    g.deleteObject(hbmOut)
    g.deleteDC(hdcOut)
    u.releaseDC(null, hdcScreen)

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
    const { u } = gdi()
    const w = u.getSystemMetrics(0)
    const h = u.getSystemMetrics(1)
    if (w <= 0 || h <= 0) throw new Error('GetSystemMetrics w=' + w + ' h=' + h)
    return captureRect(id, w, h, 0, 0, 0, 0, w, h, null)
}

// 抓单个窗口。area=client 只抓客户区；mode=print 让窗口自行重绘（窗口可被遮挡、可最小化）。
function captureWindow(id: number, hwnd: number, area: 'window' | 'client', mode: 'screen' | 'print'):
    { width: number; height: number } {
    const { u } = gdi()
    if (mode === 'screen' && u.isIconic(hwnd) !== 0) {
        throw new Error('window minimized：mode=screen 只会截到它下方的桌面，改用 mode=print')
    }

    const wb = zeroBuf(16)
    const wp = ffi.bufferPtr(wb)
    if (!u.getWindowRect(hwnd, wp)) {
        throw new Error('GetWindowRect(hwnd=' + hwnd + ')=0：窗口不存在或已销毁')
    }
    const wdv = new DataView(wb)
    const wl = wdv.getInt32(0, true)
    const wt = wdv.getInt32(4, true)
    const wr = wdv.getInt32(8, true)
    const wbot = wdv.getInt32(12, true)
    const ww = wr - wl
    const wh = wbot - wt

    let cropX = 0
    let cropY = 0
    let cw = ww
    let ch = wh
    if (area === 'client') {
        const cb = zeroBuf(16)
        const cp = ffi.bufferPtr(cb)
        if (!u.getClientRect(hwnd, cp)) throw new Error('GetClientRect(hwnd=' + hwnd + ')=0')
        const cdv = new DataView(cb)
        // 客户区坐标以客户区左上角为原点，left/top 恒为 0，不是窗口→客户的偏移；
        // 边框和标题栏的位移必须用 ClientToScreen(0,0) 单独查。尺寸取差值（同理不假设 left/top）。
        const cl = cdv.getInt32(0, true)
        const ct = cdv.getInt32(4, true)
        const cr = cdv.getInt32(8, true)
        const cbot = cdv.getInt32(12, true)
        cw = cr - cl
        ch = cbot - ct
        u32At(cp, 0, 0)
        u32At(cp, 4, 0)
        if (!u.clientToScreen(hwnd, cp)) throw new Error('ClientToScreen(hwnd=' + hwnd + ')=0')
        cropX = rdI32(cp) - wl
        cropY = rdI32(cp + 4) - wt
    }
    // screen：srcX/srcY 给绝对屏幕坐标，截出的就是输出本身，crop 无意义（传 0 即可，反正被忽略）；
    // print：PrintWindow 只能从 (0,0) 画整窗，客户区靠 crop 从整窗位图里裁出来。
    // 两条路径只走一种坐标，所以客户区偏移不会被应用两次。
    let sx = mode === 'print' ? 0 : wl + cropX
    let sy = mode === 'print' ? 0 : wt + cropY
    if (mode === 'screen') {
        // clamp 捕获区域到虚拟屏幕内：窗口超出屏幕时 BitBlt 从屏幕外只能截到黑区，
        // 直接把发出的 BMP 裁到窗口在屏幕内的可见部分（dims 也随之收缩）。
        const vsX = u.getSystemMetrics(76) // SM_XVIRTUALSCREEN
        const vsY = u.getSystemMetrics(77) // SM_YVIRTUALSCREEN
        const vsW = u.getSystemMetrics(78) // SM_CXVIRTUALSCREEN
        const vsH = u.getSystemMetrics(79) // SM_CYVIRTUALSCREEN
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

// 从原生宽字符缓冲区读 JS 字符串（utf-16le；nChars 是 GetWindowTextW/GetClassNameW 的返回值）
function readWide(p: number, nChars: number): string {
    if (nChars <= 0) return ''
    const bytes = new Uint8Array(nChars * 2)
    for (let i = 0; i < bytes.length; i++) bytes[i] = ffi.readByte(p + i)
    return new TextDecoder('utf-16le').decode(bytes)
}

// 顶层窗口列表（不递归子控件）。用 FindWindowExW 链式遍历：
// 本层 FFI 没有函数指针类型，EnumWindows 那类回调接口用不了。
function listWindows(id: number): void {
    const { u } = gdi()
    const wb = zeroBuf(16)
    const tb = zeroBuf(WIDE_BUF_CHARS * 2)
    const cb = zeroBuf(WIDE_BUF_CHARS * 2)
    const wp = ffi.bufferPtr(wb)
    const tp = ffi.bufferPtr(tb)
    const cp = ffi.bufferPtr(cb)

    const out: Array<Record<string, unknown>> = []
    let hwnd = u.findWindowExW(null, 0, null, null)
    while (hwnd && out.length < MAX_WINDOWS) {
        // 先取下一个句柄，避免本次查询期间窗口关闭导致当前句柄失效
        const next = u.findWindowExW(null, hwnd, null, null)

        if (u.getWindowRect(hwnd, wp)) {
            const dv = new DataView(wb)
            const tl = u.getWindowTextW(hwnd, tp, WIDE_BUF_CHARS)
            const cl = u.getClassNameW(hwnd, cp, WIDE_BUF_CHARS)
            out.push({
                hwnd,
                title: readWide(tp, tl),
                className: readWide(cp, cl),
                rect: {
                    left: dv.getInt32(0, true),
                    top: dv.getInt32(4, true),
                    right: dv.getInt32(8, true),
                    bottom: dv.getInt32(12, true)
                },
                visible: u.isWindowVisible(hwnd) !== 0,
                minimized: u.isIconic(hwnd) !== 0
            })
        }
        hwnd = next
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
            const hwnd = msg.hwnd ?? null
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
