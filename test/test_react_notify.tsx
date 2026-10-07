// react-qw 通知解码契约测试（GUI 程序，手动运行：qwin test/test_react_notify.js；全过退出码 0）。
// 向组件的包装窗口发 WM_NOTIFY，断言回调拿到的值——覆盖 ListView（点击 / 选中拦截 / 自绘）、Link、
// DateTimePicker、Tab、TreeView 里「从 lParam 指向的原生内存解码通知结构」的全部路径，静态截图碰不到它们。
// 缓冲区偏移按 Win32 头文件手工推算（不复用组件内部的 struct 定义），作为独立预言。
import '../lib/polyfill.js'
import * as os from 'os'
import * as std from 'std'
import * as ffi from 'ffi'
import * as gui from 'gui'
import { createRoot, ListView, Link, DateTimePicker, Tab, TreeView, type Column } from '../lib/react-qw/index.js'
import { SendMessage, GetWindow } from '../lib/windows/user32.js'
import { CreateCompatibleDC, DeleteDC } from '../lib/windows/gdi32.js'
import { NULL } from '../lib/ffi/ctype.js'

const P = os.arch === 'x64' ? 8 : 4
const align = (n: number, a: number): number => (n + a - 1) & ~(a - 1)
const HDR = align(2 * P + 4, P)                 // NMHDR: hwndFrom, idFrom, code(i32)

let pass = 0, fail = 0
function expect(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`PASS ${label} = ${a}`) }
  else { fail++; console.log(`FAIL ${label} = ${a} (expected ${e})`) }
}

function nm(size: number, code: number): { b: ArrayBuffer; dv: DataView } {
  const b = new ArrayBuffer(size)
  const dv = new DataView(b)
  dv.setInt32(2 * P, code, true)
  return { b, dv }
}
function setPtr(dv: DataView, off: number, v: number): void {
  if (P === 8) dv.setBigUint64(off, BigInt(v), true)
  else dv.setUint32(off, v >>> 0, true)
}
function notify(h: gui.HWND, b: ArrayBuffer): number {
  return SendMessage(h, gui.WmMsg.NOTIFY, 0, ffi.bufferPtr(b)) as number
}

// ---------- 组件与记录 ----------
interface Row { name: string; size: string; action: string }
const data: Row[] = [
  { name: 'a', size: '1', action: 'x' }, { name: 'b', size: '2', action: 'y' }, { name: 'c', size: '3', action: 'z' },
]
const lvClicks: string[] = []
const columns: Column<Row>[] = [
  { name: 'N', dataIndex: 'name' },
  { name: 'S', dataIndex: 'size', width: 60 },
  {
    name: 'A', dataIndex: 'action',
    cellStyle: { color: 0x00FF0000, background: 0x00112233, underline: true },
    onCellClick: (r, row) => { lvClicks.push(`${r.name}@${row}`) },
  },
]
const linkUrls: string[] = []
const dtpVals: (number | null)[] = []
const tabSel: number[] = []
const tvSel: (string | null)[] = []

let lvW: gui.HWND | null = null, linkW: gui.HWND | null = null, dtpW: gui.HWND | null = null
let dtpW2: gui.HWND | null = null, tabW: gui.HWND | null = null, tvW: gui.HWND | null = null

function App() {
  return (
    <w type="STATIC" style={{ flexGrow: 1, flexDirection: 'column', alignItems: 'stretch', padding: 6, gap: 4 }}>
      <ListView<Row> ref={(h: gui.HWND | null) => { lvW = h }} columns={columns} data={data} style={{ height: 140 }} />
      <Link ref={(h: gui.HWND | null) => { linkW = h }} href="https://example.com" onClick={(u) => { linkUrls.push(u) }}>link</Link>
      <DateTimePicker ref={(h: gui.HWND | null) => { dtpW = h }} onChange={(d) => { dtpVals.push(d ? d.getTime() : null) }} />
      <DateTimePicker ref={(h: gui.HWND | null) => { dtpW2 = h }} value={new Date(2023, 5, 7, 8, 9, 10)} />
      <Tab ref={(h: gui.HWND | null) => { tabW = h }} style={{ height: 80 }}
        tabs={[{ title: '页一', content: null }, { title: '页二', content: null }]}
        onChange={(i) => { tabSel.push(i) }} />
      <TreeView ref={(h: gui.HWND | null) => { tvW = h }} style={{ height: 100 }}
        data={[{ key: 'k1', label: 'one' }, { key: 'k2', label: 'two' }]}
        onSelect={(n) => { tvSel.push(n ? (n.key ?? null) : null) }} />
    </w>
  )
}

function child(h: gui.HWND | null): gui.HWND {
  if (!h) throw new Error('wrapper hwnd missing')
  const c = GetWindow(h, 5 /* GW_CHILD */)
  if (!c) throw new Error('no child window')
  return c
}

function runAll(): void {
  try {
    // ---- ListView：NM_CLICK → onCellClick ----
    const lvNM = (code: number): { b: ArrayBuffer; dv: DataView } => nm(HDR + 128, code)
    let m = lvNM(gui.LvNotifyCode.CLICK)
    m.dv.setInt32(HDR, 1, true); m.dv.setInt32(HDR + 4, 2, true)
    notify(lvW!, m.b)
    expect('LV click(item=1,sub=2) 触发 onCellClick', lvClicks.slice(), ['b@1'])
    m = lvNM(gui.LvNotifyCode.CLICK); m.dv.setInt32(HDR, 0, true); m.dv.setInt32(HDR + 4, 0, true)
    notify(lvW!, m.b)
    expect('LV click(sub=0, 该列无 onCellClick) 不触发', lvClicks.slice(), ['b@1'])
    m = lvNM(gui.LvNotifyCode.CLICK); m.dv.setInt32(HDR, 9, true); m.dv.setInt32(HDR + 4, 2, true)
    notify(lvW!, m.b)
    expect('LV click(item 越界) 不触发', lvClicks.slice(), ['b@1'])
    m = lvNM(gui.LvNotifyCode.CLICK); m.dv.setInt32(HDR, 2, true); m.dv.setInt32(HDR + 4, 2, true)
    notify(lvW!, m.b)
    expect('LV click(item=2,sub=2)', lvClicks.slice(), ['b@1', 'c@2'])

    // ---- ListView：LVN_ITEMCHANGING 拦截选中变化 ----
    const SEL = gui.LvItemState.SELECTED
    m = lvNM(gui.LvNotifyCode.ITEMCHANGING); m.dv.setUint32(HDR + 8, SEL, true); m.dv.setUint32(HDR + 12, 0, true)
    expect('LV ITEMCHANGING 选中位变化 → 拦截(1)', notify(lvW!, m.b), 1)
    m = lvNM(gui.LvNotifyCode.ITEMCHANGING); m.dv.setUint32(HDR + 8, 1 /* FOCUSED */, true); m.dv.setUint32(HDR + 12, 0, true)
    expect('LV ITEMCHANGING 选中位不变 → 放行(0)', notify(lvW!, m.b), 0)
    m = lvNM(gui.LvNotifyCode.ITEMCHANGING); m.dv.setUint32(HDR + 8, 0x80000000 | SEL, true); m.dv.setUint32(HDR + 12, 0x80000000, true)
    expect('LV ITEMCHANGING 高位置位的 u32 状态仍判出选中位变化', notify(lvW!, m.b), 1)

    // ---- ListView：NM_CUSTOMDRAW ----
    const cdStage = HDR, cdHdc = align(cdStage + 4, P), cdRc = cdHdc + P, cdItem = cdRc + 16
    const cdState = cdItem + P, cdLparam = align(cdState + 4, P), cdEnd = cdLparam + P
    const lvText = cdEnd, lvBk = cdEnd + 4, lvSub = cdEnd + 8
    const memDc = CreateCompatibleDC(NULL)
    const cd = (stage: number, row: number, sub: number): { b: ArrayBuffer; dv: DataView } => {
      const x = nm(cdEnd + 64, gui.LvNotifyCode.CUSTOMDRAW)
      x.dv.setUint32(cdStage, stage, true)
      setPtr(x.dv, cdHdc, memDc as number)
      setPtr(x.dv, cdItem, row)
      x.dv.setInt32(lvSub, sub, true)
      return x
    }
    expect('LV CUSTOMDRAW PREPAINT → NOTIFYITEMDRAW', notify(lvW!, cd(gui.CustomDrawStage.PREPAINT, 0, 0).b), gui.CustomDrawFlag.NOTIFYITEMDRAW)
    expect('LV CUSTOMDRAW ITEMPREPAINT → NOTIFYSUBITEMDRAW', notify(lvW!, cd(gui.CustomDrawStage.ITEMPREPAINT, 0, 0).b), gui.CustomDrawFlag.NOTIFYSUBITEMDRAW)
    expect('LV CUSTOMDRAW SUBITEMPREPAINT(无样式列) → DODEFAULT', notify(lvW!, cd(gui.CustomDrawStage.SUBITEMPREPAINT, 1, 0).b), gui.CustomDrawFlag.DODEFAULT)
    const sub = cd(gui.CustomDrawStage.SUBITEMPREPAINT, 1, 2)
    expect('LV CUSTOMDRAW SUBITEMPREPAINT(样式列, 带字体) → NEWFONT', notify(lvW!, sub.b), gui.CustomDrawFlag.NEWFONT)
    expect('LV CUSTOMDRAW 写回 clrText', sub.dv.getUint32(lvText, true), 0x00FF0000)
    expect('LV CUSTOMDRAW 写回 clrTextBk', sub.dv.getUint32(lvBk, true), 0x00112233)
    if (memDc) DeleteDC(memDc)

    // ---- Link：NM_CLICK / LinkRet → onClick(url) ----
    const URL = 'https://example.com/路径?q=1&x=中文'
    const lk = (code: number): { b: ArrayBuffer; dv: DataView } => {
      const x = nm(HDR + 112 + 2084 * 2 + 16, code)
      for (let i = 0; i < URL.length; i++) x.dv.setUint16(HDR + 112 + i * 2, URL.charCodeAt(i), true)
      return x
    }
    notify(linkW!, lk(gui.SysLinkNotifyCode.CLICK).b)
    notify(linkW!, lk(gui.SysLinkNotifyCode.RETURN).b)
    expect('Link CLICK/RETURN → onClick(url)', linkUrls.slice(), [URL, URL])

    // ---- DateTimePicker：DTN_DATETIMECHANGE ----
    const dt = (flags: number): { b: ArrayBuffer; dv: DataView } => {
      const x = nm(HDR + 4 + 16 + 8, gui.DtNotifyCode.DATETIMECHANGE)
      x.dv.setUint32(HDR, flags, true)
      const s = HDR + 4
      x.dv.setUint16(s, 2024, true); x.dv.setUint16(s + 2, 2, true); x.dv.setUint16(s + 4, 4, true)
      x.dv.setUint16(s + 6, 29, true); x.dv.setUint16(s + 8, 13, true); x.dv.setUint16(s + 10, 45, true)
      x.dv.setUint16(s + 12, 59, true); x.dv.setUint16(s + 14, 0, true)
      return x
    }
    notify(dtpW!, dt(gui.DtFlag.GDT_VALID).b)
    notify(dtpW!, dt(gui.DtFlag.GDT_NONE).b)
    expect('DTP DATETIMECHANGE → onChange(Date | null)', dtpVals.slice(), [new Date(2024, 1, 29, 13, 45, 59).getTime(), null])

    // ---- DateTimePicker：value → SYSTEMTIME.encode → 控件回读 ----
    const back = new ArrayBuffer(16)
    const ret = SendMessage(child(dtpW2), gui.DtMsg.GETSYSTEMTIME, 0, ffi.bufferPtr(back)) as number
    const bdv = new DataView(back)
    expect('DTP value 写入后控件回读 GDT_VALID', ret, 0)
    expect('DTP value 写入后控件回读 年月日', [bdv.getUint16(0, true), bdv.getUint16(2, true), bdv.getUint16(6, true)], [2023, 6, 7])
    console.log('INFO DTP 回读时分秒毫秒', [bdv.getUint16(8, true), bdv.getUint16(10, true), bdv.getUint16(12, true), bdv.getUint16(14, true)])

    // ---- Tab：TCN_SELCHANGING → TCM_GETCURSEL → onChange ----
    // 包装窗口有两个子窗口（标签控件 + 内容 STATIC），GW_CHILD 给 Z 序最上的（后建的内容窗口），
    // 标签控件是最先创建的 = 兄弟里最底层的 GW_HWNDLAST
    const tabCtl = GetWindow(child(tabW), 1 /* GW_HWNDLAST */)
    if (!tabCtl) throw new Error('no tab control')
    SendMessage(tabCtl, gui.TcMsg.SETCURSEL, 1, 0)
    notify(tabW!, nm(HDR + 8, gui.TcNotifyCode.SELCHANGING).b)
    expect('Tab SELCHANGING → onChange(1)', tabSel.slice(), [1])

    // ---- TreeView：真实 TVN_SELCHANGED（由控件自己发）----
    const tv = child(tvW)
    const root = SendMessage(tv, gui.TvMsg.GETNEXTITEM, gui.TvGnRelative.ROOT, 0) as number
    const second = SendMessage(tv, gui.TvMsg.GETNEXTITEM, gui.TvGnRelative.NEXT, root) as number
    SendMessage(tv, gui.TvMsg.SELECTITEM, gui.TvGnRelative.CARET, second)
    expect('TreeView 选中第二项 → onSelect(k2)', tvSel.slice(), ['k2'])
  } catch (e) {
    fail++
    console.log('FAIL 异常: ' + String(e) + '\n' + ((e as Error).stack ?? ''))
  }
  console.log(`SUMMARY pass=${pass} fail=${fail}`)
  std.exit(fail === 0 ? 0 : 1)
}

createRoot({ text: 'react-qw notify contract test', width: 560, height: 700 }).render(<App />)
os.setTimeout(runAll, 800)
