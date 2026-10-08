// 一次性性能 bench：我方 bind() FFI vs node:ffi(Node v26.10) 同机同场景对比（win11 VM）
// 不入 CI。对照脚本 test/bench_nodeffi.mjs（node 侧同场景）。结论见对话，未落文档。
// 用法：make js 后 POST /exec {"cmd":"qwin.exe test/bench_ffi_overhead.js"}
// 场景（跨运行时按 ns/call 归一，每臂独立自校准到 ~400ms/样本）：
//   S0 nop0  test/nop.dll 0 参 void —— 纯 JS→C 往返 trampoline（无封送无返回读取）
//   S1 nop1  test/nop.dll 1×i32 —— 单标量封送往返
//   S2 pid   kernel32 GetCurrentProcessId 0 参 —— 真实系统 DLL
//   S3 sm    user32 SendMessageW WM_NULL 自有窗口 —— 完整链路 + gui C 直调地板参照
// 方法学沿用 bench_sendmessage_nonnull：预热 1 + 臂序轮转 + median 主指标/min。
// Date.now() 1ms 量化 → 批量自校准（探针 ≥20ms 才有 ≤5% 步长，目标 ~400ms/样本）。
// 全部消息发自有窗口（直调 wndproc）。结束必须 DestroyWindow + std.exit。
import * as std from 'std'
import * as gui from 'gui'
import { bind } from '../lib/ffi/bind.js'

const WM_NULL = 0x0000
const ROUNDS = 15
const TARGET_MS = 400

// median（离群稳健）供 calibrate 与 suite 共用
const med = (t: number[]): number => {
    const s = [...t].sort((x, y) => x - y)
    const m = s.length >> 1
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

// 文件日志（cwd=Z:\quickwin，宿主机 _build/bench_ffi_overhead_log.txt 可实时读）——
// exec 只在进程退出后回包，挂了靠它定位卡点
const log = std.open('bench_ffi_overhead_log.txt', 'w')
function step(msg: string): void {
    std.printf('%s\n', msg)
    if (log) { log.puts(msg + '\n'); log.flush() }
}

step('stage: imports ok')

const winRaw = gui.CreateWindow('STATIC', 'bench-title', 0, 0, 0, 20, 20, null, null)
if (!winRaw) throw new Error('CreateWindow(STATIC) failed')
const win: gui.HWND = winRaw
step('stage: window created')

const fNop0 = bind('test/nop.dll', 'nop0', ' -> void')
const fNop1 = bind('test/nop.dll', 'nop1', 'i32 -> i32')
const fPid = bind('kernel32.dll', 'GetCurrentProcessId', ' -> u32')
const fSm = bind('user32.dll', 'SendMessageW', '<HWND>ptr u32 <>ptr <>ptr -> <>ptr')

// 每臂循环体：函数先取到局部 const（与 node 侧同形态——模块槽访问 vs 局部槽访问的
// 每迭代差在 ns 级，两边都取局部才对齐）；调用结果不使用（QuickJS 解释器不消除
// 副作用调用，与原 bench 同口径）
const runNop0 = (n: number): number => {
    const f = fNop0
    const t0 = Date.now()
    for (let i = 0; i < n; i++) f()
    return Date.now() - t0
}
const runNop1 = (n: number): number => {
    const f = fNop1
    const t0 = Date.now()
    for (let i = 0; i < n; i++) f(1)
    return Date.now() - t0
}
const runPid = (n: number): number => {
    const f = fPid
    const t0 = Date.now()
    for (let i = 0; i < n; i++) f()
    return Date.now() - t0
}
const runSm = (n: number): number => {
    const f = fSm
    const t0 = Date.now()
    for (let i = 0; i < n; i++) f(win, WM_NULL, 0, 0x1234)
    return Date.now() - t0
}
const runGuiSm = (n: number): number => {
    const f = gui.SendMessage
    const t0 = Date.now()
    for (let i = 0; i < n; i++) f(win, WM_NULL, 0, 0x1234)
    return Date.now() - t0
}

type Arm = { label: string; n: number; fn: (n: number) => number }

// 自校准：探针逐级放大 n0 直到 dt≥20ms（量化步长 1ms ≤ 5%），再按 TARGET_MS 定批量。
// 不预设单次调用量级——我方与 gui 地板相差 100×，固定批量必有一侧撞量化墙。
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

function mkArm(label: string, fn: (n: number) => number): Arm {
    return { label, n: calibrate(label, fn), fn }
}

function suite(name: string, arms: Arm[]): void {
    step('suite: ' + name + ' warmup')
    for (const a of arms) a.fn(a.n)   // 预热各 1 轮
    const times: number[][] = arms.map(() => [])
    for (let r = 0; r < ROUNDS; r++) {
        // 臂序按 r 轮转起跑，抵消顺序性偏置（温度/调度漂移）
        for (let k = 0; k < arms.length; k++) {
            const i = (r + k) % arms.length
            times[i]!.push(arms[i]!.fn(arms[i]!.n))
        }
    }
    // 每轮原始数据只 dump 前 3 轮（15 轮全打没意义，log 只留诊断线索）
    for (let r = 0; r < Math.min(ROUNDS, 3); r++) {
        step('  round ' + String(r) + ': ' +
            arms.map((a, i) => a.label + '=' + String(times[i]![r]) + 'ms').join('  '))
    }
    const ns = (i: number, ms: number) => (ms * 1e6 / arms[i]!.n).toFixed(1)
    // median 是主指标（离群稳健）；min 留作参照
    const meds = times.map(med)
    const mins = times.map(t => Math.min(...t))
    step('  ** median: ' + arms.map((a, i) => a.label + '=' + ns(i, meds[i]!) + 'ns').join(' | '))
    step('     min:    ' + arms.map((a, i) => a.label + '=' + ns(i, mins[i]!) + 'ns').join(' | '))
}

step('bench_ffi_overhead (ours): per-arm calib ~' + String(TARGET_MS) + 'ms, ' +
    String(ROUNDS) + 'r (median 主指标), 对照 test/bench_nodeffi.mjs')
suite('S0 nop0  0参 void 纯往返', [mkArm('ours', runNop0)])
suite('S1 nop1  1×i32 封送往返', [mkArm('ours', runNop1)])
suite('S2 GetCurrentProcessId  0参真实API', [mkArm('ours', runPid)])
suite('S3 SendMessageW WM_NULL 自有窗口 (gui=直调地板)', [
    mkArm('ours', runSm),
    mkArm('gui ', runGuiSm),
])

gui.DestroyWindow(win)
step('DONE')
if (log) log.close()
std.exit(0)
