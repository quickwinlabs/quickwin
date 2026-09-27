import * as os from 'os'
import * as std from 'std'
import * as ffi from 'ffi'
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
        createProcessW: bind('kernel32.dll', 'CreateProcessW', 'wstr wstr ptr ptr i32 u32 ptr wstr ptr ptr -> i32'),
        waitForSingleObject: bind('kernel32.dll', 'WaitForSingleObject', 'ptr u32 -> u32'),
        getExitCodeProcess: bind('kernel32.dll', 'GetExitCodeProcess', 'ptr ptr -> i32'),
        readFile: bind('kernel32.dll', 'ReadFile', 'ptr ptr u32 ptr ptr -> i32'),
        closeHandle: bind('kernel32.dll', 'CloseHandle', 'ptr -> i32'),
        getLastError: bind('kernel32.dll', 'GetLastError', ' -> u32'),
        getSystemDirectoryW: bind('kernel32.dll', 'GetSystemDirectoryW', 'ptr u32 -> u32'),
    }
} catch (ex) {
    diagFile('K-BIND-FAIL: ' + String(ex))
    throw ex
}

const PTR = os.arch === 'x64' ? 8 : 4
const HANDLE_FLAG_INHERIT = 0x1
const STARTF_USESTDHANDLES = 0x100
const WAIT_INFINITE = 0xffffffff
// STARTUPINFOW 字段偏移随字宽变化：x64 指针字段 8 字节（对齐后整体 104B），x86 68B。
const L = PTR === 8 ? { flags: 60, hOut: 88, hErr: 96, siSize: 104, piSize: 24, pidAt: 16 }
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
    let v = 0
    for (let i = 0; i < 8; i++) v |= ffi.readByte(p + off + i) << (8 * i)
    return v >>> 0
}

function wrPtr(p: number, off: number, t: number): void {
    if (PTR === 4) { u32At(p, off, t >>> 0); return }
    for (let i = 0; i < 8; i++) ffi.writeByte(p + off + i, (t >>> (8 * i)) & 0xff)
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
    const cmdline = `${sysDir}\\cmd.exe /c ${cmd}`
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

parent.onmessage = (e) => {
    const msg = e.data as { type: string; id: number; cmd?: string }
    if (msg.type !== 'run' || typeof msg.cmd !== 'string') return
    let code = -1
    let error: string | null = null
    try {
        code = runCmd(msg.id, msg.cmd)
    } catch (ex) {
        error = String(ex)
    }
    parent.postMessage({ type: 'result', id: msg.id, code, error })
}