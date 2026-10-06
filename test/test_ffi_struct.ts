import * as os from 'os'
import { Tester } from './test_helper.js'
import { struct, union } from '../lib/ffi/struct.js'
import { bind, } from '../lib/ffi/bind.js'
import { Ptr } from '../lib/ffi/ctype.js'
import type { C_Union } from '../lib/ffi/ctype.js'

// 编译期断言工具（仅类型层，运行时无开销）
type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false
function expectType<T extends true>(_value?: T): void { }

const RECT = struct('RECT', {
    left: 'i32',
    top: 'i32',
    right: 'i32',
    bottom: 'i32',
})

const TVITEM = struct({
    mask: 'u32',
    hItem: '<>ptr',
    state: 'u32',
    stateMask: 'u32',
    pszText: '<>ptr',
    cchTextMax: 'i32',
    iImage: 'i32',
    iSelectedImage: 'i32',
    cChildren: 'i32',
    lParam: '<>ptr',
})
const TVINSERTSTRUCT = struct({
    hParent: '<>ptr',
    hInsertAfter: '<>ptr',
    item: TVITEM.__struct,
})

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
        const getWindowRect = bind('user32.dll', 'GetWindowRect', '<>ptr <BYTE>ptr -> int')
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
        const M = struct({
            n: 'int',        // 别名 → i32（字段值位收别名，normToken 归一）
            d: 'DWORD',      // 别名 → u32
            w: 'LPARAM',     // 别名 → <>ptr
            s: 'short',      // 别名 → i16
            q: 'LONG_PTR',   // 别名 → <>ptr
        })
        t.check(`aliased size (${os.arch})`, is64 ? 32 : 20, M.size)
        const mb = M.encode({ n: -5, d: 0xFFFFFFFF, w: 0xAABBCCDD, s: -7, q: 0x11223344 })
        const m = M.decode(mb)
        t.check('int -5', -5, m.n)
        t.check('DWORD', 0xFFFFFFFF, m.d)
        t.check('LPARAM', 0xAABBCCDD, m.w)
        t.check('short -7', -7, m.s)
        t.check('LONG_PTR', 0x11223344, m.q)

        t.section('alias in sugar（数组糖/位域糖收别名）')
        const AS = struct({
            v: 'DWORD[4]',   // 别名元素糖 → u32[4]
            f: 'DWORD:3',    // 别名位域糖 → u32:3
        })
        t.check('size == 20 (16 + 位域单元)', 20, AS.size)
        t.check('f offset == 16', 16, AS.offsetOf('f'))
        const asd = AS.decode(AS.encode({ v: [1, 2, 3, 4], f: 5 }))
        t.check('DWORD[4][1]', 2, asd.v[1])
        t.check('DWORD:3', 5, asd.f)
        expectType<Equal<ReturnType<typeof AS.decode>['f'], number>>()

        t.section('union() entry roundtrip')
        const U = union({ a: 'u8', b: 'u32' })
        t.check('union size == 4', 4, U.size)
        t.check('union offsetOf a', 0, U.offsetOf('a'))
        t.check('union offsetOf b', 0, U.offsetOf('b'))
        const ud = U.decode(U.encode({ a: 0, b: 0x01020304 }))
        t.check('union a 与 b 同偏移（低字节别名）', 0x04, ud.a)
        t.check('union b', 0x01020304, ud.b)

        t.section('union 位域完全别名 roundtrip（mingw 实测语义）')
        {
            const UB = union({ a: 'u32:1', b: 'u32:1' })
            t.check('union bitfield size == 4', 4, UB.size)
            const ud1 = UB.decode(UB.encode({ a: 1, b: 1 }))
            t.check('a=1,b=1 roundtrip a', 1, ud1.a)
            t.check('a=1,b=1 roundtrip b', 1, ud1.b)
            // 同位别名：字段按声明序写入，后写字段覆盖先写字段
            const ud2 = UB.decode(UB.encode({ a: 1, b: 0 }))
            t.check('别名覆盖：b=0 后写 → a 读 0', 0, ud2.a)
            t.check('别名覆盖：b == 0', 0, ud2.b)

            // 溢出形状（30+4>32）：union 每成员回 offset 0，曾开新单元越出 size
            const OF = union({ a: 'u32:30', b: 'u32:4' })
            t.check('overflow union size == 4', 4, OF.size)
            const od1 = OF.decode(OF.encode({ a: 0x3FFFFFFF, b: 0xF }))
            t.check('overflow roundtrip a', 0x3FFFFFFF, od1.a)
            t.check('overflow roundtrip b', 0xF, od1.b)
            const od2 = OF.decode(OF.encode({ a: 0x3FFFFFFF, b: 0 }))
            t.check('overflow 别名覆盖 → a 低 4 位被清', 0x3FFFFFF0, od2.a)

            // 位域 + 普通成员混合：b 曾被 flushUnit 推到 offset 4（越出 size 4）
            const MX = union({ a: 'u32:1', b: 'u8' })
            t.check('mixed union size == 4', 4, MX.size)
            t.check('mixed offsetOf b == 0（曾为 4）', 0, MX.offsetOf('b'))
            const md = MX.decode(MX.encode({ a: 1, b: 0x54 }))
            t.check('mixed: b 覆盖 a 所在字节 → a 读 0', 0, md.a)
            t.check('mixed: b == 0x54', 0x54, md.b)

            // 嵌套回归：struct 内嵌该 union（raw '#' 形式；union() 装饰对象不能嵌套，
            // 嵌套 union 的解码类型推导会 TS2589，沿用旧行例 as any——本条是运行时断言），
            // tail 不被 union 内错位写污染
            const nestedU: C_Union = { '#': 'union', a: 'u32:1', b: 'u8' }
            const NS = (struct as any)({ tag: 'u32', u: nestedU, tail: 'u16' })
            t.check('nested size == 12', 12, NS.size)
            const nd = NS.decode(NS.encode({ tag: 0xAABBCCDD, u: { a: 1, b: 0x54 }, tail: 0x1234 }))
            t.check('nested tag', 0xAABBCCDD, nd.tag)
            t.check('nested u.b == 0x54', 0x54, nd.u.b)
            t.check('nested tail 不被污染', 0x1234, nd.tail)
        }

        t.section('struct() entry: pack 选项 + 键尾 @N（alignas）')
        const P = struct({ a: 'u8', b: 'u32', c: 'u8' }, { pack: 1 })
        t.check('pack(1) size == 6', 6, P.size)
        t.check('pack(1) offsetOf b', 1, P.offsetOf('b'))
        const AL = struct({ a: 'u8', 'b@8': 'u32' })
        t.check('@N offsetOf a', 0, AL.offsetOf('a'))
        t.check('@N offsetOf b（字段名已剥离 @N）', 8, AL.offsetOf('b'))

        t.section('utf-16le string[8] roundtrip & truncation')
        const W = struct({name: 'u16[8]@utf-16le' })
        t.check('utf16[8].size == 16', 16, W.size)
        const wb = W.encode({ name: 'hello' })
        t.check('read back "hello"', 'hello', W.decode(wb).name)
        const lb = W.encode({ name: 'a very long string over' })
        t.check('utf16[8]: payload 7 + NUL', 'a very ', W.decode(lb).name)
        t.check('utf16 terminator[14..15] == 0', 0, new DataView(lb).getUint16(14, true))

        t.section("utf-8 string[8] roundtrip & truncation")
        const C = struct({name: 'u8[8]@utf-8' })
        t.check('char[8].size == 8', 8, C.size)
        const cb = C.encode({ name: 'hi' })
        t.check('read back "hi"', 'hi', C.decode(cb).name)
        t.check('NUL at [2]', 0, new DataView(cb).getUint8(2))
        const ctrunc = C.encode({ name: '1234567890' })
        t.check('char[8]: payload 7 + NUL', '1234567', C.decode(ctrunc).name)
        t.check('char terminator[7] == 0', 0, new DataView(ctrunc).getUint8(7))

        t.section('string sugar: 布局与解释正交（错配 roundtrip）')
        const XS = struct({ buf: 'u8[8]@utf-16le' })
        t.check('u8[8]@utf-16le size == 8（encoding 不参与布局）', 8, XS.size)
        const xsd = XS.decode(XS.encode({ buf: 'AB' }))
        t.check('8 字节按 utf-16le 解出 "AB"', 'AB', xsd.buf)

        t.section('string sugar as array element')
        const SA = struct({ rows: { '#': 'array', element: 'u16[4]@utf-16le', length: 3 } })
        t.check('string[4]×3 size == 24', 24, SA.size)
        const sad = SA.decode(SA.encode({ rows: ['ab', 'cd', 'ef'] }))
        t.check('rows[0]', 'ab', sad.rows[0])
        t.check('rows[1]', 'cd', sad.rows[1])
        expectType<Equal<ReturnType<typeof SA.decode>['rows'], [string, string, string]>>()

        t.section('键侧 alignas @N 与值侧 encoding @ 并存')
        const KV = struct({ a: 'u8', 's@8': 'u16[4]@utf-8' })
        t.check('offsetOf a', 0, KV.offsetOf('a'))
        t.check('offsetOf s（键尾 @8 生效）', 8, KV.offsetOf('s'))
        t.check('KV size == 16', 16, KV.size)

        t.section('numeric arrays roundtrip (CArray)')
        const A = struct({
            v: 'u16[4]',
            k: 'i32[2]',
        })
        t.check('size == 16', 16, A.size)
        const ab = A.encode({ v: [1, 2, 3, 4], k: [-1, 300000] })
        const ad = A.decode(ab)
        t.check('u16[0]', 1, ad.v[0])
        t.check('u16[3]', 4, ad.v[3])
        t.check('i32[0] -1', -1, ad.k[0])
        t.check('i32[1]', 300000, ad.k[1])

        t.section('T[1] stays an array (no scalar degradation)')
        const ONE = struct({v: 'u16[1]'})
        t.check('size == 2', 2, ONE.size)
        const one = ONE.decode(ONE.encode({ v: [42] }))
        t.check('length 1', 1, one.v.length)
        t.check('[0]', 42, one.v[0])

        t.section('array of struct roundtrip (stride = child size)')
        const PT = struct({
            x: 'i32',
            y: 'i32',
        })
        const POLY = struct({
            count: 'u32',
            pts: { '#': 'array', element: PT.__struct, length: 3 },
        })
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
        try { struct({v: 'i32[0]'}) } catch { rejected = true }
        t.check('array length 0 rejected', true, rejected)

        let rejectedBare = false
        try { (struct as any)({ p: 'ptr' }) } catch { rejectedBare = true }
        t.check('bare "ptr" member rejected', true, rejectedBare)

        // '#' 必填：字段值漏写 '#'（裸嵌套 map）不再默认 struct，直接 throw
        let rejectedMap = false
        try { (struct as any)({ outer: { inner: 'u32' } }) } catch { rejectedMap = true }
        t.check('bare nested map rejected（漏写 #）', true, rejectedMap)

        // 顶层 '#' 由构造器写入：字段表混入的 '#' 指令键被剔除（运行时兜底，类型层已禁）
        const H = (struct as any)({ '#': 'union', a: 'u8', b: 'u32' })
        t.check('top-level # stripped（仍按函数名 struct 布局）', 8, H.size)

        t.section("pointer member '<>ptr' raw vs '<T>ptr' branded")
        const PTR = struct({
            raw: '<>ptr',
            r: '<RECT>ptr',
            tag: 'u32',
        })
        t.check('PTR.size', is64 ? 24 : 12, PTR.size)
        t.check('offsetOf raw', 0, PTR.offsetOf('raw'))
        t.check('offsetOf r', is64 ? 8 : 4, PTR.offsetOf('r'))
        t.check('offsetOf tag', is64 ? 16 : 8, PTR.offsetOf('tag'))
        const rawOut = RECT.alloc()
        const pd = PTR.decode(PTR.encode({ raw: rawOut.ptr, r: rawOut.ptr, tag: 7 }))
        t.check('raw roundtrip', rawOut.ptr, pd.raw)
        t.check('r roundtrip', rawOut.ptr, pd.r)
        t.check('tag', 7, pd.tag)
        // 编译期：'<>ptr' → number|null（T='' 品牌退化 + 0 归一为 null）；
        // '<RECT>ptr' → Ptr<'RECT'>|null（品牌）。
        expectType<Equal<ReturnType<typeof PTR.decode>['raw'], number | null>>()
        expectType<Equal<ReturnType<typeof PTR.decode>['r'], Ptr<'RECT'> | null>>()

        t.section('f32/f64 layout (MSVC: f@0, double@8)')
        const FL = struct({
            f: 'f32',      // float
            d: 'f64',      // double
        })
        t.check('size == 16 (f@0, double aligned @8)', 16, FL.size)
        const fb = FL.encode({ f: 1.5, d: -2.25 })
        const fr = FL.decode(fb)
        t.check('float', 1.5, fr.f)
        t.check('double', -2.25, fr.d)

        t.section('comctl dialog structs track 32/64-bit ABI')
        const TCITEMW = struct({
            mask: 'u32',
            dwState: 'u32',
            dwStateMask: 'u32',
            pszText: '<>ptr',
            cchTextMax: 'i32',
            iImage: 'i32',
            lParam: '<>ptr',
        })
        t.check('TCITEMW.size', is64 ? 40 : 28, TCITEMW.size)
        t.check('TCITEMW.offsetOf pszText', is64 ? 16 : 12, TCITEMW.offsetOf('pszText'))
        t.check('TCITEMW.offsetOf cchTextMax', is64 ? 24 : 16, TCITEMW.offsetOf('cchTextMax'))

        const TTTOOLINFOW = struct({
            cbSize: 'u32',
            uFlags: 'u32',
            hwnd: '<>ptr',
            uId: '<>ptr',
            rect: 'i32[4]',
            hinst: '<>ptr',
            lpszText: '<>ptr',
            lParam: '<>ptr',
            lpReserved: '<>ptr', // WinXP+ 追加
        })
        t.check('TTTOOLINFOW.size', is64 ? 72 : 48, TTTOOLINFOW.size)
        t.check('TTTOOLINFOW.offsetOf lpszText', is64 ? 48 : 36, TTTOOLINFOW.offsetOf('lpszText'))

        const OPENFILENAMEW = struct({
            lStructSize: 'u32',
            hwndOwner: '<>ptr',
            hInstance: '<>ptr',
            lpstrFilter: '<>ptr',
            lpstrCustomFilter: '<>ptr',
            nMaxCustFilter: 'u32',
            nFilterIndex: 'u32',
            lpstrFile: '<>ptr',
            nMaxFile: 'u32',
            lpstrFileTitle: '<>ptr',
            nMaxFileTitle: 'u32',
            lpstrInitialDir: '<>ptr',
            lpstrTitle: '<>ptr',
            Flags: 'u32',
            nFileOffset: 'u16',
            nFileExtension: 'u16',
            lpstrDefExt: '<>ptr',
            lCustData: '<>ptr',
            lpfnHook: '<>ptr',
            lpTemplateName: '<>ptr',
            pvReserved: '<>ptr',
            dwReserved: 'u32',
            FlagsEx: 'u32', // Win2000+ 追加
        })
        t.check('OPENFILENAMEW.size', is64 ? 152 : 88, OPENFILENAMEW.size)
        t.check('OPENFILENAMEW.offsetOf lpstrFile', is64 ? 48 : 28, OPENFILENAMEW.offsetOf('lpstrFile'))
        t.check('OPENFILENAMEW.offsetOf Flags', is64 ? 96 : 52, OPENFILENAMEW.offsetOf('Flags'))
        t.check('OPENFILENAMEW.offsetOf lpstrTitle', is64 ? 88 : 48, OPENFILENAMEW.offsetOf('lpstrTitle'))

        const BROWSEINFOW = struct({
            hwndOwner: '<>ptr',
            pidlRoot: '<>ptr',
            pszDisplayName: '<>ptr',
            lpszTitle: '<>ptr',
            ulFlags: 'u32',
            lpfn: '<>ptr',
            lParam: '<>ptr',
            iImage: 'i32',
        })
        t.check('BROWSEINFOW.size', is64 ? 64 : 32, BROWSEINFOW.size)
        t.check('BROWSEINFOW.offsetOf lpszTitle', is64 ? 24 : 12, BROWSEINFOW.offsetOf('lpszTitle'))
        t.check('BROWSEINFOW.offsetOf ulFlags', is64 ? 32 : 16, BROWSEINFOW.offsetOf('ulFlags'))

        t.section('NMHDR（嵌套时 MSVC 尾 padding 传染）')
        const NMHDR = struct({
            hwndFrom: '<>ptr',
            idFrom: '<>ptr',
            code: 'i32',
        })
        t.check('NMHDR.size', is64 ? 24 : 12, NMHDR.size)
        t.check('NMHDR.offsetOf code', is64 ? 16 : 8, NMHDR.offsetOf('code'))

        t.section('NMCUSTOMDRAW / NMLVCUSTOMDRAW (ListView custom draw)')
        const NMCUSTOMDRAW = struct({
            hdr: NMHDR.__struct,
            dwDrawStage: 'u32',
            hdc: '<>ptr',
            rc: 'i32[4]',
            dwItemSpec: '<>ptr',
            uItemState: 'u32',
            lItemlParam: '<>ptr',
        })
        t.check('NMCUSTOMDRAW.size', is64 ? 80 : 48, NMCUSTOMDRAW.size)
        t.check('NMCUSTOMDRAW.offsetOf dwDrawStage', is64 ? 24 : 12, NMCUSTOMDRAW.offsetOf('dwDrawStage'))
        t.check('NMCUSTOMDRAW.offsetOf hdc', is64 ? 32 : 16, NMCUSTOMDRAW.offsetOf('hdc'))
        t.check('NMCUSTOMDRAW.offsetOf dwItemSpec', is64 ? 56 : 36, NMCUSTOMDRAW.offsetOf('dwItemSpec'))
        const NMLVCUSTOMDRAW = struct({
            hdr: NMHDR.__struct,
            dwDrawStage: 'u32',
            hdc: '<>ptr',
            rc: 'i32[4]',
            dwItemSpec: '<>ptr',
            uItemState: 'u32',
            lItemlParam: '<>ptr',
            clrText: 'u32',
            clrTextBk: 'u32',
            iSubItem: 'i32',
            dwItemType: 'u32',
        })
        t.check('NMLVCUSTOMDRAW.size', is64 ? 96 : 64, NMLVCUSTOMDRAW.size)
        t.check('NMLVCUSTOMDRAW.offsetOf clrText', is64 ? 80 : 48, NMLVCUSTOMDRAW.offsetOf('clrText'))
        t.check('NMLVCUSTOMDRAW.offsetOf clrTextBk', is64 ? 84 : 52, NMLVCUSTOMDRAW.offsetOf('clrTextBk'))
        t.check('NMLVCUSTOMDRAW.offsetOf iSubItem', is64 ? 88 : 56, NMLVCUSTOMDRAW.offsetOf('iSubItem'))

        t.section('NMLISTVIEW / NMITEMACTIVATE')
        const NMLISTVIEW = struct({
            hdr: NMHDR.__struct,
            iItem: 'i32',
            iSubItem: 'i32',
            uNewState: 'u32',
            uOldState: 'u32',
            uChanged: 'u32',
            ptAction: 'i32[2]',
            lParam: '<>ptr',
        })
        t.check('NMLISTVIEW.size', is64 ? 64 : 44, NMLISTVIEW.size)
        t.check('NMLISTVIEW.offsetOf iItem', is64 ? 24 : 12, NMLISTVIEW.offsetOf('iItem'))
        t.check('NMLISTVIEW.offsetOf iSubItem', is64 ? 28 : 16, NMLISTVIEW.offsetOf('iSubItem'))
        t.check('NMLISTVIEW.offsetOf uNewState', is64 ? 32 : 20, NMLISTVIEW.offsetOf('uNewState'))
        t.check('NMLISTVIEW.offsetOf uOldState', is64 ? 36 : 24, NMLISTVIEW.offsetOf('uOldState'))

        t.section('LVITEMW / LVCOLUMNW')
        const LVITEMW = struct({
            mask: 'u32',
            iItem: 'i32',
            iSubItem: 'i32',
            state: 'u32',
            stateMask: 'u32',
            pszText: '<>ptr',
            cchTextMax: 'i32',
            iImage: 'i32',
            lParam: '<>ptr',
            iIndent: 'i32',
            iGroupId: 'i32',
            cColumns: 'u32',
            puColumns: '<>ptr',
            piColFmt: '<>ptr',
            iGroup: 'i32',
        })
        t.check('LVITEMW.size', is64 ? 88 : 60, LVITEMW.size)
        t.check('LVITEMW.offsetOf iItem', 4, LVITEMW.offsetOf('iItem'))
        t.check('LVITEMW.offsetOf pszText', is64 ? 24 : 20, LVITEMW.offsetOf('pszText'))
        t.check('LVITEMW.offsetOf iImage', is64 ? 36 : 28, LVITEMW.offsetOf('iImage'))
        t.check('LVITEMW.offsetOf lParam', is64 ? 40 : 32, LVITEMW.offsetOf('lParam'))
        const LVCOLUMNW = struct({
            mask: 'u32',
            fmt: 'i32',
            cx: 'i32',
            pszText: '<>ptr',
            cchTextMax: 'i32',
            iSubItem: 'i32',
            iImage: 'i32',
            iOrder: 'i32',
            cxMin: 'i32',
            cxDefault: 'i32',
            cxIdeal: 'i32',
        })
        t.check('LVCOLUMNW.size', is64 ? 56 : 44, LVCOLUMNW.size)
        t.check('LVCOLUMNW.offsetOf pszText', is64 ? 16 : 12, LVCOLUMNW.offsetOf('pszText'))
        t.check('LVCOLUMNW.offsetOf iSubItem', is64 ? 28 : 20, LVCOLUMNW.offsetOf('iSubItem'))
        t.check('LVCOLUMNW.offsetOf iOrder', is64 ? 36 : 28, LVCOLUMNW.offsetOf('iOrder'))

        t.section('NMDATETIMECHANGE')
        const SYSTEMTIME = struct({
            wYear: 'u16',
            wMonth: 'u16',
            wDayOfWeek: 'u16',
            wDay: 'u16',
            wHour: 'u16',
            wMinute: 'u16',
            wSecond: 'u16',
            wMilliseconds: 'u16',
        })
        const NMDATETIMECHANGE = struct({
            hdr: NMHDR.__struct,
            dwFlags: 'u32',
            st: SYSTEMTIME.__struct,
        })
        t.check('NMDATETIMECHANGE.size', is64 ? 48 : 32, NMDATETIMECHANGE.size)
        t.check('NMDATETIMECHANGE.offsetOf dwFlags', is64 ? 24 : 12, NMDATETIMECHANGE.offsetOf('dwFlags'))
        t.check('NMDATETIMECHANGE.offsetOf st', is64 ? 28 : 16, NMDATETIMECHANGE.offsetOf('st'))

        t.section('NMLINK szUrl offset')
        const LITEM = struct({
            mask: 'u32',
            iLink: 'i32',
            state: 'u32',
            stateMask: 'u32',
            szID: 'u16[48]@utf-16le',
        })
        const NMLINK = struct({
            hdr: NMHDR.__struct,
            item: LITEM.__struct,
            szUrl: 'u16[2084]@utf-16le',
        })
        t.check('LITEM.offsetOf szID', 16, LITEM.offsetOf('szID'))
        t.check('NMLINK.offsetOf szUrl', is64 ? 136 : 124, NMLINK.offsetOf('szUrl'))

        // === 位域读/写往返 ===
        // 布局 ground truth 在 test_ffi_struct_layout.ts（mingw 交叉实测），这里只测读写。

        t.section('bitfield roundtrip: LSB→MSB 打包 + 读改写隔离')
        {
            // 字段按序写入同一 buffer：写 d 时单元里已有 a/b/c 的位，
            // 若 writeBitfield 不做读改写（直接 val<<bit）会把 a/b/c 清零。
            const BF = struct({
                a: 'u32:3',
                b: 'u32:5',
                c: 'u32:4',
                d: 'u32:10',   // 3+5+4+10=22 <= 32
                tail: 'u32',
            })
            t.check('BF.size == 8', 8, BF.size)
            const bd = BF.decode(BF.encode({ a: 5, b: 31, c: 15, d: 1023, tail: 0xDEAD }))
            t.check('a (LSB)', 5, bd.a)
            t.check('b', 31, bd.b)
            t.check('c', 15, bd.c)
            t.check('d (max 10-bit)', 1023, bd.d)
            t.check('tail survives bitfield unit', 0xDEAD, bd.tail)
            // 位域写不破坏同单元的邻居：a=5 后写 b=31，a 仍为 5
            t.check('a survives b write', 5, bd.a)
        }

        t.section('bitfield roundtrip: signed sign extension')
        {
            const SB = struct({
                s: 'i32:8',
                u: 'u32:4',
            })
            t.check('SB.size == 4 (同宽不分签别，共单元)', 4, SB.size)
            const sbd = SB.decode(SB.encode({ s: -5, u: 9 }))
            t.check('signed -5', -5, sbd.s)
            t.check('unsigned 9', 9, sbd.u)
            t.check('signed -1', -1, SB.decode(SB.encode({ s: -1, u: 0 })).s)
            t.check('signed 127 (min int8)', 127, SB.decode(SB.encode({ s: 127, u: 0 })).s)
            t.check('signed 128 → -128', -128, SB.decode(SB.encode({ s: 128, u: 0 })).s)
        }

        t.section('bitfield roundtrip: overflow starts a new unit')
        {
            const OV = struct({
                a: 'u32:30',
                b: 'u32:4',   // 30+4=34 > 32 → 新单元，剩余 2 位废弃
                c: 'u32',
            })
            t.check('OV.size == 12', 12, OV.size)
            t.check('OV.offsetOf b (new unit)', 4, OV.offsetOf('b'))
            t.check('OV.offsetOf c', 8, OV.offsetOf('c'))
            const ovd = OV.decode(OV.encode({ a: 0x3FFFFFFF, b: 15, c: 7 }))
            t.check('OV a (max 30-bit)', 0x3FFFFFFF, ovd.a)
            t.check('OV b', 15, ovd.b)
            t.check('OV c', 7, ovd.c)
        }

        t.section('bitfield: DCB roundtrip (Windows serial port config)')
        {
            const DCB = struct('DCB', {
                DCBlength: 'u32',
                BaudRate: 'u32',
                fBinary: 'u32:1',
                fParity: 'u32:1',
                fOutxCtsFlow: 'u32:1',
                fOutxDsrFlow: 'u32:1',
                fDtrControl: 'u32:2',
                fDsrSensitivity: 'u32:1',
                fTXContinueOnXoff: 'u32:1',
                fOutX: 'u32:1',
                fInX: 'u32:1',
                fErrorChar: 'u32:1',
                fNull: 'u32:1',
                fRtsControl: 'u32:2',
                fAbortOnError: 'u32:1',
                fDummy2: 'u32:17',
                wReserved: 'u16',
                XonLim: 'u16',
                XoffLim: 'u16',
                ByteSize: 'u8',
                Parity: 'u8',
                StopBits: 'u8',
                XonChar: 'i8',
                XoffChar: 'i8',
                ErrorChar: 'i8',
                EofChar: 'i8',
                EvtChar: 'i8',
                wReserved1: 'u16',
            })
            t.check('DCB.size == 28', 28, DCB.size)
            const d = DCB.decode(DCB.encode({
                DCBlength: 28, BaudRate: 0x1C200,
                fBinary: 1, fParity: 0, fOutxCtsFlow: 0, fOutxDsrFlow: 0,
                fDtrControl: 2, fDsrSensitivity: 1, fTXContinueOnXoff: 0,
                fOutX: 1, fInX: 0, fErrorChar: 1, fNull: 0,
                fRtsControl: 2, fAbortOnError: 1, fDummy2: 0,
                wReserved: 0, XonLim: 200, XoffLim: 100,
                ByteSize: 8, Parity: 0, StopBits: 0,
                XonChar: 3, XoffChar: 4, ErrorChar: 0xFF,
                EofChar: 3, EvtChar: 0x4, wReserved1: 0,
            }))
            t.check('DCBlength', 28, d.DCBlength)
            t.check('BaudRate', 0x1C200, d.BaudRate)
            t.check('fBinary', 1, d.fBinary)
            t.check('fParity', 0, d.fParity)
            t.check('fDtrControl', 2, d.fDtrControl)
            t.check('fDsrSensitivity', 1, d.fDsrSensitivity)
            t.check('fOutX', 1, d.fOutX)
            t.check('fRtsControl', 2, d.fRtsControl)
            t.check('fAbortOnError', 1, d.fAbortOnError)
            t.check('fDummy2', 0, d.fDummy2)
            t.check('wReserved', 0, d.wReserved)
            t.check('XonLim', 200, d.XonLim)
            t.check('XoffLim', 100, d.XoffLim)
            t.check('ByteSize', 8, d.ByteSize)
            t.check('Parity', 0, d.Parity)
            t.check('StopBits', 0, d.StopBits)
            t.check('XonChar', 3, d.XonChar)
            t.check('XoffChar', 4, d.XoffChar)
            t.check('ErrorChar (i8)', -1, d.ErrorChar)
            t.check('EofChar', 3, d.EofChar)
            t.check('EvtChar', 4, d.EvtChar)
            t.check('wReserved1', 0, d.wReserved1)
        }

        // 类型层：位域成员值类型是 number
        {
            const BF = struct({
                a: 'u32:3',
                s: 'i32:8',
            })
            expectType<Equal<ReturnType<typeof BF.decode>['a'], number>>()
            expectType<Equal<ReturnType<typeof BF.decode>['s'], number>>()
        }

        // 位域 width>53：值域装不进安全整数 → bigint（与类型层 BitShape 同界）
        t.section('bitfield width>53: bigint roundtrip (u64/i64)')
        {
            // u64:60 + u64:4 同单元混合形态：>53 的字段 bigint、≤53 的字段 number
            const W64 = struct({
                u: 'u64:60',
                v: 'u64:4',
            })
            t.check('u64:60+u64:4 size == 8（同单元）', 8, W64.size)
            t.check('v 与 u 同单元 offset == 0', 0, W64.offsetOf('v'))
            const big = 0x0FFFFFFFFFFFFFFFn    // 60 位内大值 > 2^53
            const d1 = W64.decode(W64.encode({ u: big, v: 15 }))
            t.check('u64:60 大值精确往返', big, d1.u)
            t.check('u64:4 同单元往返', 15, d1.v)
            expectType<Equal<ReturnType<typeof W64.decode>['u'], bigint>>()
            expectType<Equal<ReturnType<typeof W64.decode>['v'], number>>()

            // i64:60 负值符号扩展 → 精确 bigint（回归：曾被有符号分支的 Number() 截断）
            const I64 = struct({ s: 'i64:60' })
            const neg = -12345678901234567n
            t.check('i64:60 负值精确往返', neg, I64.decode(I64.encode({ s: neg })).s)
            // 符号位为 0 的正值：width>53 → 依然 bigint
            t.check('i64:60 正值 bigint', 100n, I64.decode(I64.encode({ s: 100n })).s)
            expectType<Equal<ReturnType<typeof I64.decode>['s'], bigint>>()
            if (false) {
                // @ts-expect-error width>53 位域收 bigint，number 被类型层拒绝
                I64.encode({ s: 42 })
            }

            // 分界：53 → number（2^53-1 精确），54 → bigint（2^54-1 精确）
            const B53 = struct({ a: 'u64:53' })
            expectType<Equal<ReturnType<typeof B53.decode>['a'], number>>()
            t.check('u64:53 边界 number 精确', 9007199254740991,
                B53.decode(B53.encode({ a: 9007199254740991 })).a)
            const B54 = struct({ a: 'u64:54' })
            expectType<Equal<ReturnType<typeof B54.decode>['a'], bigint>>()
            t.check('u64:54 边界 bigint 精确', 18014398509481983n,
                B54.decode(B54.encode({ a: 18014398509481983n })).a)
        }
    },
}
