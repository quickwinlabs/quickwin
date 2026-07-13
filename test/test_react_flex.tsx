import '../lib/polyfill.js'
import * as gui from 'gui'
import { useState } from 'react'
import { createRoot } from '../lib/react-qw/index.js'
import { Tester } from './test_helper.js'

const WS_CHILD = 0x40000000
const WS_VISIBLE = 0x10000000

gui.RegisterClass('FlexTest', (hwnd, msg, wParam, lParam) => {
  if (!hwnd) return gui.DefWindowProc(hwnd, msg, wParam, lParam)
  if (msg === gui.WmMsg.DESTROY) {
    gui.PostQuitMessage(0)
    return 0
  }
  return gui.DefWindowProc(hwnd, msg, wParam, lParam)
})

function childrenOf(hwnd: any): any[] {
  const kids: any[] = []
  let child = gui.GetWindow(hwnd, gui.GetWindowCmd.CHILD)
  while (child) {
    kids.push(child)
    child = gui.GetWindow(child, gui.GetWindowCmd.NEXT)
  }
  return kids.reverse()
}

function getRelativeRect(childHwnd: any, parentHwnd: any) {
  const pr = gui.GetWindowRect(parentHwnd)
  const cr = gui.GetWindowRect(childHwnd)
  if (!pr || !cr) return { x: 0, y: 0, width: 0, height: 0 }
  return {
    x: cr.left - pr.left,
    y: cr.top - pr.top,
    width: cr.right - cr.left,
    height: cr.bottom - cr.top,
  }
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function expectedPositions(
  dir: 'row' | 'column',
  parentW: number, parentH: number,
  children: Array<{ w: number; h: number; flexGrow?: number; alignSelf?: 'auto' | 'flex-start' | 'flex-end' | 'center' | 'stretch' }>,
  justify: string = 'flex-start',
  align: string = 'stretch',
  gap: number = 0
) {
  const n = children.length
  const sizes = children.map(c => ({ w: c.w, h: c.h }))
  const flexGrows = children.map(c => c.flexGrow ?? 0)
  const totalGrow = flexGrows.reduce((s, g) => s + g, 0)

  if (dir === 'row') {
    const baseW = sizes.reduce((s, c) => s + c.w, 0)
    const freeGrow = parentW - baseW - Math.max(0, n - 1) * gap
    if (totalGrow > 0 && freeGrow > 0) {
      for (let i = 0; i < n; i++) {
        sizes[i].w += freeGrow * flexGrows[i] / totalGrow
      }
    }

    const totalW = sizes.reduce((s, c) => s + c.w, 0)
    const free = parentW - totalW - Math.max(0, n - 1) * gap
    let offset = 0, extraGap = 0
    if (justify === 'flex-end') offset = free
    else if (justify === 'center') offset = Math.max(0, free / 2)
    else if (justify === 'space-between' && n > 1) extraGap = free / (n - 1)
    else if (justify === 'space-around') { extraGap = free / n; offset = extraGap / 2 }
    else if (justify === 'space-evenly') { extraGap = free / (n + 1); offset = extraGap }
    let cursor = offset
    return sizes.map((sz, i) => {
      const ca = children[i].alignSelf && children[i].alignSelf !== 'auto' ? children[i].alignSelf : align
      let ch = ca === 'stretch' ? parentH : children[i].h
      let y = 0
      if (ca === 'flex-end') y = parentH - ch
      else if (ca === 'center') y = Math.max(0, (parentH - ch) / 2)
      const r = { x: cursor, y, width: sz.w, height: ch }
      cursor += sz.w + gap + extraGap
      return r
    })
  }
  const baseH = sizes.reduce((s, c) => s + c.h, 0)
  const freeGrow = parentH - baseH - Math.max(0, n - 1) * gap
  if (totalGrow > 0 && freeGrow > 0) {
    for (let i = 0; i < n; i++) {
      sizes[i].h += freeGrow * flexGrows[i] / totalGrow
    }
  }

  const totalH = sizes.reduce((s, c) => s + c.h, 0)
  const free = parentH - totalH - Math.max(0, n - 1) * gap
  let offset = 0, extraGap = 0
  if (justify === 'flex-end') offset = free
  else if (justify === 'center') offset = Math.max(0, free / 2)
  else if (justify === 'space-between' && n > 1) extraGap = free / (n - 1)
  else if (justify === 'space-around') { extraGap = free / n; offset = extraGap / 2 }
  else if (justify === 'space-evenly') { extraGap = free / (n + 1); offset = extraGap }
  let cursor = offset
  return sizes.map((sz, i) => {
    const ca = children[i].alignSelf && children[i].alignSelf !== 'auto' ? children[i].alignSelf : align
    let cw = ca === 'stretch' ? parentW : children[i].w
    let x = 0
    if (ca === 'flex-end') x = parentW - cw
    else if (ca === 'center') x = Math.max(0, (parentW - cw) / 2)
    const r = { x, y: cursor, width: cw, height: sz.h }
    cursor += sz.h + gap + extraGap
    return r
  })
}

async function testRowCol(
  tester: Tester,
  root: any, rootHwnd: any,
  name: string,
  dir: 'row' | 'column',
  parentW: number, parentH: number,
  childSizes: Array<{ w: number; h: number; flexGrow?: number; alignSelf?: 'auto' | 'flex-start' | 'flex-end' | 'center' | 'stretch' }>,
  justify: string = 'flex-start',
  align: string = 'stretch',
  gap: number = 0
) {
  tester.section(name)
  const exp = expectedPositions(dir, parentW, parentH, childSizes, justify, align, gap)

  root.render(
    <w type="BUTTON" style={{flexDirection: dir, justifyContent: justify as any, alignItems: align as any, gap, width: parentW, height: parentH}}>
      {childSizes.map((c, i) =>
        <w key={String(i)} type="BUTTON" style={{width: c.w, height: c.h, flexGrow: c.flexGrow ?? 0, alignSelf: c.alignSelf ?? 'auto'}} />
      )}
    </w>
  )
  await flush()

  const outerKids = childrenOf(rootHwnd)
  if (outerKids.length !== 1) { tester.check('container exists', 1, outerKids.length); return }
  const flexHwnd = outerKids[0]
  const kids = childrenOf(flexHwnd)
  tester.check('child count', childSizes.length, kids.length)

  for (let i = 0; i < Math.min(exp.length, kids.length); i++) {
    const a = getRelativeRect(kids[i], flexHwnd)
    const e = exp[i]
    tester.check(`child${i} x`, Math.round(e.x), Math.round(a.x))
    tester.check(`child${i} y`, Math.round(e.y), Math.round(a.y))
    tester.check(`child${i} w`, Math.round(e.width), Math.round(a.width))
    tester.check(`child${i} h`, Math.round(e.height), Math.round(a.height))
  }
}

async function main() {
  const tester = new Tester()

  const hwnd = gui.CreateWindow('FlexTest', '', 0, 0, 0, 800, 600, null, null)
  if (!hwnd) { tester.check('create root window', true, false); tester.summary(); return }

  const root = createRoot(hwnd)

  const c3 = [{ w: 50, h: 30 }, { w: 50, h: 30 }, { w: 50, h: 30 }]
  const c2 = [{ w: 50, h: 30 }, { w: 80, h: 40 }]

  // Row
  await testRowCol(tester, root, hwnd, 'Row default', 'row', 400, 200, c3)
  await testRowCol(tester, root, hwnd, 'Row justify center', 'row', 400, 200, c3, 'center')
  await testRowCol(tester, root, hwnd, 'Row justify end', 'row', 400, 200, c3, 'flex-end')
  await testRowCol(tester, root, hwnd, 'Row gap 10', 'row', 400, 200, c3, 'flex-start', 'stretch', 10)
  await testRowCol(tester, root, hwnd, 'Row align center', 'row', 400, 200, c3, 'flex-start', 'center')
  await testRowCol(tester, root, hwnd, 'Row align end', 'row', 400, 200, c3, 'flex-start', 'flex-end')
  await testRowCol(tester, root, hwnd, 'Row center+center+gap', 'row', 400, 200, c3, 'center', 'center', 10)
  await testRowCol(tester, root, hwnd, 'Row mixed sizes', 'row', 400, 200, c2)

  // Column
  await testRowCol(tester, root, hwnd, 'Col default', 'column', 200, 400, c3)
  await testRowCol(tester, root, hwnd, 'Col justify center', 'column', 200, 400, c3, 'center')
  await testRowCol(tester, root, hwnd, 'Col justify end', 'column', 200, 400, c3, 'flex-end')
  await testRowCol(tester, root, hwnd, 'Col gap 10', 'column', 200, 400, c3, 'flex-start', 'stretch', 10)
  await testRowCol(tester, root, hwnd, 'Col align center', 'column', 200, 400, c3, 'flex-start', 'center')
  await testRowCol(tester, root, hwnd, 'Col align end', 'column', 200, 400, c3, 'flex-start', 'flex-end')
  await testRowCol(tester, root, hwnd, 'Col center+center+gap', 'column', 200, 400, c3, 'center', 'center', 10)
  await testRowCol(tester, root, hwnd, 'Col mixed sizes', 'column', 200, 400, c2)

  // ── space-between / space-around / space-evenly ──
  // parent sizes chosen to avoid fractional pixel positions (SetWindowPos truncates)
  await testRowCol(tester, root, hwnd, 'Row space-between', 'row', 400, 200, c3, 'space-between')
  await testRowCol(tester, root, hwnd, 'Row space-around', 'row', 300, 200, c3, 'space-around')
  await testRowCol(tester, root, hwnd, 'Row space-evenly', 'row', 350, 200, c3, 'space-evenly')
  await testRowCol(tester, root, hwnd, 'Col space-between', 'column', 200, 400, c3, 'space-between')
  await testRowCol(tester, root, hwnd, 'Col space-around', 'column', 200, 300, c3, 'space-around')
  await testRowCol(tester, root, hwnd, 'Col space-evenly', 'column', 200, 330, c3, 'space-evenly')
  // single-child edge cases (space-between = flex-start, space-around/evenly = center)
  await testRowCol(tester, root, hwnd, 'Row single space-evenly', 'row', 400, 200, [{w:50,h:30}], 'space-evenly')
  await testRowCol(tester, root, hwnd, 'Col single space-around', 'column', 200, 400, [{w:50,h:30}], 'space-around')

  // ── flexGrow ──
  await testRowCol(tester, root, hwnd, 'Row flexGrow equal', 'row', 400, 200, [{w:50, h:30, flexGrow:1}, {w:50, h:30, flexGrow:1}])
  await testRowCol(tester, root, hwnd, 'Row flexGrow 1:3', 'row', 400, 200, [{w:50, h:30, flexGrow:1}, {w:50, h:30, flexGrow:3}])
  await testRowCol(tester, root, hwnd, 'Row flexGrow only one', 'row', 400, 200, [{w:50, h:30, flexGrow:1}, {w:50, h:30}])
  await testRowCol(tester, root, hwnd, 'Row flexGrow middle only', 'row', 400, 200, [{w:50, h:30}, {w:50, h:30, flexGrow:1}, {w:50, h:30}])
  await testRowCol(tester, root, hwnd, 'Row flexGrow + gap', 'row', 400, 200, [{w:50, h:30, flexGrow:1}, {w:50, h:30, flexGrow:1}], 'flex-start', 'stretch', 10)
  await testRowCol(tester, root, hwnd, 'Col flexGrow equal', 'column', 200, 400, [{w:50, h:30, flexGrow:1}, {w:50, h:30, flexGrow:1}])
  await testRowCol(tester, root, hwnd, 'Col flexGrow only one', 'column', 200, 400, [{w:50, h:30, flexGrow:1}, {w:50, h:30}])

  // ── alignSelf ──
  await testRowCol(tester, root, hwnd, 'Row alignSelf flex-start flex-end', 'row', 400, 200,
    [{w:50, h:30, alignSelf:'flex-start'}, {w:50, h:30}, {w:50, h:30, alignSelf:'flex-end'}],
    'flex-start', 'center')
  await testRowCol(tester, root, hwnd, 'Row alignSelf stretch in flex-start', 'row', 400, 200,
    [{w:50, h:30, alignSelf:'stretch'}, {w:50, h:30}],
    'flex-start', 'flex-start')
  await testRowCol(tester, root, hwnd, 'Col alignSelf flex-end flex-start', 'column', 200, 400,
    [{w:50, h:30, alignSelf:'flex-end'}, {w:50, h:30, alignSelf:'flex-start'}, {w:50, h:30}],
    'flex-start', 'center')
  await testRowCol(tester, root, hwnd, 'Col alignSelf stretch in flex-start', 'column', 200, 400,
    [{w:50, h:30, alignSelf:'stretch'}, {w:50, h:30}],
    'flex-start', 'flex-start')

  // ── Empty ──
  tester.section('Empty container no crash')
  root.render(
    <w type="BUTTON" style={{flexDirection:'row', width:400, height:200}} />
  )
  await flush()
  const outerKids = childrenOf(hwnd)
  if (outerKids.length !== 1) { tester.check('outer exists', 1, outerKids.length) }
  else { tester.check('no children', 0, childrenOf(outerKids[0]).length) }

  // ── Single child ──
  await testRowCol(tester, root, hwnd, 'Row single center', 'row', 400, 200, [{w:50, h:30}], 'center')
  await testRowCol(tester, root, hwnd, 'Row single end', 'row', 400, 200, [{w:50, h:30}], 'flex-end')
  await testRowCol(tester, root, hwnd, 'Col single center', 'column', 200, 400, [{w:50, h:30}], 'center')
  await testRowCol(tester, root, hwnd, 'Col single end', 'column', 200, 400, [{w:50, h:30}], 'flex-end')

  // ── No flex props ──
  tester.section('No flex props - positions unchanged')
  root.render(
    <w type="BUTTON" style={{width:400, height:200}}>
      <w type="BUTTON" style={{width:50, height:30}} />
      <w type="BUTTON" style={{width:80, height:40}} />
    </w>
  )
  await flush()
  const outer2 = childrenOf(hwnd)
  if (outer2.length !== 1) { tester.check('outer exists', 1, outer2.length) }
  else {
    const kids = childrenOf(outer2[0])
    tester.check('child count', 2, kids.length)
    if (kids.length >= 2) {
      const r0 = getRelativeRect(kids[0], outer2[0])
      const r1 = getRelativeRect(kids[1], outer2[0])
      // no flex layout applied, children keep creation positions (0,0,50,30) and (0,0,80,40)
      tester.check('child0 x', 0, Math.round(r0.x))
      tester.check('child0 y', 0, Math.round(r0.y))
      tester.check('child0 w', 50, Math.round(r0.width))
      tester.check('child0 h', 30, Math.round(r0.height))
      tester.check('child1 x', 0, Math.round(r1.x))
      tester.check('child1 y', 0, Math.round(r1.y))
      tester.check('child1 w', 80, Math.round(r1.width))
      tester.check('child1 h', 40, Math.round(r1.height))
    }
  }

  // ── Default sizes (no style.width/height on children) ──
  tester.section('Default sizes - 100x30')
  root.render(
      <w type="BUTTON" style={{flexDirection:'row', alignItems:'flex-start', gap:10, width:400, height:200}}>
      <w type="BUTTON" />
      <w type="BUTTON" />
    </w>
  )
  await flush()
  const outer3 = childrenOf(hwnd)
  if (outer3.length !== 1) { tester.check('outer exists', 1, outer3.length) }
  else {
    const kids = childrenOf(outer3[0])
    tester.check('child count', 2, kids.length)
    if (kids.length >= 2) {
      const r0 = getRelativeRect(kids[0], outer3[0])
      const r1 = getRelativeRect(kids[1], outer3[0])
      tester.check('child0 x', 0, Math.round(r0.x))
      tester.check('child0 y', 0, Math.round(r0.y))
      tester.check('child0 w', 100, Math.round(r0.width))
      tester.check('child0 h', 30, Math.round(r0.height))
      tester.check('child1 x', 110, Math.round(r1.x))
      tester.check('child1 y', 0, Math.round(r1.y))
      tester.check('child1 w', 100, Math.round(r1.width))
      tester.check('child1 h', 30, Math.round(r1.height))
    }
  }

  // ── Dynamic add/remove via setState ──
  tester.section('Dynamic add/remove via setState')
  function FlexApp({ initialItems }: { initialItems: any[] }) {
    const [items, setItems] = useState(initialItems)
    globalThis.__setItems = setItems
    return (
      <w type="BUTTON" style={{flexDirection:'row', justifyContent:'center', gap:10, width:400, height:200}}>
        {items.map((c, i) =>
          <w key={String(i)} type="BUTTON" style={{width:c.w, height:c.h}} />
        )}
      </w>
    )
  }

  root.render(<FlexApp initialItems={[{w:50,h:30},{w:50,h:30}]} />)
  await flush()

  function checkDynamic(outer: any[], expected: number[]) {
    if (outer.length !== 1) { tester.check('outer exists', 1, outer.length); return }
    const kids = childrenOf(outer[0])
    tester.check('child count', expected.length, kids.length)
    for (let i = 0; i < Math.min(expected.length, kids.length); i++) {
      const r = getRelativeRect(kids[i], outer[0])
      tester.check(`child${i} x`, expected[i], Math.round(r.x))
    }
  }

  let outer4 = childrenOf(hwnd)
  checkDynamic(outer4, [145, 205])

  // add third
  globalThis.__setItems([{w:50,h:30},{w:50,h:30},{w:50,h:30}])
  await flush()
  outer4 = childrenOf(hwnd)
  checkDynamic(outer4, [115, 175, 235])

  // remove back to one
  globalThis.__setItems([{w:50,h:30}])
  await flush()
  outer4 = childrenOf(hwnd)
  checkDynamic(outer4, [175])

  tester.summary()
  gui.PostQuitMessage(0)
}

main()
