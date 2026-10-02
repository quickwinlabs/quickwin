import * as std from 'std'
import * as win from 'win'
import { bind } from '../lib/ffi-bind.js'
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
//   指针 NULL：GetDC(null/undefined)、IsWindow(null)

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

        t.section('param count 3 (buf_ptr buf_ptr u32 -> ptr)')
        if (has(crt, 'memcpy')) {
            const memcpy = bind('msvcrt.dll', 'memcpy', 'buf_ptr buf_ptr u32 -> ptr')
            const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
            const dst = new Uint8Array(8)
            const r = memcpy(dst.buffer as ArrayBuffer, src.buffer as ArrayBuffer, 8)
            const rd = Array.from(new Uint8Array(dst.buffer as ArrayBuffer)).join(',')
            t.check('memcpy copied bytes', '1,2,3,4,5,6,7,8', rd)
            t.checkTrue('memcpy returns dest ptr', typeof r === 'number' && r !== 0)
        } else t.skipCase('memcpy missing')

        t.section('param count 4 + all-int-regs (u32 u32 buf_ptr i32 -> i32)')
        if (has(k32, 'GetLocaleInfoA')) {
            const getLocaleInfoA = bind('kernel32.dll', 'GetLocaleInfoA', 'u32 u32 buf_ptr i32 -> i32')
            const buf = new ArrayBuffer(64)
            const n = getLocaleInfoA(0x0409, 0x00001001 /* LOCALE_SENGLANGUAGE */, buf, 64)
            if (n > 0) {
                const s = readAscii(buf, n)
                std.printf('  GetLocaleInfoA(0x0409, LOCALE_SENGLANGUAGE) = "%s" (%d)\n', s, n)
                t.check('en-US language name', 'English', s)
            } else t.skipCase('en-US locale unavailable')
        } else t.skipCase('GetLocaleInfoA missing')

        t.section('param count 5 (buf_ptr i32 i32 i32 i32 -> i32)')
        if (has(usr, 'SetRect')) {
            const setRect = bind('user32.dll', 'SetRect', 'buf_ptr i32 i32 i32 i32 -> i32')
            const rc = new ArrayBuffer(16)
            const ok = setRect(rc, 1, 2, 30, 40)
            const dv = new DataView(rc)
            t.checkTrue('SetRect returns nonzero', ok !== 0)
            t.check('SetRect left', 1, dv.getInt32(0, true))
            t.check('SetRect top', 2, dv.getInt32(4, true))
            t.check('SetRect right', 30, dv.getInt32(8, true))
            t.check('SetRect bottom', 40, dv.getInt32(12, true))
        } else t.skipCase('SetRect missing')

        t.section('param count 6 (u32 u32 wchar_ptr i32 wchar_ptr i32 -> i32)')
        if (has(k32, 'CompareStringW')) {
            const compareStringW = bind('kernel32.dll', 'CompareStringW', 'u32 u32 wchar_ptr i32 wchar_ptr i32 -> i32')
            const r = compareStringW(0x0400 /* LOCALE_USER_DEFAULT */, 0, 'abc', -1, 'abd', -1)
            t.check('CompareStringW("abc","abd") = CSTR_LESS_THAN', 1, r)
        } else t.skipCase('CompareStringW missing')

        t.section('param count 8 (u32 u32 wchar_ptr i32 buf_ptr i32 ptr ptr -> i32)')
        if (has(k32, 'WideCharToMultiByte')) {
            const wideCharToMultiByte = bind('kernel32.dll', 'WideCharToMultiByte', 'u32 u32 wchar_ptr i32 buf_ptr i32 ptr ptr -> i32')
            const out = new ArrayBuffer(16)
            // 显式给长度（cchWideChar=2）避免 -1 空终止语义下返回值是否含 '\0' 的版本差异。
            const n = wideCharToMultiByte(0 /* CP_ACP */, 0, 'AB', 2, out, 16, null, null)
            t.check('WideCharToMultiByte char count', 2, n)
            t.check('converted byte 0 = A', 65, new DataView(out).getUint8(0))
            t.check('converted byte 1 = B', 66, new DataView(out).getUint8(1))
        } else t.skipCase('WideCharToMultiByte missing')

        t.section('param count 12 (SetDIBitsToDevice on memory DC)')
        if (has(gdi, 'SetDIBitsToDevice') && has(gdi, 'CreateCompatibleDC') && has(gdi, 'DeleteDC')) {
            const createCompatibleDC = bind('gdi32.dll', 'CreateCompatibleDC', 'ptr -> ptr')
            const deleteDC = bind('gdi32.dll', 'DeleteDC', 'ptr -> i32')
            const setDIBitsToDevice = bind('gdi32.dll', 'SetDIBitsToDevice',
                'ptr i32 i32 u32 u32 i32 i32 u32 u32 buf_ptr buf_ptr u32 -> i32')
            const hdc = createCompatibleDC(0)
            if (hdc) {
                const bmi = new ArrayBuffer(40)
                const bdv = new DataView(bmi)
                bdv.setUint32(0, 40, true)      // biSize
                bdv.setInt32(4, 1, true)        // biWidth
                bdv.setInt32(8, 1, true)        // biHeight (bottom-up)
                bdv.setUint16(12, 1, true)      // biPlanes
                bdv.setUint16(14, 32, true)     // biBitCount
                bdv.setUint32(16, 0, true)      // biCompression = BI_RGB
                const bits = new ArrayBuffer(4)
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

        t.section('int/float mix: f64 buf_ptr -> f64')
        if (has(crt, 'frexp')) {
            const frexp = bind('msvcrt.dll', 'frexp', 'f64 buf_ptr -> f64')
            const e = new ArrayBuffer(4)
            const m = frexp(12.0, e)
            t.check('frexp(12).mantissa', 0.75, m)
            t.check('frexp(12).exponent', 4, new DataView(e).getInt32(0, true))
        } else t.skipCase('frexp missing')
        if (has(crt, 'modf')) {
            const modf = bind('msvcrt.dll', 'modf', 'f64 buf_ptr -> f64')
            const ip = new ArrayBuffer(8)
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
            const cmpI32 = bind('kernel32.dll', 'lstrcmpW', 'wchar_ptr wchar_ptr -> i32')
            const cmpI16 = bind('kernel32.dll', 'lstrcmpW', 'wchar_ptr wchar_ptr -> i16')
            const cmpI8 = bind('kernel32.dll', 'lstrcmpW', 'wchar_ptr wchar_ptr -> i8')
            t.checkTrue('lstrcmpW i32 < 0', cmpI32('a', 'b') < 0)
            t.checkTrue('lstrcmpW i16 < 0', cmpI16('a', 'b') < 0)
            t.checkTrue('lstrcmpW i8 < 0', cmpI8('a', 'b') < 0)
        } else t.skipCase('lstrcmpW missing')

        t.section('negative return i64 (InterlockedIncrement64)')
        if (has(k32, 'InterlockedExchange64') && has(k32, 'InterlockedIncrement64')) {
            const exchange64 = bind('kernel32.dll', 'InterlockedExchange64', 'buf_ptr i64 -> i64')
            const increment64 = bind('kernel32.dll', 'InterlockedIncrement64', 'buf_ptr -> i64')
            const cell = new ArrayBuffer(8)
            exchange64(cell, -2)
            t.check('InterlockedIncrement64(-2)', -1, increment64(cell))
        } else t.skipCase('Interlocked*64 missing')

        t.section('64-bit arg transport (InterlockedExchange64)')
        if (has(k32, 'InterlockedExchange64')) {
            const exchange64 = bind('kernel32.dll', 'InterlockedExchange64', 'buf_ptr i64 -> i64')
            const cell = new ArrayBuffer(8)
            const prev0 = exchange64(cell, 4294967297)  // 2^32+1：超过 32 位
            const prev1 = exchange64(cell, -1)          // 64 位全 1
            const prev2 = exchange64(cell, 0)
            t.check('exchange empty cell returns 0', 0, prev0)
            t.check('exchange returns 2^32+1', 4294967297, prev1)
            t.check('exchange returns -1', -1, prev2)
        } else t.skipCase('InterlockedExchange64 missing')

        t.section('ptr NULL/undefined')
        if (has(usr, 'GetDC') && has(usr, 'IsWindow')) {
            const getDC = bind('user32.dll', 'GetDC', 'ptr -> ptr')
            const isWindow = bind('user32.dll', 'IsWindow', 'ptr -> i32')
            t.checkTrue('GetDC(null) non-null', !!getDC(null))
            t.checkTrue('GetDC(undefined) non-null', !!getDC(undefined as unknown as null))
            t.check('IsWindow(null) = FALSE', 0, isWindow(null))
        } else t.skipCase('GetDC/IsWindow missing')
    },
}
