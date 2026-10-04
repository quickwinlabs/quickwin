import * as os from 'os'
import { Tester } from './test_helper.js'
import { struct } from '../lib/ffi/struct.js'
import { bind, type Ptr } from '../lib/ffi/bind.js'

// 编译期断言工具（仅类型层，运行时无开销）
type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false
function expectType<T extends true>(_value?: T): void {}

const RECT = struct('RECT', [
    { name: 'left', type: 'i32' },
    { name: 'top', type: 'i32' },
    { name: 'right', type: 'i32' },
    { name: 'bottom', type: 'i32' },
])

const TVITEM = struct([
    { name: 'mask', type: 'u32' },
    { name: 'hItem', type: '<>ptr' },
    { name: 'state', type: 'u32' },
    { name: 'stateMask', type: 'u32' },
    { name: 'pszText', type: '<>ptr' },
    { name: 'cchTextMax', type: 'i32' },
    { name: 'iImage', type: 'i32' },
    { name: 'iSelectedImage', type: 'i32' },
    { name: 'cChildren', type: 'i32' },
    { name: 'lParam', type: '<>ptr' },
])
const TVINSERTSTRUCT = struct([
    { name: 'hParent', type: '<>ptr' },
    { name: 'hInsertAfter', type: '<>ptr' },
    { name: 'item', type: TVITEM.__struct },
])

export const suite = {
    name: 'ffi-struct',
    run: (t: Tester) => {
        const is64 = os.arch === 'x64'

        t.section('RECT layout & roundtrip')
        t.check('RECT.size == 16', 16, RECT.size)
        const rbuf = RECT.encode({ left: 10, top: 20, right: 30, bottom: 40 })
        const r = RECT.decode(rbuf)
        t.check('left', 10, r.left)
        t.check('top', 20, r.top)
        t.check('right', 30, r.right)
        t.check('bottom', 40, r.bottom)
        t.check('offsetOf left', 0, RECT.offsetOf('left'))
        t.check('offsetOf bottom', 12, RECT.offsetOf('bottom'))

        t.section('GetWindowRect fills RECT buffer')
        const getWindowRect = bind('user32.dll', 'GetWindowRect', '<>ptr <VOID>ptr -> int')
        const getWindowRectLayout = bind('user32.dll', 'GetWindowRect', '<>ptr <RECT>ptr -> int', { RECT })
        const getDesktopWindow = bind('user32.dll', 'GetDesktopWindow', ' -> <>ptr')
        const hwnd = getDesktopWindow()
        const wrect = new ArrayBuffer(16)
        const ok = getWindowRect(hwnd, wrect)
        t.checkTrue('GetWindowRect succeeds', ok !== 0)
        const wr = RECT.decode(wrect)
        t.checkTrue('screen RECT non-empty', wr.right > 0 && wr.bottom > 0)

        // out 参数：命名 struct 的 alloc() 句柄 → .ptr 为 Ptr<'RECT'>，直接喂 <RECT>ptr
        t.section('RECT.alloc() out-param handle')
        const out = RECT.alloc()
        t.checkTrue('alloc() exposes buffer + ptr', out.buffer instanceof ArrayBuffer && typeof out.ptr === 'number')
        t.checkTrue('GetWindowRect(hwnd, out.ptr) succeeds', getWindowRectLayout(hwnd, out.ptr) !== 0)
        const or = out.decode()
        t.checkTrue('alloc().decode() decodes out-param', or.right > 0 && or.bottom > 0)

        t.section('ptr layout matches arch')
        t.check(`TVITEM.size (${os.arch})`, is64 ? 56 : 40, TVITEM.size)
        t.check('TVITEM.offsetOf pszText', is64 ? 24 : 16, TVITEM.offsetOf('pszText'))
        t.check('TVINSERTSTRUCT.size', is64 ? 72 : 48, TVINSERTSTRUCT.size)
        t.check('TVINSERTSTRUCT.offsetOf item', is64 ? 16 : 8, TVINSERTSTRUCT.offsetOf('item'))

        t.section('nested struct roundtrip')
        const ins = TVINSERTSTRUCT.encode({
            hParent: 0x11111111,
            hInsertAfter: 0x22222222,
            item: {
                mask: 1, hItem: 0x33333333, state: 0, stateMask: 0,
                pszText: 0x44444444, cchTextMax: 100,
                iImage: 0, iSelectedImage: 0, cChildren: 5, lParam: 0x55555555,
            },
        })
        const got = TVINSERTSTRUCT.decode(ins)
        t.check('nested hParent', 0x11111111, got.hParent)
        t.check('nested hInsertAfter', 0x22222222, got.hInsertAfter)
        t.check('nested cChildren', 5, got.item.cChildren)
        t.check('nested ptr pszText', 0x44444444, got.item.pszText)

        t.section('C typedef aliases (int/DWORD/LPARAM/LONG_PTR/short)')
        const M = struct([
            { name: 'n', type: 'i32' },             // int
            { name: 'd', type: 'u32' },             // DWORD
            { name: 'w', type: '<>ptr' },            // LPARAM
            { name: 's', type: 'i16' },             // short
            { name: 'q', type: '<>ptr' },            // LONG_PTR
        ])
        t.check(`aliased size (${os.arch})`, is64 ? 32 : 20, M.size)
        const mb = M.encode({ n: -5, d: 0xFFFFFFFF, w: 0xAABBCCDD, s: -7, q: 0x11223344 })
        const m = M.decode(mb)
        t.check('int -5', -5, m.n)
        t.check('DWORD', 0xFFFFFFFF, m.d)
        t.check('LPARAM', 0xAABBCCDD, m.w)
        t.check('short -7', -7, m.s)
        t.check('LONG_PTR', 0x11223344, m.q)

        t.section('utf-16le string[8] roundtrip & truncation')
        const W = struct([{ name: 'name', type: { tag: 'string', unit: 'u16', length: 8, encoding: 'utf-16le' } }])
        t.check('utf16[8].size == 16', 16, W.size)
        const wb = W.encode({ name: 'hello' })
        t.check('read back "hello"', 'hello', W.decode(wb).name)
        const lb = W.encode({ name: 'a very long string over' })
        t.check('utf16[8]: payload 7 + NUL', 'a very ', W.decode(lb).name)
        t.check('utf16 terminator[14..15] == 0', 0, new DataView(lb).getUint16(14, true))

        t.section("utf-8 string[8] roundtrip & truncation")
        const C = struct([{ name: 'name', type: { tag: 'string', unit: 'u8', length: 8, encoding: 'utf-8' } }])
        t.check('char[8].size == 8', 8, C.size)
        const cb = C.encode({ name: 'hi' })
        t.check('read back "hi"', 'hi', C.decode(cb).name)
        t.check('NUL at [2]', 0, new DataView(cb).getUint8(2))
        const ctrunc = C.encode({ name: '1234567890' })
        t.check('char[8]: payload 7 + NUL', '1234567', C.decode(ctrunc).name)
        t.check('char terminator[7] == 0', 0, new DataView(ctrunc).getUint8(7))

        t.section('numeric arrays roundtrip (CArray)')
        const A = struct([
            { name: 'v', type: { tag: 'array', ctype: 'u16', length: 4 } },
            { name: 'k', type: { tag: 'array', ctype: 'i32', length: 2 } },
        ])
        t.check('size == 16', 16, A.size)
        const ab = A.encode({ v: [1, 2, 3, 4], k: [-1, 300000] })
        const ad = A.decode(ab)
        t.check('u16[0]', 1, ad.v[0])
        t.check('u16[3]', 4, ad.v[3])
        t.check('i32[0] -1', -1, ad.k[0])
        t.check('i32[1]', 300000, ad.k[1])

        t.section('T[1] stays an array (no scalar degradation)')
        const ONE = struct([{ name: 'v', type: { tag: 'array', ctype: 'u16', length: 1 } }])
        t.check('size == 2', 2, ONE.size)
        const one = ONE.decode(ONE.encode({ v: [42] }))
        t.check('length 1', 1, one.v.length)
        t.check('[0]', 42, one.v[0])

        t.section('array of struct roundtrip (stride = child size)')
        const PT = struct([
            { name: 'x', type: 'i32' },
            { name: 'y', type: 'i32' },
        ])
        const POLY = struct([
            { name: 'count', type: 'u32' },
            { name: 'pts', type: { tag: 'array', ctype: PT.__struct, length: 3 } },
        ])
        t.check('POLY.size == 28', 28, POLY.size)
        t.check('POLY.offsetOf pts', 4, POLY.offsetOf('pts'))
        const poly = POLY.decode(POLY.encode({ count: 3, pts: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }] }))
        t.check('count', 3, poly.count)
        t.check('pts[0].x', 1, poly.pts[0].x)
        t.check('pts[2].y', 6, poly.pts[2].y)

        // 编译期断言：CType IR 推导 — string / 定长数组元组 / 嵌套 struct 递归
        expectType<Equal<ReturnType<typeof W.decode>['name'], string>>()
        expectType<Equal<ReturnType<typeof A.decode>['v'], [number, number, number, number]>>()
        expectType<Equal<ReturnType<typeof A.decode>['k'], [number, number]>>()
        expectType<Equal<ReturnType<typeof ONE.decode>['v'], [number]>>()
        expectType<Equal<ReturnType<typeof POLY.decode>['pts']['length'], 3>>()
        expectType<Equal<ReturnType<typeof POLY.decode>['pts'][0], ReturnType<typeof PT.decode>>>()

        let rejected = false
        try { struct([{ name: 'v', type: { tag: 'array', ctype: 'i32', length: 0 } }]) } catch { rejected = true }
        t.check('array length 0 rejected', true, rejected)

        let rejectedBare = false
        try { (struct as any)([{ name: 'p', type: 'ptr' }]) } catch { rejectedBare = true }
        t.check('bare "ptr" member rejected', true, rejectedBare)

        t.section("pointer member '<>ptr' raw vs '<T>ptr' branded")
        const PTR = struct([
            { name: 'raw', type: '<>ptr' },
            { name: 'r', type: '<RECT>ptr' },
            { name: 'tag', type: 'u32' },
        ])
        t.check('PTR.size', is64 ? 24 : 12, PTR.size)
        t.check('offsetOf raw', 0, PTR.offsetOf('raw'))
        t.check('offsetOf r', is64 ? 8 : 4, PTR.offsetOf('r'))
        t.check('offsetOf tag', is64 ? 16 : 8, PTR.offsetOf('tag'))
        const rawOut = RECT.alloc()
        const pd = PTR.decode(PTR.encode({ raw: rawOut.ptr, r: rawOut.ptr, tag: 7 }))
        t.check('raw roundtrip', rawOut.ptr, pd.raw)
        t.check('r roundtrip', rawOut.ptr, pd.r)
        t.check('tag', 7, pd.tag)
        // 编译期：'<>ptr' → number（T='' 品牌退化）；'<RECT>ptr' → Ptr<'RECT'>（品牌）
        expectType<Equal<ReturnType<typeof PTR.decode>['raw'], number>>()
        expectType<Equal<ReturnType<typeof PTR.decode>['r'], Ptr<'RECT'>>>()

        t.section('f32/f64 layout (MSVC: f@0, double@8)')
        const FL = struct([
            { name: 'f', type: 'f32' },      // float
            { name: 'd', type: 'f64' },      // double
        ])
        t.check('size == 16 (f@0, double aligned @8)', 16, FL.size)
        const fb = FL.encode({ f: 1.5, d: -2.25 })
        const fr = FL.decode(fb)
        t.check('float', 1.5, fr.f)
        t.check('double', -2.25, fr.d)

        t.section('comctl dialog structs track 32/64-bit ABI')
        const TCITEMW = struct([
            { name: 'mask', type: 'u32' },
            { name: 'dwState', type: 'u32' },
            { name: 'dwStateMask', type: 'u32' },
            { name: 'pszText', type: '<>ptr' },
            { name: 'cchTextMax', type: 'i32' },
            { name: 'iImage', type: 'i32' },
            { name: 'lParam', type: '<>ptr' },
        ])
        t.check('TCITEMW.size', is64 ? 40 : 28, TCITEMW.size)
        t.check('TCITEMW.offsetOf pszText', is64 ? 16 : 12, TCITEMW.offsetOf('pszText'))
        t.check('TCITEMW.offsetOf cchTextMax', is64 ? 24 : 16, TCITEMW.offsetOf('cchTextMax'))

        const TTTOOLINFOW = struct([
            { name: 'cbSize', type: 'u32' },
            { name: 'uFlags', type: 'u32' },
            { name: 'hwnd', type: '<>ptr' },
            { name: 'uId', type: '<>ptr' },
            { name: 'rect', type: { tag: 'array', ctype: 'i32', length: 4 } },
            { name: 'hinst', type: '<>ptr' },
            { name: 'lpszText', type: '<>ptr' },
            { name: 'lParam', type: '<>ptr' },
            { name: 'lpReserved', type: '<>ptr' }, // WinXP+ 追加
        ])
        t.check('TTTOOLINFOW.size', is64 ? 72 : 48, TTTOOLINFOW.size)
        t.check('TTTOOLINFOW.offsetOf lpszText', is64 ? 48 : 36, TTTOOLINFOW.offsetOf('lpszText'))

        const OPENFILENAMEW = struct([
            { name: 'lStructSize', type: 'u32' },
            { name: 'hwndOwner', type: '<>ptr' },
            { name: 'hInstance', type: '<>ptr' },
            { name: 'lpstrFilter', type: '<>ptr' },
            { name: 'lpstrCustomFilter', type: '<>ptr' },
            { name: 'nMaxCustFilter', type: 'u32' },
            { name: 'nFilterIndex', type: 'u32' },
            { name: 'lpstrFile', type: '<>ptr' },
            { name: 'nMaxFile', type: 'u32' },
            { name: 'lpstrFileTitle', type: '<>ptr' },
            { name: 'nMaxFileTitle', type: 'u32' },
            { name: 'lpstrInitialDir', type: '<>ptr' },
            { name: 'lpstrTitle', type: '<>ptr' },
            { name: 'Flags', type: 'u32' },
            { name: 'nFileOffset', type: 'u16' },
            { name: 'nFileExtension', type: 'u16' },
            { name: 'lpstrDefExt', type: '<>ptr' },
            { name: 'lCustData', type: '<>ptr' },
            { name: 'lpfnHook', type: '<>ptr' },
            { name: 'lpTemplateName', type: '<>ptr' },
            { name: 'pvReserved', type: '<>ptr' },
            { name: 'dwReserved', type: 'u32' },
            { name: 'FlagsEx', type: 'u32' }, // Win2000+ 追加
        ])
        t.check('OPENFILENAMEW.size', is64 ? 152 : 88, OPENFILENAMEW.size)
        t.check('OPENFILENAMEW.offsetOf lpstrFile', is64 ? 48 : 28, OPENFILENAMEW.offsetOf('lpstrFile'))
        t.check('OPENFILENAMEW.offsetOf Flags', is64 ? 96 : 52, OPENFILENAMEW.offsetOf('Flags'))
        t.check('OPENFILENAMEW.offsetOf lpstrTitle', is64 ? 88 : 48, OPENFILENAMEW.offsetOf('lpstrTitle'))

        const BROWSEINFOW = struct([
            { name: 'hwndOwner', type: '<>ptr' },
            { name: 'pidlRoot', type: '<>ptr' },
            { name: 'pszDisplayName', type: '<>ptr' },
            { name: 'lpszTitle', type: '<>ptr' },
            { name: 'ulFlags', type: 'u32' },
            { name: 'lpfn', type: '<>ptr' },
            { name: 'lParam', type: '<>ptr' },
            { name: 'iImage', type: 'i32' },
        ])
        t.check('BROWSEINFOW.size', is64 ? 64 : 32, BROWSEINFOW.size)
        t.check('BROWSEINFOW.offsetOf lpszTitle', is64 ? 24 : 12, BROWSEINFOW.offsetOf('lpszTitle'))
        t.check('BROWSEINFOW.offsetOf ulFlags', is64 ? 32 : 16, BROWSEINFOW.offsetOf('ulFlags'))

        t.section('NMHDR（嵌套时 MSVC 尾 padding 传染）')
        const NMHDR = struct([
            { name: 'hwndFrom', type: '<>ptr' },
            { name: 'idFrom', type: '<>ptr' },
            { name: 'code', type: 'i32' },
        ])
        t.check('NMHDR.size', is64 ? 24 : 12, NMHDR.size)
        t.check('NMHDR.offsetOf code', is64 ? 16 : 8, NMHDR.offsetOf('code'))

        t.section('NMCUSTOMDRAW / NMLVCUSTOMDRAW (ListView custom draw)')
        const NMCUSTOMDRAW = struct([
            { name: 'hdr', type: NMHDR.__struct },
            { name: 'dwDrawStage', type: 'u32' },
            { name: 'hdc', type: '<>ptr' },
            { name: 'rc', type: { tag: 'array', ctype: 'i32', length: 4 } },
            { name: 'dwItemSpec', type: '<>ptr' },
            { name: 'uItemState', type: 'u32' },
            { name: 'lItemlParam', type: '<>ptr' },
        ])
        t.check('NMCUSTOMDRAW.size', is64 ? 80 : 48, NMCUSTOMDRAW.size)
        t.check('NMCUSTOMDRAW.offsetOf dwDrawStage', is64 ? 24 : 12, NMCUSTOMDRAW.offsetOf('dwDrawStage'))
        t.check('NMCUSTOMDRAW.offsetOf hdc', is64 ? 32 : 16, NMCUSTOMDRAW.offsetOf('hdc'))
        t.check('NMCUSTOMDRAW.offsetOf dwItemSpec', is64 ? 56 : 36, NMCUSTOMDRAW.offsetOf('dwItemSpec'))
        const NMLVCUSTOMDRAW = struct([
            { name: 'hdr', type: NMHDR.__struct },
            { name: 'dwDrawStage', type: 'u32' },
            { name: 'hdc', type: '<>ptr' },
            { name: 'rc', type: { tag: 'array', ctype: 'i32', length: 4 } },
            { name: 'dwItemSpec', type: '<>ptr' },
            { name: 'uItemState', type: 'u32' },
            { name: 'lItemlParam', type: '<>ptr' },
            { name: 'clrText', type: 'u32' },
            { name: 'clrTextBk', type: 'u32' },
            { name: 'iSubItem', type: 'i32' },
            { name: 'dwItemType', type: 'u32' },
        ])
        t.check('NMLVCUSTOMDRAW.size', is64 ? 96 : 64, NMLVCUSTOMDRAW.size)
        t.check('NMLVCUSTOMDRAW.offsetOf clrText', is64 ? 80 : 48, NMLVCUSTOMDRAW.offsetOf('clrText'))
        t.check('NMLVCUSTOMDRAW.offsetOf clrTextBk', is64 ? 84 : 52, NMLVCUSTOMDRAW.offsetOf('clrTextBk'))
        t.check('NMLVCUSTOMDRAW.offsetOf iSubItem', is64 ? 88 : 56, NMLVCUSTOMDRAW.offsetOf('iSubItem'))

        t.section('NMLISTVIEW / NMITEMACTIVATE')
        const NMLISTVIEW = struct([
            { name: 'hdr', type: NMHDR.__struct },
            { name: 'iItem', type: 'i32' },
            { name: 'iSubItem', type: 'i32' },
            { name: 'uNewState', type: 'u32' },
            { name: 'uOldState', type: 'u32' },
            { name: 'uChanged', type: 'u32' },
            { name: 'ptAction', type: { tag: 'array', ctype: 'i32', length: 2 } },
            { name: 'lParam', type: '<>ptr' },
        ])
        t.check('NMLISTVIEW.size', is64 ? 64 : 44, NMLISTVIEW.size)
        t.check('NMLISTVIEW.offsetOf iItem', is64 ? 24 : 12, NMLISTVIEW.offsetOf('iItem'))
        t.check('NMLISTVIEW.offsetOf iSubItem', is64 ? 28 : 16, NMLISTVIEW.offsetOf('iSubItem'))
        t.check('NMLISTVIEW.offsetOf uNewState', is64 ? 32 : 20, NMLISTVIEW.offsetOf('uNewState'))
        t.check('NMLISTVIEW.offsetOf uOldState', is64 ? 36 : 24, NMLISTVIEW.offsetOf('uOldState'))

        t.section('LVITEMW / LVCOLUMNW')
        const LVITEMW = struct([
            { name: 'mask', type: 'u32' },
            { name: 'iItem', type: 'i32' },
            { name: 'iSubItem', type: 'i32' },
            { name: 'state', type: 'u32' },
            { name: 'stateMask', type: 'u32' },
            { name: 'pszText', type: '<>ptr' },
            { name: 'cchTextMax', type: 'i32' },
            { name: 'iImage', type: 'i32' },
            { name: 'lParam', type: '<>ptr' },
            { name: 'iIndent', type: 'i32' },
            { name: 'iGroupId', type: 'i32' },
            { name: 'cColumns', type: 'u32' },
            { name: 'puColumns', type: '<>ptr' },
            { name: 'piColFmt', type: '<>ptr' },
            { name: 'iGroup', type: 'i32' },
        ])
        t.check('LVITEMW.size', is64 ? 88 : 60, LVITEMW.size)
        t.check('LVITEMW.offsetOf iItem', 4, LVITEMW.offsetOf('iItem'))
        t.check('LVITEMW.offsetOf pszText', is64 ? 24 : 20, LVITEMW.offsetOf('pszText'))
        t.check('LVITEMW.offsetOf iImage', is64 ? 36 : 28, LVITEMW.offsetOf('iImage'))
        t.check('LVITEMW.offsetOf lParam', is64 ? 40 : 32, LVITEMW.offsetOf('lParam'))
        const LVCOLUMNW = struct([
            { name: 'mask', type: 'u32' },
            { name: 'fmt', type: 'i32' },
            { name: 'cx', type: 'i32' },
            { name: 'pszText', type: '<>ptr' },
            { name: 'cchTextMax', type: 'i32' },
            { name: 'iSubItem', type: 'i32' },
            { name: 'iImage', type: 'i32' },
            { name: 'iOrder', type: 'i32' },
            { name: 'cxMin', type: 'i32' },
            { name: 'cxDefault', type: 'i32' },
            { name: 'cxIdeal', type: 'i32' },
        ])
        t.check('LVCOLUMNW.size', is64 ? 56 : 44, LVCOLUMNW.size)
        t.check('LVCOLUMNW.offsetOf pszText', is64 ? 16 : 12, LVCOLUMNW.offsetOf('pszText'))
        t.check('LVCOLUMNW.offsetOf iSubItem', is64 ? 28 : 20, LVCOLUMNW.offsetOf('iSubItem'))
        t.check('LVCOLUMNW.offsetOf iOrder', is64 ? 36 : 28, LVCOLUMNW.offsetOf('iOrder'))

        t.section('NMDATETIMECHANGE')
        const SYSTEMTIME = struct([
            { name: 'wYear', type: 'u16' },
            { name: 'wMonth', type: 'u16' },
            { name: 'wDayOfWeek', type: 'u16' },
            { name: 'wDay', type: 'u16' },
            { name: 'wHour', type: 'u16' },
            { name: 'wMinute', type: 'u16' },
            { name: 'wSecond', type: 'u16' },
            { name: 'wMilliseconds', type: 'u16' },
        ])
        const NMDATETIMECHANGE = struct([
            { name: 'hdr', type: NMHDR.__struct },
            { name: 'dwFlags', type: 'u32' },
            { name: 'st', type: SYSTEMTIME.__struct },
        ])
        t.check('NMDATETIMECHANGE.size', is64 ? 48 : 32, NMDATETIMECHANGE.size)
        t.check('NMDATETIMECHANGE.offsetOf dwFlags', is64 ? 24 : 12, NMDATETIMECHANGE.offsetOf('dwFlags'))
        t.check('NMDATETIMECHANGE.offsetOf st', is64 ? 28 : 16, NMDATETIMECHANGE.offsetOf('st'))

        t.section('NMLINK szUrl offset')
        const LITEM = struct([
            { name: 'mask', type: 'u32' },
            { name: 'iLink', type: 'i32' },
            { name: 'state', type: 'u32' },
            { name: 'stateMask', type: 'u32' },
            { name: 'szID', type: { tag: 'string', unit: 'u16', length: 48, encoding: 'utf-16le' } },
        ])
        const NMLINK = struct([
            { name: 'hdr', type: NMHDR.__struct },
            { name: 'item', type: LITEM.__struct },
            { name: 'szUrl', type: { tag: 'string', unit: 'u16', length: 2084, encoding: 'utf-16le' } },
        ])
        t.check('LITEM.offsetOf szID', 16, LITEM.offsetOf('szID'))
        t.check('NMLINK.offsetOf szUrl', is64 ? 136 : 124, NMLINK.offsetOf('szUrl'))
    },
}
