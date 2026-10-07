// 一次性性能 bench：gui.SendMessage（C 模块直调） vs FFI bind SendMessageW（libffi trampoline）
// 不入 CI。用法：make js 后 POST /exec {"cmd":"qwin.exe test/bench_sendmessage.js"}
// 每场景预热 1 轮 + 5 轮计数（奇偶交叉起跑顺序），取各自最小值降抖动。
// 注意：全部消息发给自有窗口（直调 wndproc）——跨进程消息走消息经纪，几十 μs/次且
// IPC 开销掩盖入口链差异，不作测点。结束必须 DestroyWindow + std.exit：留活窗会让
// qwin 主流程驻留消息循环，exec 永不返回。
import * as std from 'std'
import * as gui from 'gui'
import { SendMessage } from '../lib/windows/user32.js'
import { WCHAR } from '../lib/ffi/bind.js'
import { PtrArrayBuffer } from '../lib/ffi/ctype.js'

const N = 500_000
// S2 含 WCHAR.encode 每次分配：500k 时 GC 抖动把单轮拖到 190s+（实测 ~380μs/迭代），
// 降到 50k——统计上仍远超噪声需求
const N_S2 = 50_000
const ROUNDS = 5
const ROUNDS_S2 = 3
const WM_NULL = 0x0000
const WM_SETTEXT = 0x000c
const WM_GETTEXT = 0x000d

// 文件日志（cwd=Z:\quickwin，宿主机 _build/bench_log.txt 可实时读）——exec 只在进程
// 退出后回包，挂了靠它定位卡点
const log = std.open('bench_log.txt', 'w')
function step(msg: string): void {
    std.printf('%s\n', msg)
    if (log) { log.puts(msg + '\n'); log.flush() }
}

step('stage: imports ok')

const winRaw = gui.CreateWindow('STATIC', 'bench-title', 0, 0, 0, 20, 20, null, null)
if (!winRaw) throw new Error('CreateWindow(STATIC) failed')
const win: gui.HWND = winRaw
step('stage: window created')

// 两侧入口各自提为常量（循环内属性查找开销对齐）
const gSM = gui.SendMessage
const fSM = SendMessage
const TEXT = 'bench'
const buf = new PtrArrayBuffer<'WCHAR'>(64)

// —— S1：WM_NULL 纯数字 lParam，最纯的入口链开销 ——
function s1g(): number {
    const t0 = Date.now()
    for (let i = 0; i < N; i++) gSM(win, WM_NULL, 0, 0)
    return Date.now() - t0
}
function s1f(): number {
    const t0 = Date.now()
    for (let i = 0; i < N; i++) fSM(win, WM_NULL, 0, 0)
    return Date.now() - t0
}

// —— S2：WM_SETTEXT 字符串 lParam（任务 3 多态点的真实成本形态）：
//    gui 侧 C 内编码；FFI 侧调用点 WCHAR.encode 在循环内（迁移后的真实写法）——
function s2g(): number {
    const t0 = Date.now()
    for (let i = 0; i < N_S2; i++) gSM(win, WM_SETTEXT, 0, TEXT)
    return Date.now() - t0
}
function s2f(): number {
    const t0 = Date.now()
    for (let i = 0; i < N_S2; i++) {
        const w = WCHAR.encode(TEXT)
        fSM(win, WM_SETTEXT, 0, w.ptr)
    }
    return Date.now() - t0
}

// —— S3：WM_GETTEXT 缓冲出参往返，两侧 JS 实参完全相同（纯入口差 + C 侧拷贝共模）——
function s3g(): number {
    const t0 = Date.now()
    for (let i = 0; i < N; i++) gSM(win, WM_GETTEXT, 64, buf.ptr)
    return Date.now() - t0
}
function s3f(): number {
    const t0 = Date.now()
    for (let i = 0; i < N; i++) fSM(win, WM_GETTEXT, 64, buf.ptr)
    return Date.now() - t0
}

function suite(name: string, n: number, rounds: number, rg: () => number, rf: () => number): void {
    step('suite: ' + name + ' warmup')
    rg(); rf()   // 预热各 1 轮
    const gs: number[] = []
    const fs: number[] = []
    for (let r = 0; r < rounds; r++) {
        // 奇偶交叉起跑顺序，抵消顺序性偏置（温度/调度漂移）
        if (r % 2 === 0) { gs.push(rg()); fs.push(rf()) }
        else { fs.push(rf()); gs.push(rg()) }
        step('  round ' + String(r) + ': gui=' + String(gs[gs.length - 1]) +
            'ms ffi=' + String(fs[fs.length - 1]) + 'ms')
    }
    const gmin = Math.min(...gs), fmin = Math.min(...fs)
    const ns = (ms: number) => (ms * 1e6 / n).toFixed(0)
    step('  ==> gui min=' + String(gmin) + 'ms (' + ns(gmin) + ' ns/call), ffi min=' +
        String(fmin) + 'ms (' + ns(fmin) + ' ns/call), ffi/gui=' + (fmin / gmin).toFixed(2) +
        'x, delta=' + ns(fmin - gmin) + 'ns')
}

step('bench_sendmessage: round2 (S1 done in round1), S2 n=' + String(N_S2) +
    '/' + String(ROUNDS_S2) + 'r, S3 n=' + String(N) + '/' + String(ROUNDS) + 'r (min)')
suite('S2 WM_SETTEXT  字符串 lParam  (FFI 侧含 WCHAR.encode)', N_S2, ROUNDS_S2, s2g, s2f)
suite('S3 WM_GETTEXT  缓冲出参往返  (两侧实参相同)', N, ROUNDS, s3g, s3f)

gui.DestroyWindow(win)
step('DONE')
if (log) log.close()
std.exit(0)
