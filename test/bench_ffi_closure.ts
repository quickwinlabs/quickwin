// 一次性性能 bench（closure 归因场）：闭包回调（native → JS）每次派发的成本。
// 不入 CI。每套两个臂，**同一个 helper**（test/nop.c 的 call_*_ntimes）分别以
//   floor = C 函数指针（nop0/nop1/four/dadd）—— 纯「native 经指针回调 native」地板
//   clos  = closure().ptr —— 地板 + trampoline + C 内层 + JS_Call(wrapper) + JS 派发
// 同一 helper ⇒ 循环、间接调用、外层 ffiCall 全为共模，差值即「闭包一次派发」。
// 用法：make js 后 POST /exec {"cmd":"qwin.exe test\\bench_ffi_closure.js","timeout":600000}
//   ia32 换 qwin-x86.exe；helper 是默认 cdecl，故 ia32 下闭包按 { stdcall: false } 创建。
// 方法学沿 bench_ffi_overhead：每臂自校准到 ~400ms/样本、预热 1、15 轮臂序轮转、median 主指标。
import * as std from 'std'
import * as os from 'os'
import * as ffi from 'ffi'
import { bind, closure } from '../lib/ffi/bind.js'

const ROUNDS = 15
const TARGET_MS = 400

// median（离群稳健）供 calibrate 与 suite 共用
const med = (t: number[]): number => {
    const s = [...t].sort((x, y) => x - y)
    const m = s.length >> 1
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

// 文件日志（cwd=Z:\quickwin，宿主 _build/bench_ffi_closure_log.txt 可实时读）
const log = std.open('bench_ffi_closure_log.txt', 'w')
function step(msg: string): void {
    std.printf('%s\n', msg)
    if (log) { log.puts(msg + '\n'); log.flush() }
}

step('stage: imports ok')

// x64 恒由调用方清栈；ia32 下 helper 是 cdecl，闭包必须同样按 cdecl 建（否则栈失衡）
const CS = os.arch === 'x64' ? undefined : { stdcall: false }

function procOf(dll: string, name: string): number {
    const h = ffi.LoadLibrary(dll)
    if (!h) throw new Error('LoadLibrary(' + dll + ') failed')
    const p = ffi.GetProcAddress(h, name)
    if (!p) throw new Error('GetProcAddress(' + dll + '!' + name + ') failed')
    return p
}

// 地板臂目标：与闭包同签名的 C 函数（纯 native 经指针回调）
const fNop0 = procOf('test/nop.dll', 'nop0')
const fNop1 = procOf('test/nop.dll', 'nop1')
const fFour = procOf('test/nop.dll', 'four')
const fDadd = procOf('test/nop.dll', 'dadd')

// helper：一次 JS→C 里回调 n 次（n 由自校准定，单样本一次调用）
const callVoid = bind('test/nop.dll', 'call_void_ntimes', '<>ptr i32 -> i32')
const callI32 = bind('test/nop.dll', 'call_i32_ntimes', '<>ptr i32 -> i32')
const callI32x4 = bind('test/nop.dll', 'call_i32x4_ntimes', '<>ptr i32 -> i32')
const callF64 = bind('test/nop.dll', 'call_f64_ntimes', '<>ptr i32 -> f64')

// 闭包臂
let nVoid = 0
const closVoid = closure(' -> void', () => { nVoid++ }, CS)
const closI32 = closure('i32 -> i32', x => x + 1, CS)
const closI32x4 = closure('i32 i32 i32 i32 -> i32', (a, b, c, d) => a + b + c + d, CS)
const closF64 = closure('f64 -> f64', x => x + 1, CS)

// 正确性先钉死（批量自校准不会发现「回调没跑」）
const c1 = callI32(closI32.ptr, 4)
const c2 = callI32x4(closI32x4.ptr, 4)
const c3 = callF64(closF64.ptr, 4)
const c4 = callVoid(closVoid.ptr, 5)
step('check: i32=' + String(c1) + ' (expect 10)  i32x4=' + String(c2) + ' (expect 48)  ' +
    'f64=' + String(c3) + ' (expect 10)  void n=' + String(c4) + '/calls=' + String(nVoid) + ' (expect 5/5)')
if (c1 !== 10 || c2 !== 48 || c3 !== 10 || c4 !== 5 || nVoid !== 5)
    throw new Error('closure bench self-check failed')
step('stage: closures ok')

let sink = 0

type Arm = { label: string; n: number; fn: (n: number) => number }

// 自校准：探针逐级放大 n 直到 dt≥20ms（量化步长 1ms ≤ 5%），再按 TARGET_MS 定批量。
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
        for (let k = 0; k < arms.length; k++) {
            const a = arms[k]!
            times[k]!.push(a.fn(a.n))    // fn 内部计时，返回 ms
        }
    }
    for (let r = 0; r < Math.min(ROUNDS, 3); r++) {
        step('  round ' + String(r) + ': ' +
            arms.map((a, i) => a.label + '=' + String(times[i]![r]) + 'ms').join('  '))
    }
    const per = (i: number, ms: number) => ms * 1e6 / arms[i]!.n   // ms/样本 → ns/次回调
    const ns = (i: number, ms: number) => per(i, ms).toFixed(1)
    const meds = times.map(med)
    const mins = times.map(t => Math.min(...t))
    step('  ** median: ' + arms.map((a, i) => a.label + '=' + ns(i, meds[i]!) + 'ns').join(' | '))
    step('     min:    ' + arms.map((a, i) => a.label + '=' + ns(i, mins[i]!) + 'ns').join(' | '))
    const d = per(1, meds[1]!) - per(0, meds[0]!)
    step('     闭包成本(median clos−floor): +' + d.toFixed(1) + 'ns/cb (' +
        (100 * d / per(1, meds[1]!)).toFixed(0) + '% of clos)')
}

// 每臂：单次 helper 调用内回调 n 次；fn 自己计时并返回 ms（calibrate/suite 同口径）
const mkRun = (helper: (p: number, n: number) => number, p: number) =>
    (n: number): number => {
        const t = Date.now()
        sink += Number(helper(p, n))
        return Date.now() - t
    }

step('bench_ffi_closure: per-arm calib ~' + String(TARGET_MS) + 'ms, ' + String(ROUNDS) +
    'r (median 主指标), 每套 floor=同 helper 的 C 函数 vs clos=closure().ptr')
suite('S0 void  cb()', [mkArm('floor', mkRun(callVoid, fNop0)), mkArm('clos ', mkRun(callVoid, closVoid.ptr))])
suite('S1 i32   cb(i)', [mkArm('floor', mkRun(callI32, fNop1)), mkArm('clos ', mkRun(callI32, closI32.ptr))])
suite('S2 i32x4 cb(i,i+1,i+2,i+3)', [
    mkArm('floor', mkRun(callI32x4, fFour)),
    mkArm('clos ', mkRun(callI32x4, closI32x4.ptr)),
])
suite('S3 f64   cb((double)i)', [mkArm('floor', mkRun(callF64, fDadd)), mkArm('clos ', mkRun(callF64, closF64.ptr))])

step('sink=' + String(sink) + ' (防 DCE + 证活)')
closVoid.dispose()
closI32.dispose()
closI32x4.dispose()
closF64.dispose()
step('DONE')
if (log) log.close()
std.exit(0)
