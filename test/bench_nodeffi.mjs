// 一次性性能 bench：node:ffi(Node v26.10) 侧，对照我方 test/bench_ffi_overhead.ts
// 不入 CI。用法（win11 VM，exec_server cwd=Z:\quickwin）：
//   POST /exec {"cmd":"node-v26.10.0-win-x64\\node.exe test\\bench_nodeffi.mjs","timeout":600000}
// 场景与批量方法学对齐我方侧：每臂自校准 ~400ms/样本、预热 1、15 轮、median 主指标。
// node:ffi Win64 fast path 上限（总参 ≤3、整型参 ≤3）：nop0/nop1/GetCurrentProcessId
// 走 fast path，SendMessageW(4 参) 回落 generic(libffi)——如实呈现，不裁剪。
// SendMessage 目标窗口在本进程内经 node:ffi 自建（STATIC 预定义类，无消息泵也同步分发）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import ffi from 'node:ffi'

const WM_NULL = 0x0000
const ROUNDS = 15
const TARGET_MS = 400

// 文件日志（cwd=Z:\quickwin，宿主机 _build/bench_nodeffi_log.txt 可实时读）——
// exec 只在进程退出后回包，挂了靠它定位卡点
const logFd = fs.openSync('bench_nodeffi_log.txt', 'w')
function step(msg) {
    console.log(msg)
    fs.writeSync(logFd, msg + '\n')
}

// median（离群稳健）供 calibrate 与 suite 共用
const med = (t) => {
    const s = [...t].sort((x, y) => x - y)
    const m = s.length >> 1
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

step('stage: node ' + process.version + ' on ' + os.platform() + '/' + os.arch())

// 绝对路径直载，绕开 LoadLibrary 相对路径搜索序的歧义（cwd=Z:\quickwin）
const nopDll = path.resolve('test', 'nop.dll')
const { functions: nopFns } = ffi.dlopen(nopDll, {
    nop0: { arguments: [], return: 'void' },
    nop1: { arguments: ['int32'], return: 'int32' },
})
const { functions: k32 } = ffi.dlopen('kernel32.dll', {
    GetCurrentProcessId: { arguments: [], return: 'uint32' },
    GetModuleHandleW: { arguments: ['pointer'], return: 'pointer' },
    GetLastError: { arguments: [], return: 'uint32' },
})
const { functions: u32 } = ffi.dlopen('user32.dll', {
    CreateWindowExW: {
        arguments: ['uint32', 'pointer', 'pointer', 'uint32', 'int32',
            'int32', 'int32', 'int32', 'pointer', 'pointer', 'pointer', 'pointer'],
        return: 'pointer',
    },
    DestroyWindow: { arguments: ['pointer'], return: 'int32' },
    SendMessageW: { arguments: ['pointer', 'uint32', 'pointer', 'pointer'], return: 'pointer' },
})
step('stage: dlopen ok (' + nopDll + ')')

// 可行性探针：签名/返回形态任一不符立刻炸，别等 15 轮跑完才发现白测
nopFns.nop0()
if (nopFns.nop1(1) !== 2) throw new Error('sanity: nop1(1) !== 2')
if (!(k32.GetCurrentProcessId() > 0)) throw new Error('sanity: GetCurrentProcessId <= 0')

// W API 走 UTF-16——node:ffi 的 'string' 类型是 UTF-8 临时副本，对 *W 函数是错的；
// 用 utf16le Buffer 作 'pointer' 实参（STATIC 是 user32 预定义类，免 RegisterClass）
const cls = Buffer.from('STATIC\0', 'utf16le')
const title = Buffer.from('bench-title\0', 'utf16le')
const hInst = k32.GetModuleHandleW(null)
const hwnd = u32.CreateWindowExW(
    0, cls, title, 0 /* WS_OVERLAPPED·不可见 */,
    0, 0, 20, 20, null, null, hInst, null)
if (hwnd === 0n) throw new Error('CreateWindowExW failed, GetLastError=' + k32.GetLastError())
const retSm = u32.SendMessageW(hwnd, WM_NULL, null, null)   // WM_NULL→DefWindowProc 预期返 0
step('stage: window created hwnd=0x' + hwnd.toString(16) + ' sm-ret=' + retSm)

// 每臂循环体：函数先取到局部 const（与我方侧同形态——局部槽访问两边对齐，冷热无关）；
// 调用结果不使用（native 调用有副作用，V8 不会消除）
const nop0 = nopFns.nop0
const nop1 = nopFns.nop1
const getPid = k32.GetCurrentProcessId
const sendSm = u32.SendMessageW

const runNop0 = (n) => {
    const f = nop0
    const t0 = Date.now()
    for (let i = 0; i < n; i++) f()
    return Date.now() - t0
}
const runNop1 = (n) => {
    const f = nop1
    const t0 = Date.now()
    for (let i = 0; i < n; i++) f(1)
    return Date.now() - t0
}
const runPid = (n) => {
    const f = getPid
    const t0 = Date.now()
    for (let i = 0; i < n; i++) f()
    return Date.now() - t0
}
const runSm = (n) => {
    const f = sendSm
    const t0 = Date.now()
    for (let i = 0; i < n; i++) f(hwnd, WM_NULL, null, null)
    return Date.now() - t0
}

// 自校准：探针逐级放大 n0 直到 dt≥20ms（Date.now 1ms 量化步长 ≤5%），按 TARGET_MS 定批量。
// 不预设单次调用量级——fast path 与 generic 路径差一个量级，固定批量必有一侧撞量化墙。
function calibrate(label, fn) {
    let n0 = 10_000
    let dt = 0
    for (;;) {
        dt = fn(n0)
        if (dt >= 20 || n0 >= 10_000_000) break
        n0 *= 10
    }
    const per = dt / n0
    const n = Math.max(10_000, Math.min(10_000_000, Math.round(TARGET_MS / per)))
    step('  calib ' + label + ': probe n=' + n0 + ' dt=' + dt + 'ms → batch=' + n)
    return n
}

const mkArm = (label, fn) => ({ label, n: calibrate(label, fn), fn })

function suite(name, arms) {
    step('suite: ' + name + ' warmup')
    for (const a of arms) a.fn(a.n)   // 预热各 1 轮（含 V8 优化该调用点）
    const times = arms.map(() => [])
    for (let r = 0; r < ROUNDS; r++) {
        // 臂序按 r 轮转起跑，抵消顺序性偏置（温度/调度漂移）——与我方侧同构
        for (let k = 0; k < arms.length; k++) {
            const i = (r + k) % arms.length
            times[i].push(arms[i].fn(arms[i].n))
        }
    }
    // 每轮原始数据只 dump 前 3 轮（15 轮全打没意义，log 只留诊断线索）
    for (let r = 0; r < Math.min(ROUNDS, 3); r++) {
        step('  round ' + r + ': ' +
            arms.map((a, i) => a.label + '=' + times[i][r] + 'ms').join('  '))
    }
    const ns = (i, ms) => (ms * 1e6 / arms[i].n).toFixed(1)
    // median 是主指标（离群稳健）；min 留作参照
    const meds = times.map(med)
    const mins = times.map((t) => Math.min(...t))
    step('  ** median: ' + arms.map((a, i) => a.label + '=' + ns(i, meds[i]) + 'ns').join(' | '))
    step('     min:    ' + arms.map((a, i) => a.label + '=' + ns(i, mins[i]) + 'ns').join(' | '))
}

step('bench_nodeffi (node:ffi): per-arm calib ~' + TARGET_MS + 'ms, ' + ROUNDS +
    'r (median 主指标), 对照 bench_ffi_overhead.ts')
suite('S0 nop0  0参 void 纯往返', [mkArm('node', runNop0)])
suite('S1 nop1  1×i32 封送往返', [mkArm('node', runNop1)])
suite('S2 GetCurrentProcessId  0参真实API', [mkArm('node', runPid)])
suite('S3 SendMessageW WM_NULL 自有窗口', [mkArm('node', runSm)])

u32.DestroyWindow(hwnd)
step('DONE')
fs.closeSync(logFd)
