import * as std from 'std'
import * as win from 'win'
import * as os from 'os'
import { bind } from '../lib/ffi/bind.js'
import { struct } from '../lib/ffi/struct.js'
import { NULL, PtrArrayBuffer } from '../lib/ffi/ctype.js'
import { POINT, RECT } from '../lib/windows/structs.js'
import { Tester } from './test_helper.js'

// ABI 边界回归：覆盖 REMOVE_LIBFFI_PLAN.md §4.2 的维度，全部用真实 Win32/CRT
// 函数（不新增测试专用导出）。缺函数的平台记 SKIP 而非 FAIL，避免环境差异误报。
//
// 维度 → 用例：
//   参数个数 0/1/3/4/5/6/8/12：GetTickCount/fabs/memcpy/GetLocaleInfoA/
//     SetRect/CompareStringW/WideCharToMultiByte/SetDIBitsToDevice
//   整浮混合：ldexp(f64,i32)、frexp(f64,ptr)、modf(f64,ptr)
//   前 4 全整数（RCX-R9）：GetLocaleInfoA 的 4 个参数
//   负数返回 i32/i16/i8：lstrcmpW；i64：InterlockedIncrement64
//   窄整型负值传参：abs(i8/i16/u8/u16)
//   大 64 位传参：InterlockedExchange64
//   指针 NULL：GetDC(NULL)、IsWindow(NULL)；null/undefined 不是指针合法值，应拒绝

function readAscii(buf: ArrayBuffer, len: number): string {
    const dv = new DataView(buf)
    let s = ''
    for (let i = 0; i < len; i++) {
        const c = dv.getUint8(i)
        if (c === 0) break
        s += String.fromCharCode(c)
    }
    return s
}

function has(dll: win.HMODULE | null, name: string): boolean {
    return !!dll && !!win.GetProcAddress(dll, name)
}

export const suite = {
    name: 'ffi-abi',
    run: (t: Tester) => {
        const k32 = win.LoadLibrary('kernel32.dll')
        const usr = win.LoadLibrary('user32.dll')
        const gdi = win.LoadLibrary('gdi32.dll')
        const crt = win.LoadLibrary('msvcrt.dll')

        t.section('param count 0 ( -> u32)')
        if (has(k32, 'GetTickCount')) {
            const getTickCount = bind('kernel32.dll', 'GetTickCount', ' -> u32')
            const tc = getTickCount()
            t.checkTrue('GetTickCount() > 0', tc > 0)
        } else t.skipCase('GetTickCount missing')

        t.section('param count 1 (f64 -> f64)')
        if (has(crt, 'fabs')) {
            const fabs = bind('msvcrt.dll', 'fabs', 'f64 -> f64')
            t.check('fabs(-3.5)', 3.5, fabs(-3.5))
        } else t.skipCase('fabs missing')

        t.section('param count 3 (<BYTE>ptr <BYTE>ptr u32 -> ptr)')
        if (has(crt, 'memcpy')) {
            const memcpy = bind('msvcrt.dll', 'memcpy', '<BYTE>ptr <BYTE>ptr u32 -> <>ptr')
            const srcB = new PtrArrayBuffer(8)
            const src = new Uint8Array(srcB)
            src.set([1, 2, 3, 4, 5, 6, 7, 8])
            const dstB = new PtrArrayBuffer(8)
            const dst = new Uint8Array(dstB)
            const r = memcpy(dstB, srcB, 8)
            const rd = Array.from(dst).join(',')
            t.check('memcpy copied bytes', '1,2,3,4,5,6,7,8', rd)
            t.checkTrue('memcpy returns dest ptr', typeof r === 'number' && r !== 0)
        } else t.skipCase('memcpy missing')

        t.section('param count 4 + all-int-regs (u32 u32 <BYTE>ptr i32 -> i32)')
        if (has(k32, 'GetLocaleInfoA')) {
            const getLocaleInfoA = bind('kernel32.dll', 'GetLocaleInfoA', 'u32 u32 <BYTE>ptr i32 -> i32')
            const buf = new PtrArrayBuffer(64)
            const n = getLocaleInfoA(0x0409, 0x00001001 /* LOCALE_SENGLANGUAGE */, buf, 64)
            if (n > 0) {
                const s = readAscii(buf, n)
                std.printf('  GetLocaleInfoA(0x0409, LOCALE_SENGLANGUAGE) = "%s" (%d)\n', s, n)
                t.check('en-US language name', 'English', s)
            } else t.skipCase('en-US locale unavailable')
        } else t.skipCase('GetLocaleInfoA missing')

        t.section('param count 5 (<BYTE>ptr i32 i32 i32 i32 -> i32)')
        if (has(usr, 'SetRect')) {
            const setRect = bind('user32.dll', 'SetRect', '<BYTE>ptr i32 i32 i32 i32 -> i32')
            const rc = new PtrArrayBuffer(16)
            const ok = setRect(rc, 1, 2, 30, 40)
            const dv = new DataView(rc)
            t.checkTrue('SetRect returns nonzero', ok !== 0)
            t.check('SetRect left', 1, dv.getInt32(0, true))
            t.check('SetRect top', 2, dv.getInt32(4, true))
            t.check('SetRect right', 30, dv.getInt32(8, true))
            t.check('SetRect bottom', 40, dv.getInt32(12, true))
        } else t.skipCase('SetRect missing')

        t.section('param count 6 (u32 u32 <WCHAR>ptr i32 <WCHAR>ptr i32 -> i32)')
        if (has(k32, 'CompareStringW')) {
            const compareStringW = bind('kernel32.dll', 'CompareStringW', 'u32 u32 <WCHAR>ptr i32 <WCHAR>ptr i32 -> i32')
            const r = compareStringW(0x0400 /* LOCALE_USER_DEFAULT */, 0, 'abc', -1, 'abd', -1)
            t.check('CompareStringW("abc","abd") = CSTR_LESS_THAN', 1, r)
        } else t.skipCase('CompareStringW missing')

        t.section('param count 8 (u32 u32 <WCHAR>ptr i32 <BYTE>ptr i32 <>ptr <>ptr -> i32)')
        if (has(k32, 'WideCharToMultiByte')) {
            const wideCharToMultiByte = bind('kernel32.dll', 'WideCharToMultiByte', 'u32 u32 <WCHAR>ptr i32 <BYTE>ptr i32 <>ptr <>ptr -> i32')
            const out = new PtrArrayBuffer(16)
            // 显式给长度（cchWideChar=2）避免 -1 空终止语义下返回值是否含 '\0' 的版本差异。
            const n = wideCharToMultiByte(0 /* CP_ACP */, 0, 'AB', 2, out, 16, NULL, NULL)
            t.check('WideCharToMultiByte char count', 2, n)
            t.check('converted byte 0 = A', 65, new DataView(out).getUint8(0))
            t.check('converted byte 1 = B', 66, new DataView(out).getUint8(1))
        } else t.skipCase('WideCharToMultiByte missing')

        t.section('param count 12 (SetDIBitsToDevice on memory DC)')
        if (has(gdi, 'SetDIBitsToDevice') && has(gdi, 'CreateCompatibleDC') && has(gdi, 'DeleteDC')) {
            const createCompatibleDC = bind('gdi32.dll', 'CreateCompatibleDC', '<>ptr -> <>ptr')
            const deleteDC = bind('gdi32.dll', 'DeleteDC', '<>ptr -> i32')
            const setDIBitsToDevice = bind('gdi32.dll', 'SetDIBitsToDevice',
                '<>ptr i32 i32 u32 u32 i32 i32 u32 u32 <BYTE>ptr <BYTE>ptr u32 -> i32')
            const hdc = createCompatibleDC(0)
            if (hdc) {
                const bmi = new PtrArrayBuffer(40)
                const bdv = new DataView(bmi)
                bdv.setUint32(0, 40, true)      // biSize
                bdv.setInt32(4, 1, true)        // biWidth
                bdv.setInt32(8, 1, true)        // biHeight (bottom-up)
                bdv.setUint16(12, 1, true)      // biPlanes
                bdv.setUint16(14, 32, true)     // biBitCount
                bdv.setUint32(16, 0, true)      // biCompression = BI_RGB
                const bits = new PtrArrayBuffer(4)
                const lines = setDIBitsToDevice(hdc, 0, 0, 1, 1, 0, 0, 0, 1, bits, bmi, 0 /* DIB_RGB_COLORS */)
                t.check('SetDIBitsToDevice scanlines copied', 1, lines)
                deleteDC(hdc)
            } else t.skipCase('CreateCompatibleDC returned NULL')
        } else t.skipCase('SetDIBitsToDevice/CreateCompatibleDC missing')

        t.section('int/float mix: f64 i32 -> f64')
        if (has(crt, 'ldexp')) {
            const ldexp = bind('msvcrt.dll', 'ldexp', 'f64 i32 -> f64')
            t.check('ldexp(1.5, 3)', 12.0, ldexp(1.5, 3))
        } else t.skipCase('ldexp missing')

        t.section('int/float mix: f64 <BYTE>ptr -> f64')
        if (has(crt, 'frexp')) {
            const frexp = bind('msvcrt.dll', 'frexp', 'f64 <BYTE>ptr -> f64')
            const e = new PtrArrayBuffer(4)
            const m = frexp(12.0, e)
            t.check('frexp(12).mantissa', 0.75, m)
            t.check('frexp(12).exponent', 4, new DataView(e).getInt32(0, true))
        } else t.skipCase('frexp missing')
        if (has(crt, 'modf')) {
            const modf = bind('msvcrt.dll', 'modf', 'f64 <BYTE>ptr -> f64')
            const ip = new PtrArrayBuffer(8)
            const frac = modf(3.75, ip)
            t.check('modf(3.75).frac', 0.75, frac)
            t.check('modf(3.75).int', 3.0, new DataView(ip).getFloat64(0, true))
        } else t.skipCase('modf missing')

        t.section('narrow signed args (msvcrt!abs)')
        if (has(crt, 'abs')) {
            const absI8 = bind('msvcrt.dll', 'abs', 'i8 -> i32')
            const absU8 = bind('msvcrt.dll', 'abs', 'u8 -> i32')
            const absI16 = bind('msvcrt.dll', 'abs', 'i16 -> i32')
            const absU16 = bind('msvcrt.dll', 'abs', 'u16 -> i32')
            t.check('abs(i8 -128)', 128, absI8(-128))
            t.check('abs(i8 -5)', 5, absI8(-5))
            t.check('abs(u8 200)', 200, absU8(200))
            t.check('abs(i16 -300)', 300, absI16(-300))
            t.check('abs(u16 60000)', 60000, absU16(60000))
        } else t.skipCase('abs missing')

        t.section('negative return i32/i16/i8 (lstrcmpW)')
        if (has(k32, 'lstrcmpW')) {
            const cmpI32 = bind('kernel32.dll', 'lstrcmpW', '<WCHAR>ptr <WCHAR>ptr -> i32')
            const cmpI16 = bind('kernel32.dll', 'lstrcmpW', '<WCHAR>ptr <WCHAR>ptr -> i16')
            const cmpI8 = bind('kernel32.dll', 'lstrcmpW', '<WCHAR>ptr <WCHAR>ptr -> i8')
            t.checkTrue('lstrcmpW i32 < 0', cmpI32('a', 'b') < 0)
            t.checkTrue('lstrcmpW i16 < 0', cmpI16('a', 'b') < 0)
            t.checkTrue('lstrcmpW i8 < 0', cmpI8('a', 'b') < 0)
        } else t.skipCase('lstrcmpW missing')

        t.section('negative return i64 (InterlockedIncrement64)')
        if (has(k32, 'InterlockedExchange64') && has(k32, 'InterlockedIncrement64')) {
            const exchange64 = bind('kernel32.dll', 'InterlockedExchange64', '<BYTE>ptr i64 -> i64')
            const increment64 = bind('kernel32.dll', 'InterlockedIncrement64', '<BYTE>ptr -> i64')
            const cell = new PtrArrayBuffer(8)
            exchange64(cell, -2n)
            t.check('InterlockedIncrement64(-2)', -1n, increment64(cell))
        } else t.skipCase('Interlocked*64 missing')

        t.section('64-bit arg transport (InterlockedExchange64)')
        if (has(k32, 'InterlockedExchange64')) {
            const exchange64 = bind('kernel32.dll', 'InterlockedExchange64', '<BYTE>ptr i64 -> i64')
            const cell = new PtrArrayBuffer(8)
            const prev0 = exchange64(cell, 4294967297n)  // 2^32+1：超过 32 位
            const prev1 = exchange64(cell, -1n)          // 64 位全 1
            const prev2 = exchange64(cell, 0n)
            t.check('exchange empty cell returns 0', 0n, prev0)
            t.check('exchange returns 2^32+1', 4294967297n, prev1)
            t.check('exchange returns -1', -1n, prev2)
        } else t.skipCase('InterlockedExchange64 missing')

        t.section('ptr NULL/undefined')
        if (has(usr, 'GetDC') && has(usr, 'IsWindow')) {
            const getDC = bind('user32.dll', 'GetDC', '<>ptr -> <>ptr')
            const isWindow = bind('user32.dll', 'IsWindow', '<>ptr -> i32')
            t.checkTrue('GetDC(NULL) non-null', !!getDC(NULL))
            // undefined / null 不是指针合法值（指针只收 NULL 或有效地址），必须拒绝而非静默当 0。
            let errUndef = ''
            try {
                (getDC as unknown as (v: unknown) => number)(undefined)
            } catch (e) {
                errUndef = String(e)
            }
            t.checkTrue('GetDC(undefined) rejected', errUndef.includes('undefined'))
            t.check('IsWindow(NULL) = FALSE', 0, isWindow(NULL))
        } else t.skipCase('GetDC/IsWindow missing')

        t.section('by-value struct arg: <POINT> (slot value, not a pointer)')
        if (has(usr, 'PtInRect') && has(usr, 'WindowFromPoint') && has(usr, 'ChildWindowFromPointEx')) {
            // PtInRect(rect, pt)：RECT 按指针、POINT 按值（x64 位置寄存器 / ia32 压 8 字节上栈）。
            // 非对称矩形 {0,0,10,100} —— 若 x/y 在打包中交换，(99,5) 与 (5,99) 的判定会互换，
            // 本段即可抓出「槽内是地址而非值」「字段顺序/位置错」两类 ABI 错误。
            const ptInRect = bind('user32.dll', 'PtInRect', '<RECT>ptr <POINT> -> i32', { RECT, POINT })
            const rectOut = RECT.alloc()
            const rdv = new DataView(rectOut)
            rdv.setInt32(8, 10, true)     // right（left/top = 0，零填充）
            rdv.setInt32(12, 100, true)   // bottom
            t.check('PtInRect inside (5,5)', 1, ptInRect(rectOut.ptr, { x: 5, y: 5 }))
            t.check('PtInRect inside (5,99)', 1, ptInRect(rectOut.ptr, { x: 5, y: 99 }))
            t.check('PtInRect outside (99,5) — swap-sensitive', 0, ptInRect(rectOut.ptr, { x: 99, y: 5 }))
            t.check('PtInRect outside x=10 (right edge exclusive)', 0, ptInRect(rectOut.ptr, { x: 10, y: 5 }))

            // 位置 1（首参即结构）：WindowFromPoint(POINT) → 屏内必非 NULL
            const getSystemMetrics = bind('user32.dll', 'GetSystemMetrics', 'i32 -> i32')
            const cx = getSystemMetrics(0)      // SM_CXSCREEN
            const cy = getSystemMetrics(1)      // SM_CYSCREEN
            const windowFromPoint = bind('user32.dll', 'WindowFromPoint', '<POINT> -> <>ptr', { POINT })
            t.checkTrue('WindowFromPoint(screen center) non-null', !!windowFromPoint({ x: cx >> 1, y: cy >> 1 }))

            // 位置 2 + 其后参数推移（POINT 之后还有 UINT flags —— 槽宽算错会把 flags 读错位）
            const childFromPointEx = bind('user32.dll', 'ChildWindowFromPointEx', '<>ptr <POINT> u32 -> <>ptr', { POINT })
            const getDesktopWindow = bind('user32.dll', 'GetDesktopWindow', ' -> <>ptr')
            const desk = getDesktopWindow()
            t.checkTrue('ChildWindowFromPointEx inside → non-null', !!childFromPointEx(desk, { x: 1, y: 1 }, 0 /* CWP_ALL */))
            t.check('ChildWindowFromPointEx outside → NULL', 0, childFromPointEx(desk, { x: cx + 100, y: cy + 100 }, 0 /* CWP_ALL */))
        } else t.skipCase('PtInRect/WindowFromPoint/ChildWindowFromPointEx missing')

        t.section('by-value struct >8B / odd size: x64 by-reference (caller temp)')
        if (os.arch === 'x64' && has(crt, 'memcpy')) {
            // MS x64：size ∉ {1,2,4,8} 的聚合体按引用传 —— 槽内是指向 caller 分配的
            // 16 字节对齐临时副本的指针（单参数永不跨寄存器）。memcpy 第 2 参语义即
            // 「源地址」，借它白盒验证整条 by-ref 路径：若槽内不是合法副本地址、或
            // 字节未写进副本，拷回内容必错。ia32 按值恒把字节压栈（callee 读地址会
            // 拿到垃圾值），故本段 x64 限定；ia32 侧由上面真实 API 段覆盖栈上传值。
            const BYVAL12 = struct('BYVAL12', { a: 'u32', b: 'u32', c: 'u32' })
            const BYVAL3 = struct('BYVAL3', { p: 'u8', q: 'u8', r: 'u8' })
            const cp12 = bind('msvcrt.dll', 'memcpy', '<BYTE>ptr <BYVAL12> u32 -> <>ptr', { BYVAL12 })
            const cp3 = bind('msvcrt.dll', 'memcpy', '<BYTE>ptr <BYVAL3> u32 -> <>ptr', { BYVAL3 })
            const d12 = new PtrArrayBuffer(12)
            cp12(d12, { a: 1, b: 0x11223344, c: 0x7fffffff }, 12)
            const dv12 = new DataView(d12)
            t.check('12B (>8B) by-ref word 0', 1, dv12.getUint32(0, true))
            t.check('12B (>8B) by-ref word 1', 0x11223344, dv12.getUint32(4, true))
            t.check('12B (>8B) by-ref word 2', 0x7fffffff, dv12.getUint32(8, true))
            const d3 = new PtrArrayBuffer(3)
            cp3(d3, { p: 0xaa, q: 0xbb, r: 0xcc }, 3)
            t.check('3B (odd size) by-ref bytes', 'AA,BB,CC',
                Array.from(new Uint8Array(d3)).map(x => x.toString(16).toUpperCase()).join(','))
        } else t.skipCase('by-ref path: x64-only whitebox (ia32 pushes value bytes verbatim)')
    },
}
