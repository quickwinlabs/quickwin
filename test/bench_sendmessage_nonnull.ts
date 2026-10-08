// 一次性性能 bench：FFI 签名 '!' 标注的调用时 0 检验成本（同函数多臂对照 + A/A 噪声底）
// 不入 CI。用法：make js 后 POST /exec {"cmd":"qwin.exe test/bench_sendmessage_nonnull.js"}
// 臂（同一 proc 各自 bind，唯一变量是 '!'）：
//   A1 base '<HWND>ptr u32 <>ptr <>ptr -> <>ptr'      基线
//   A2 ctrl '<HWND>ptr u32 <>ptr <>ptr -> <>ptr'      与 A1 完全同签名——两臂差值 = 机器噪声底
//   B arg!  '<HWND>ptr! u32 <>ptr <>ptr -> <>ptr'     + 参数位 arg#1 0 检查
//   C ret!  '<HWND>ptr! u32 <>ptr <>ptr -> <>ptr!'    + 返回位 0 检查（仅非零返回场景）
// 方法学（前两轮教训）：批量缩到 50k/样本 → 臂序每 ~650ms 轮转一次，抵消 QEMU 调度抖动；
// S1/S3 各臂 30 样本取 median（对 GC/调度离群稳健）；A2-A1 是效应检验的参照带——
// B/A 落在 A2/A 带内即「低于噪声底，不可测」。'!' 边际 = 每标注位 1 次整数 === 比较
// （endsWith 无条件跑、所有臂共模），理论 ≪ 轮噪声。
// C 臂标了返回 '!'，撞真实 0 即 throw —— 先用 A1 探各场景原始返回值，非零才让 C 进。
// 全部消息发自有窗口（直调 wndproc）。结束必须 DestroyWindow + std.exit。
import * as std from 'std'
import * as gui from 'gui'
import { bind, WCHAR } from '../lib/ffi/bind.js'
import { PtrArrayBuffer } from '../lib/ffi/ctype.js'

const BATCH = 50_000      // 每样本批量（~650ms）——小批量快轮转，去相关调度抖动
const ROUNDS = 30         // S1/S3 每臂样本数（30 × 3-4 臂 ≈ 60-80s/suite）
const N_S2 = 50_000
const ROUNDS_S2 = 7
const WM_NULL = 0x0000
const WM_SETTEXT = 0x000c
const WM_GETTEXT = 0x000d

// median（离群稳健）供 micro 与 suite 共用
const med = (t: number[]): number => {
    const s = [...t].sort((x, y) => x - y)
    const m = s.length >> 1
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

// S0：'!' 边际操作本身（1 次整数 === 比较 + 分支）的解释器成本——FFI 层噪声
// ±400~900ns/call 盖住了 12.5μs 调用上的 ns 级效应，这里绕开 ffiCall 直接量单检查。
// flag 必须是模块级可变量：QuickJS 编译期会常量折叠字面量，折叠掉就测不到了。
let microFlag = true
const MICRO_N = 100_000_000
function microLoop(): number {
    const t0 = Date.now()
    let hits = 0
    for (let i = 0; i < MICRO_N; i++)
        if (microFlag && i === 0) hits++
    const dt = Date.now() - t0
    if (hits !== (microFlag ? 1 : 0)) throw new Error('micro sanity failed: hits=' + hits)
    return dt
}
function microSuite(): void {
    step('suite: S0 micro 0-check interpreter cost (n=' + String(MICRO_N) + ')')
    microFlag = true; microLoop()
    microFlag = false; microLoop()
    const ts: number[] = []
    const fs: number[] = []
    for (let r = 0; r < 5; r++) {
        // 奇偶交叉起跑顺序（同原 bench 方法）
        if (r % 2 === 0) {
            microFlag = true; ts.push(microLoop())
            microFlag = false; fs.push(microLoop())
        } else {
            microFlag = false; fs.push(microLoop())
            microFlag = true; ts.push(microLoop())
        }
        step('  round ' + String(r) + ': check=' + String(ts[ts.length - 1]) +
            'ms base=' + String(fs[fs.length - 1]) + 'ms')
    }
    const ns = (ms: number) => (ms * 1e6 / MICRO_N).toFixed(2)
    const tmed = med(ts), fmed = med(fs)
    step('  ** median: check=' + ns(tmed) + 'ns/op base=' + ns(fmed) +
        'ns/op  ==> per-check cost=' + ((tmed - fmed) * 1e6 / MICRO_N).toFixed(2) + 'ns')
}

// 文件日志（cwd=Z:\quickwin，宿主机 _build/bench_nonnull_log.txt 可实时读）——exec 只在
// 进程退出后回包，挂了靠它定位卡点
const log = std.open('bench_nonnull_log.txt', 'w')
function step(msg: string): void {
    std.printf('%s\n', msg)
    if (log) { log.puts(msg + '\n'); log.flush() }
}

step('stage: imports ok')

const winRaw = gui.CreateWindow('STATIC', 'bench-title', 0, 0, 0, 20, 20, null, null)
if (!winRaw) throw new Error('CreateWindow(STATIC) failed')
const win: gui.HWND = winRaw
step('stage: window created')

const SIG = '<HWND>ptr u32 <>ptr <>ptr -> <>ptr'
const fA1 = bind('user32.dll', 'SendMessageW', SIG)
const fA2 = bind('user32.dll', 'SendMessageW', SIG)   // A/A 对照：同签名二绑 = 噪声底
const fB = bind('user32.dll', 'SendMessageW', '<HWND>ptr! u32 <>ptr <>ptr -> <>ptr')
const fC = bind('user32.dll', 'SendMessageW', '<HWND>ptr! u32 <>ptr <>ptr -> <>ptr!')

// 各 BindFn 结构等价 → 收敛到一个可传参的函数型（循环内统一走局部参数，开销对齐）
type SM = (h: gui.HWND, msg: number, w: number, l: number) => number

const TEXT = 'bench'
const buf = new PtrArrayBuffer<'WCHAR'>(64)

// C 臂可行性探针：A1 读各场景原始返回值，撞 0 的场景不进 C（'!' 会 throw）。
// S1 的 WM_NULL 走 DefWindowProc 预期返 0 → C 不进 S1 是预期而非缺测。
const retS1 = fA1(win, WM_NULL, 0, 0x1234)
const retS2 = fA1(win, WM_SETTEXT, 0, WCHAR.encode(TEXT).ptr)
const retS3 = fA1(win, WM_GETTEXT, 64, buf.ptr)
step('probe ret: S1=' + String(retS1) + ' S2=' + String(retS2) + ' S3=' + String(retS3) +
    '  (C arm only enters nonzero scenes)')

function run1(f: SM): number {
    const t0 = Date.now()
    for (let i = 0; i < BATCH; i++) f(win, WM_NULL, 0, 0x1234)
    return Date.now() - t0
}
function run2(f: SM): number {
    const t0 = Date.now()
    for (let i = 0; i < N_S2; i++) {
        const w = WCHAR.encode(TEXT)
        f(win, WM_SETTEXT, 0, w.ptr)
    }
    return Date.now() - t0
}
function run3(f: SM): number {
    const t0 = Date.now()
    for (let i = 0; i < BATCH; i++) f(win, WM_GETTEXT, 64, buf.ptr)
    return Date.now() - t0
}

type Arm = { label: string; fn: () => number }

function suite(name: string, n: number, rounds: number, arms: Arm[]): void {
    step('suite: ' + name + ' warmup')
    for (const a of arms) a.fn()   // 预热各 1 轮
    const times: number[][] = arms.map(() => [])
    for (let r = 0; r < rounds; r++) {
        // 臂序按 r 轮转起跑，抵消顺序性偏置（温度/调度漂移）
        for (let k = 0; k < arms.length; k++) {
            const i = (r + k) % arms.length
            times[i]!.push(arms[i]!.fn())
        }
    }
    // 每轮原始数据只 dump 前 3 轮（30 轮全打没意义，log 只留诊断线索）
    for (let r = 0; r < Math.min(rounds, 3); r++) {
        step('  round ' + String(r) + ': ' +
            arms.map((a, i) => a.label + '=' + String(times[i]![r]) + 'ms').join('  '))
    }
    const ns = (ms: number) => (ms * 1e6 / n).toFixed(1)
    // median 是主指标（离群稳健）；min 留作与前两轮/原 bench 的可比项
    const meds = times.map(med)
    const mins = times.map(t => Math.min(...t))
    step('  ** median: ' + arms.map((a, i) =>
        a.label + '=' + ns(meds[i]!) + 'ns').join(' | '))
    step('     min:    ' + arms.map((a, i) =>
        a.label + '=' + ns(mins[i]!) + 'ns').join(' | '))
    for (let i = 1; i < arms.length; i++)
        step('      vs A1: ' + arms[i]!.label + ' delta=' +
            ((meds[i]! - meds[0]!) * 1e6 / n).toFixed(1) + 'ns/call (median), ' +
            ((mins[i]! - mins[0]!) * 1e6 / n).toFixed(1) + 'ns/call (min)' +
            (i === 1 ? '   <-- A2-A1 = NOISE FLOOR' : ''))
}

const s1Arms: Arm[] = [
    { label: 'A1', fn: () => run1(fA1) },
    { label: 'A2', fn: () => run1(fA2) },
    { label: 'B ', fn: () => run1(fB) },
]
if (retS1 !== 0) s1Arms.push({ label: 'C ', fn: () => run1(fC) })
const s2Arms: Arm[] = [
    { label: 'A1', fn: () => run2(fA1) },
    { label: 'A2', fn: () => run2(fA2) },
    { label: 'B ', fn: () => run2(fB) },
]
if (retS2 !== 0) s2Arms.push({ label: 'C ', fn: () => run2(fC) })
const s3Arms: Arm[] = [
    { label: 'A1', fn: () => run3(fA1) },
    { label: 'A2', fn: () => run3(fA2) },
    { label: 'B ', fn: () => run3(fB) },
]
if (retS3 !== 0) s3Arms.push({ label: 'C ', fn: () => run3(fC) })

step('bench_sendmessage_nonnull: S1/S3 batch=' + String(BATCH) + '×' + String(ROUNDS) +
    'r, S2 n=' + String(N_S2) + '×' + String(ROUNDS_S2) + 'r (median 主指标)')
microSuite()
suite('S1 WM_NULL  纯数字参数 (最灵敏测点)', BATCH, ROUNDS, s1Arms)
suite('S2 WM_SETTEXT  字符串 lParam (FFI 侧含 WCHAR.encode)', N_S2, ROUNDS_S2, s2Arms)
suite('S3 WM_GETTEXT  缓冲出参往返', BATCH, ROUNDS, s3Arms)

gui.DestroyWindow(win)
step('DONE')
if (log) log.close()
std.exit(0)
