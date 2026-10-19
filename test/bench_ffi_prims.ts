// 一次性性能 bench：QuickJS 侧原语成本表 —— 归因 bind() 每次调用的 JS 开销。
// 不入 CI。方法学同 bench_ffi_overhead（每臂自校准 ~400ms/样本、预热 1、15 轮、median 主指标）。
// 用法：make js 后 POST /exec {"cmd":"qwin.exe test/bench_ffi_prims.js","timeout":600000}
// 每臂 = 局部闭包 per() 调用 + 被测原语；`noop` 臂为闭包调用地板，各臂减去它才是原语净成本。
// 目的：把 ~19μs/call 拆成「分配 / 正则 / 字符串 / 槽写 / 属性读」各自贡献多少。
import * as std from 'std'
import * as os from 'os'
import { isCPtrToken, isCValToken, normToken, ptrName, readScalar, writeSlot } from '../lib/ffi/ctype.js'

const ROUNDS = 15
const TARGET_MS = 400

const med = (t: number[]): number => {
    const s = [...t].sort((x, y) => x - y)
    const m = s.length >> 1
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

const log = std.open('bench_ffi_prims_log.txt', 'w')
function step(msg: string): void {
    std.printf('%s\n', msg)
    if (log) { log.puts(msg + '\n'); log.flush() }
}

step('stage: imports ok arch=' + os.arch)

// 复用的帧/缓冲区（避免把「构造 buffer」混进被测原语）
const ab32 = new ArrayBuffer(32)
const dv = new DataView(ab32)
const rb8 = new ArrayBuffer(8)
const BI = BigInt(0x1234567890)
const PV = 12345

// 新版 callPlan 的两种槽写器 mock（x64 指针 = 两条 setUint32；u32 = 一条）。
// 用来量「切到 plan 写器后每槽还剩多少」，以及 BigInt 路径 vs 两段 32 位路径差多少。
const wPtrBi = (d: DataView, v: number): undefined => {
    d.setBigUint64(0, BigInt.asUintN(64, BigInt(v)), true); return undefined
}
const wPtr2x = (d: DataView, v: number): undefined => {
    d.setUint32(0, v >>> 0, true)
    d.setUint32(4, Math.floor(v / 4294967296), true)
    return undefined
}
const wI32 = (d: DataView, v: number): undefined => { d.setUint32(8, v >>> 0, true); return undefined }
const SW: ((d: DataView, v: number) => ArrayBuffer | undefined)[] = [wPtr2x, wI32, wPtr2x, wPtr2x]
const SW_H: ((d: DataView, v: number) => ArrayBuffer | undefined)[] =
    [(d, v) => { wPtr2x(d, v); return ab32 }, wI32, wPtr2x, wPtr2x]

let sink = 0
const PTR_TOK = '<HWND>ptr!'
const VAL_TOK = '<RECT>'
const NUM_TOK = 'i32'
const ENUM_TOK = 'u32@WmMsg'

type Arm = { label: string; per: () => void }
const arms: Arm[] = [
    { label: 'noop        ', per: () => { sink = 1 } },
    { label: 'js-call     ', per: () => { const f = g1; sink = f(1) } },
    { label: 'rest-call-4 ', per: () => { sink = g4(1, 2, 3, 4) } },
    { label: 'fix-call-4  ', per: () => { sink = h4(1, 2, 3, 4) } },
    { label: 'new-AB32    ', per: () => { sink = new ArrayBuffer(32).byteLength } },
    { label: 'new-AB8     ', per: () => { sink = new ArrayBuffer(8).byteLength } },
    { label: 'new-DV      ', per: () => { sink = new DataView(ab32).byteLength } },
    { label: 'new-DV+AB8  ', per: () => { sink = new DataView(new ArrayBuffer(8)).byteLength } },
    { label: 'isCPtr      ', per: () => { sink = isCPtrToken(PTR_TOK) ? 1 : 0 } },
    { label: 'isCVal      ', per: () => { sink = isCValToken(VAL_TOK) ? 1 : 0 } },
    { label: 'ptrName     ', per: () => { sink = (ptrName(PTR_TOK) as string).length } },
    { label: 'norm-ptr    ', per: () => { sink = normToken(PTR_TOK).length } },
    { label: 'norm-i32    ', per: () => { sink = normToken(NUM_TOK).length } },
    { label: 'norm-enum   ', per: () => { sink = normToken(ENUM_TOK).length } },
    { label: 'endsWith    ', per: () => { sink = PTR_TOK.endsWith('!') ? 1 : 0 } },
    { label: 'wSlot-ptr   ', per: () => { writeSlot(dv, 0, { k: 'ptr', v: 12345 }); sink = 1 } },
    { label: 'wSlot-i32   ', per: () => { writeSlot(dv, 0, { k: 'i32', v: 7 }); sink = 1 } },
    { label: 'wSlot-obj   ', per: () => { const e = { k: 'ptr', v: 12345 } as const; sink = e.v } },
    { label: 'readRet-ptr ', per: () => { sink = readScalar(new DataView(rb8), 0, 'ptr') as number } },
    { label: 'os-arch     ', per: () => { sink = os.arch === 'x64' ? 1 : 0 } },
    { label: 'arr-lit-4   ', per: () => { const a = [1, 2, 3, 4]; sink = a.length } },
    { label: 'arr-push-held', per: () => { const h: ArrayBuffer[] = []; h.push(ab32); sink = h.length } },
    // —— 新版残余 + 候选优化 ——
    { label: 'dv-u32      ', per: () => { dv.setUint32(0, 7, true); sink = 1 } },
    { label: 'dv-u32x2    ', per: () => { dv.setUint32(0, 7, true); dv.setUint32(4, 0, true); sink = 1 } },
    { label: 'bigint-mk   ', per: () => { sink = BigInt(PV) === BI ? 1 : 0 } },
    { label: 'bigint-asU  ', per: () => { sink = BigInt.asUintN(64, BI) === BI ? 1 : 0 } },
    { label: 'dv-u64-bi   ', per: () => { dv.setBigUint64(0, BI, true); sink = 1 } },
    { label: 'wPtr-old    ', per: () => { sink = wPtrBi(dv, PV) === undefined ? 1 : 0 } },
    { label: 'wPtr-2x32   ', per: () => { sink = wPtr2x(dv, PV) === undefined ? 1 : 0 } },
    { label: 'read-bi     ', per: () => { sink = Number(dv.getBigInt64(0, true)) === 1 ? 1 : 0 } },
    { label: 'read-2x32   ', per: () => { sink = dv.getUint32(0, true) + dv.getUint32(4, true) * 4294967296 === 1 ? 1 : 0 } },
    { label: 'slot-loop-4 ', per: () => { let h: ArrayBuffer | undefined; for (let i = 0; i < 4; i++) h = SW[i]!(dv, i + 1); sink = h === undefined ? 1 : 2 } },
    { label: 'slot-loop-h ', per: () => { let held: ArrayBuffer[] | null = null; for (let i = 0; i < 4; i++) { const h = SW_H[i]!(dv, i + 1); if (h !== undefined) { if (held === null) held = [h]; else held.push(h) } } sink = held === null ? 1 : held.length } },
    { label: 'typof-num   ', per: () => { sink = typeof PV === 'number' ? 1 : 0 } },
    // —— 「恒分配空数组」vs「懒分配」：callPlan 里 held 的两种写法，逐字对照 ——
    // xxx0 = 无 codec 参数（S0/S3 常态，h 恒为 undefined）；xxx1 = 有 codec 参数
    { label: 'arr-lit-0   ', per: () => { const a: ArrayBuffer[] = []; sink = a.length } },
    { label: 'held-lazy0  ', per: () => { let held = null as ArrayBuffer[] | null; const h = SW[0]!(dv, 1); if (h !== undefined) { if (held === null) held = [h]; else held.push(h) } sink = held === null ? 1 : held.length } },
    { label: 'held-alw0   ', per: () => { const held: ArrayBuffer[] = []; const h = SW[0]!(dv, 1); if (h !== undefined) held.push(h); sink = held.length } },
    { label: 'held-lazy1  ', per: () => { let held = null as ArrayBuffer[] | null; const h = SW_H[0]!(dv, 1); if (h !== undefined) { if (held === null) held = [h]; else held.push(h) } sink = held === null ? 1 : held.length } },
    { label: 'held-alw1   ', per: () => { const held: ArrayBuffer[] = []; const h = SW_H[0]!(dv, 1); if (h !== undefined) held.push(h); sink = held.length } },
]

// 调用形态对照（arm 里引用，勿内联掉）
const g1 = (x: number): number => x
const g4 = (...a: number[]): number => a[0]!
const h4 = (a: number, b: number, c: number, d: number): number => a + b + c + d

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
    step('  calib ' + label + ': probe n=' + String(n0) + ' dt=' + String(dt) + 'ms → batch=' + String(n))
    return n
}

const runner = (per: () => void) => (n: number): number => {
    const t0 = Date.now()
    for (let i = 0; i < n; i++) per()
    return Date.now() - t0
}

step('suite: prims (' + String(ROUNDS) + 'r, median 主指标)')
const fns = arms.map(a => runner(a.per))
// 单臂抛错不该带走整轮：记 0 并在日志留痕，便于定位是哪个 arm 崩的
const runSafe = (f: (n: number) => number, n: number, tag: string): number => {
    try { return f(n) } catch (e) { step('  !! ' + tag + ' threw: ' + String(e)); return 0 }
}
// 每臂各自校准批量（各 ~400ms）：慢臂不再被快臂的批量拖成 8~11s/样本
const batches = arms.map(a => calibrate(a.label, runner(a.per)))
const times: number[][] = arms.map(() => [])
for (let k = 0; k < arms.length; k++) runSafe(fns[k]!, batches[k]!, 'warmup')   // 预热
for (let r = 0; r < ROUNDS; r++) {
    for (let k = 0; k < arms.length; k++) {
        const i = (r + k) % arms.length
        times[i]!.push(runSafe(fns[i]!, batches[i]!, 'round' + String(r)))
    }
    step('  round ' + String(r + 1) + '/' + String(ROUNDS) + ' done')
}
const nsOf = (i: number): number => med(times[i]!) * 1e6 / batches[i]!
const noopNs = nsOf(0)
step('  noop地板=' + noopNs.toFixed(1) + 'ns')
for (let i = 0; i < arms.length; i++) {
    const v = nsOf(i)
    const net = v - noopNs
    step('  ' + arms[i]!.label + ' = ' + v.toFixed(1) + 'ns  (净 ' + net.toFixed(1) + 'ns)  n=' + String(batches[i]))
}
step('sink=' + String(sink))
step('DONE')
if (log) log.close()
std.exit(0)
