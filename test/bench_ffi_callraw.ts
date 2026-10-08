// 一次性性能 bench（归因场）：绕过 callPacked 直调 ffi.ffiCall，把 bind() 调用链拆层。
// 不入 CI。A 臂 = bind() 同场对照（对齐 bench_ffi_overhead.ts 的 S0-S3 量级）。
// 用法：make js 后 win11 POST /exec {"cmd":"qwin.exe test\\bench_ffi_callraw.js","timeout":600000}
// 臂（同 proc、同帧布局，唯一变量是「每次调用经过哪些层」）：
//   A bind      rest 参数 + callPacked 全链（每调 argFrame/DataView/retBuf/readRet-dv
//               分配、getWidth 闭包、writeSlot 对象字面量、ffiCall、readRet）
//   B raw       帧复用 + 每调最小写槽/读返 + ffiCall → native 桩 + QuickJS C 边界
//   C raw-alloc 每调 new ArrayBuffer(32)+DataView+ArrayBuffer(8)+读返 DataView
//               （复刻 callPacked 分配面）+ 写槽 + ffiCall（仅 S0/S1）
// 差值解读：B = trampoline 地板；C−B = 每调分配；A−C = callPacked JS 层其余。
// x64 帧约定：argFrame 恒 32B（4×8 槽，桩无条件读 4 槽），retBuf 8B（ffiCall ≥8 校验）。
// S1/S2/S3 各臂消费返回值到 sink（A/B/C 同口径，防 DCE 疑虑 + 收尾打印证活）。
// 结束必须 DestroyWindow + std.exit。
import * as std from 'std'
import * as gui from 'gui'
import * as win from 'win'
import * as ffi from 'ffi'
import { bind } from '../lib/ffi/bind.js'

const WM_NULL = 0x0000
const FRAME_BYTES = 32   // x64：4 槽 × 8B，桩无条件读 slots[0..3]
const ROUNDS = 15
const TARGET_MS = 400

const med = (t: number[]): number => {
    const s = [...t].sort((x, y) => x - y)
    const m = s.length >> 1
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

// 文件日志（cwd=Z:\quickwin → 宿主 _build/bench_ffi_callraw_log.txt）
const log = std.open('bench_ffi_callraw_log.txt', 'w')
function step(msg: string): void {
    std.printf('%s\n', msg)
    if (log) { log.puts(msg + '\n'); log.flush() }
}

step('stage: imports ok')

// ---- proc 地址（B/C 臂绕过 bind 直驱 ffiCall）----
function procOf(dll: string, name: string): number {
    const h = win.LoadLibrary(dll)
    if (!h) throw new Error('LoadLibrary(' + dll + ') failed')
    const p = win.GetProcAddress(h, name)
    if (p === null) throw new Error('GetProcAddress(' + dll + '!' + name + ') failed')
    return p
}
const pNop0 = procOf('test/nop.dll', 'nop0')
const pNop1 = procOf('test/nop.dll', 'nop1')
const pPid = procOf('kernel32.dll', 'GetCurrentProcessId')
const pSm = procOf('user32.dll', 'SendMessageW')

// B 臂复用帧 + 视图（一次分配，跨轮复用）
const frame = new ArrayBuffer(FRAME_BYTES)
const retBuf = new ArrayBuffer(8)
const fv = new DataView(frame)
const rv = new DataView(retBuf)
let sink = 0

const fNop0 = bind('test/nop.dll', 'nop0', ' -> void')
const fNop1 = bind('test/nop.dll', 'nop1', 'i32 -> i32')
const fPid = bind('kernel32.dll', 'GetCurrentProcessId', ' -> u32')

const winRaw = gui.CreateWindow('STATIC', 'bench-title', 0, 0, 0, 20, 20, null, null)
if (!winRaw) throw new Error('CreateWindow(STATIC) failed')
const hwnd: gui.HWND = winRaw
const fSm = bind('user32.dll', 'SendMessageW', '<HWND>ptr u32 <>ptr <>ptr -> <>ptr')
step('stage: window created')

// ---- 可行性探针：任一臂签名/帧布局错位立刻炸 ----
fNop0()
if (fNop1(1) !== 2) throw new Error('sanity: bind nop1(1) !== 2')
if (fPid() <= 0) throw new Error('sanity: bind pid <= 0')
ffi.ffiCall(pNop0, frame, retBuf, 0)
fv.setInt32(0, 1, true)
ffi.ffiCall(pNop1, frame, retBuf, 0)
if (rv.getInt32(0, true) !== 2) throw new Error('sanity: raw nop1 !== 2, got ' + rv.getInt32(0, true))
ffi.ffiCall(pPid, frame, retBuf, 0)
if (rv.getUint32(0, true) <= 0) throw new Error('sanity: raw pid <= 0')
// S3 帧布局预演（hwnd 槽 + msg + wParam + lParam）
fv.setBigUint64(0, BigInt(Number(hwnd)), true)
fv.setUint32(8, WM_NULL, true)
fv.setBigUint64(16, 0n, true)
fv.setBigUint64(24, 0x1234n, true)
ffi.ffiCall(pSm, frame, retBuf, 0)
const smRet = rv.getBigUint64(0, true)
step('stage: probes ok, raw SendMessage ret=' + String(smRet) + ' (expect 0n)')

// ---- 臂循环：函数取到局部 const，两侧/各臂同形态 ----
const runA0 = (n: number): number => {
    const f = fNop0
    const t0 = Date.now()
    for (let i = 0; i < n; i++) f()
    return Date.now() - t0
}
const runB0 = (n: number): number => {
    const p = pNop0, fr = frame, rb = retBuf
    const t0 = Date.now()
    for (let i = 0; i < n; i++) ffi.ffiCall(p, fr, rb, 0)
    return Date.now() - t0
}
const runC0 = (n: number): number => {
    const p = pNop0
    const t0 = Date.now()
    for (let i = 0; i < n; i++) {
        const f = new ArrayBuffer(FRAME_BYTES)
        const d = new DataView(f)   // callPacked 无条件建 dv，照抄
        void d
        ffi.ffiCall(p, f, new ArrayBuffer(8), 0)
    }
    return Date.now() - t0
}
const runA1 = (n: number): number => {
    const f = fNop1
    const t0 = Date.now()
    for (let i = 0; i < n; i++) sink += f(1)
    return Date.now() - t0
}
const runB1 = (n: number): number => {
    const p = pNop1, fr = frame, rb = retBuf, d = fv, rd = rv
    const t0 = Date.now()
    for (let i = 0; i < n; i++) {
        d.setInt32(0, 1, true)
        ffi.ffiCall(p, fr, rb, 0)
        sink += rd.getInt32(0, true)
    }
    return Date.now() - t0
}
const runC1 = (n: number): number => {
    const p = pNop1
    const t0 = Date.now()
    for (let i = 0; i < n; i++) {
        const f = new ArrayBuffer(FRAME_BYTES)
        const d = new DataView(f)
        d.setInt32(0, 1, true)
        const r = new ArrayBuffer(8)
        ffi.ffiCall(p, f, r, 0)
        sink += new DataView(r).getInt32(0, true)   // readRet 同构：每次 new DataView
    }
    return Date.now() - t0
}
const runA2 = (n: number): number => {
    const f = fPid
    const t0 = Date.now()
    for (let i = 0; i < n; i++) sink += f()
    return Date.now() - t0
}
const runB2 = (n: number): number => {
    const p = pPid, fr = frame, rb = retBuf, rd = rv
    const t0 = Date.now()
    for (let i = 0; i < n; i++) {
        ffi.ffiCall(p, fr, rb, 0)
        sink += rd.getUint32(0, true)
    }
    return Date.now() - t0
}
const runA3 = (n: number): number => {
    const f = fSm
    const t0 = Date.now()
    for (let i = 0; i < n; i++) sink += f(hwnd, WM_NULL, 0, 0x1234)
    return Date.now() - t0
}
const runB3 = (n: number): number => {
    const p = pSm, fr = frame, rb = retBuf, d = fv, rd = rv
    const t0 = Date.now()
    for (let i = 0; i < n; i++) {
        d.setBigUint64(0, BigInt(Number(hwnd)), true)
        d.setUint32(8, WM_NULL, true)
        d.setBigUint64(16, 0n, true)
        d.setBigUint64(24, 0x1234n, true)
        ffi.ffiCall(p, fr, rb, 0)
        sink += Number(rd.getBigUint64(0, true))
    }
    return Date.now() - t0
}

type Arm = { label: string; n: number; fn: (n: number) => number }

// 自校准：探针逐级放大 n0 至 dt≥20ms（1ms 量化步长 ≤5%），按 TARGET_MS 定批量。
// B 臂可能比 A 快两个量级，固定批量必有一侧撞量化墙——与 overhead 场同法。
function calibrate(label: string, fn: (n: number) => number): number {
    let n0 = 10_000
    let dt = 0
    for (;;) {
        dt = fn(n0)
        if (dt >= 20 || n0 >= 10_000_000) break
        n0 *= 10
    }
    const per = dt / n0
    const n = Math.max(10_000, Math.min(10_000_000, Math.round(TARGET_MS / per)))
    step('  calib ' + label + ': probe n=' + String(n0) + ' dt=' + String(dt) +
        'ms → batch=' + String(n))
    return n
}

const mkArm = (label: string, fn: (n: number) => number): Arm =>
    ({ label, n: calibrate(label, fn), fn })

function suite(name: string, arms: Arm[]): void {
    step('suite: ' + name + ' warmup')
    for (const a of arms) a.fn(a.n)
    const times: number[][] = arms.map(() => [])
    for (let r = 0; r < ROUNDS; r++) {
        for (let k = 0; k < arms.length; k++) {
            const i = (r + k) % arms.length
            times[i]!.push(arms[i]!.fn(arms[i]!.n))
        }
    }
    for (let r = 0; r < Math.min(ROUNDS, 3); r++) {
        step('  round ' + String(r) + ': ' +
            arms.map((a, i) => a.label + '=' + String(times[i]![r]) + 'ms').join('  '))
    }
    const ns = (i: number, ms: number) => (ms * 1e6 / arms[i]!.n).toFixed(1)
    const meds = times.map(med)
    const mins = times.map(t => Math.min(...t))
    step('  ** median: ' + arms.map((a, i) => a.label + '=' + ns(i, meds[i]!) + 'ns').join(' | '))
    step('     min:    ' + arms.map((a, i) => a.label + '=' + ns(i, mins[i]!) + 'ns').join(' | '))
    if (arms.length >= 3) {
        const a = Number(ns(0, meds[0]!)), b = Number(ns(1, meds[1]!)), c = Number(ns(2, meds[2]!))
        step('      split:  C-B=' + (c - b).toFixed(1) + 'ns (每调分配)  A-C=' +
            (a - c).toFixed(1) + 'ns (callPacked JS 层其余)')
    }
}

step('bench_ffi_callraw (attribution): A=bind / B=raw ffiCall / C=raw+per-call alloc; ' +
    'calib ~' + String(TARGET_MS) + 'ms, ' + String(ROUNDS) + 'r (median)')
suite('S0 nop0  0参 void', [mkArm('A bind', runA0), mkArm('B raw ', runB0), mkArm('C allc', runC0)])
suite('S1 nop1  1×i32', [mkArm('A bind', runA1), mkArm('B raw ', runB1), mkArm('C allc', runC1)])
suite('S2 GetCurrentProcessId', [mkArm('A bind', runA2), mkArm('B raw ', runB2)])
suite('S3 SendMessageW WM_NULL', [mkArm('A bind', runA3), mkArm('B raw ', runB3)])

step('sink=' + String(sink) + ' (liveness: >0 证明各臂 native 调用真实发生)')
gui.DestroyWindow(hwnd)
step('DONE')
if (log) log.close()
std.exit(0)
