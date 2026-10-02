import * as std from 'std'
import * as gui from 'gui'
import { Tester } from './test_helper.js'
import { bind, bindLib } from '../lib/ffi-bind.js'

// ASCII 字符串 ↔ ArrayBuffer（供 msvcrt _strtoui64/_i64toa 类函数用）
function strToBuf(s: string): ArrayBuffer {
    const b = new ArrayBuffer(s.length + 1)
    const u8 = new Uint8Array(b)
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i)
    return b
}

function bufToString(buf: ArrayBuffer): string {
    const u8 = new Uint8Array(buf)
    let s = ''
    for (let i = 0; i < u8.length && u8[i] !== 0; i++) s += String.fromCharCode(u8[i]!)
    return s
}

export const suite = {
    name: 'ffi-bind',
    run: (t: Tester) => {
        t.section('bind single proc')
        const getDC = bind('user32.dll', 'GetDC', 'ptr -> ptr')
        const dc = getDC(0)
        t.checkTrue('bind GetDC(NULL) returns screen DC', !!dc)

        t.section('bindLib batch with wchar_ptr auto-encode')
        const user32 = bindLib('user32.dll', {
            DrawTextW: 'ptr wchar_ptr i32 buf_ptr i32 -> i32',
            ReleaseDC: 'ptr ptr -> i32',
        })
        const rect = new ArrayBuffer(16)
        const dv = new DataView(rect)
        dv.setInt32(8, 500, true)
        const lines = user32.DrawTextW(dc, 'hello ffi-bind', -1, rect, gui.DrawTextFlag.CALCRECT)
        t.checkTrue('DrawTextW returns line count > 0', lines > 0)
        t.checkTrue('measured width > 0', dv.getInt32(8, true) > 0)
        t.checkTrue('measured height > 0', dv.getInt32(12, true) > 0)
        if (dc) user32.ReleaseDC(0, dc)

        t.section('signedness read-back: i32 vs u32')
        const lstrcmpI = bind('kernel32.dll', 'lstrcmpW', 'wchar_ptr wchar_ptr -> i32')
        const lstrcmpU = bind('kernel32.dll', 'lstrcmpW', 'wchar_ptr wchar_ptr -> u32')
        const setLastError = bind('kernel32.dll', 'SetLastError', 'u32 -> void')
        const getErrU = bind('kernel32.dll', 'GetLastError', ' -> u32')
        const getErrI = bind('kernel32.dll', 'GetLastError', ' -> i32')
        const ri = lstrcmpI('a', 'b')
        const ru = lstrcmpU('a', 'b')
        std.printf('  lstrcmpW("a","b"): i32=%s u32=%s\n', String(ri), String(ru))
        t.checkTrue('i32 read-back keeps negative sign', ri < 0)
        t.check('u32 read-back is 0xFFFFFFFF', 4294967295, ru)
        setLastError(0x80000000)
        const glU = getErrU()
        const glI = getErrI()
        std.printf('  GetLastError after SetLastError(0x80000000): u32=%s i32=%s\n', String(glU), String(glI))
        t.check('GetLastError u32 keeps big value', 2147483648, glU)
        t.check('GetLastError i32 reads as negative', -2147483648, glI)

        t.section('f32/f64 floating args (ffi_types[] table regression)')
        // ffi_types[] 曾把 FLOAT/DOUBLE 槽各错位一位（DOUBLE 槽指向 ffi_type_float），
        // float/double 被按 4 字节处理。f64 用 msvcrt!sqrt/atan2（三平台必有）。
        const sqrtF64 = bind('msvcrt.dll', 'sqrt', 'f64 -> f64')
        const atan2F64 = bind('msvcrt.dll', 'atan2', 'f64 f64 -> f64')
        const sq2 = sqrtF64(2.0)
        std.printf('  sqrt(2.0) = %s (expect 1.4142135623730951)\n', String(sq2))
        t.checkTrue('sqrt(2.0) close to 1.4142135623730951', Math.abs(sq2 - 1.4142135623730951) < 1e-12)
        const pa = atan2F64(1.0, 1.0)
        std.printf('  atan2(1,1) = %s (expect ~0.7853981634)\n', String(pa))
        t.checkTrue('atan2(1,1) close to PI/4', Math.abs(pa - Math.PI / 4) < 1e-12)
        // f32: gdi32!AngleArc 的 eStartAngle/eSweepAngle 是 REAL(float32)。
        // 若 FLOAT 槽仍为 NULL，ffi_prep_cif 会返回 FFI_BAD_ARGTYPE → 抛 TypeError。
        const getDCF = bind('user32.dll', 'GetDC', 'ptr -> ptr')
        const angleArc = bind('gdi32.dll', 'AngleArc', 'ptr i32 i32 u32 f32 f32 -> i32')
        const releaseDCF = bind('user32.dll', 'ReleaseDC', 'ptr ptr -> i32')
        const hdcF = getDCF(0)
        if (hdcF != 0) {
            const ok = angleArc(hdcF, 20, 20, 5, 0.0, 90.0)
            std.printf('  AngleArc(0~90) on screen DC = %s (expect 1)\n', String(ok))
            t.checkTrue('AngleArc with f32 angles succeeds', ok === 1)
            releaseDCF(0, hdcF)
        }

        t.section('kind strictness: ptr / buf_ptr / wchar_ptr')
        const setRectB = bind('user32.dll', 'SetRect', 'buf_ptr i32 i32 i32 i32 -> i32')
        const rb = new ArrayBuffer(16)
        const okR = setRectB(rb, 1, 2, 3, 4)
        t.checkTrue('buf_ptr accepts ArrayBuffer', okR !== 0)
        const rbv = new DataView(rb)
        t.check('buf_ptr writes through (left)', 1, rbv.getInt32(0, true))
        t.check('buf_ptr writes through (bottom)', 4, rbv.getInt32(12, true))

        let errPtr = ''
        try {
            (getDC as unknown as (v: unknown) => number | null)(rb)
        } catch (e) {
            errPtr = String(e)
        }
        t.checkTrue('ptr rejects ArrayBuffer, hint mentions buf_ptr', errPtr.includes('buf_ptr'))

        let errBuf = ''
        try {
            (setRectB as unknown as (v: unknown, a: number, b: number, c: number, d: number) => number)(1234, 1, 2, 3, 4)
        } catch (e) {
            errBuf = String(e)
        }
        t.checkTrue('buf_ptr rejects number, hint mentions raw address', errBuf.includes('raw address'))

        let errWstr = ''
        try {
            (lstrcmpI as unknown as (v: unknown, w: unknown) => number)(123, 456)
        } catch (e) {
            errWstr = String(e)
        }
        t.checkTrue('wchar_ptr rejects number, expects string|null', errWstr.includes('string|null'))

        t.section('bigint 64-bit kinds: u64n / i64n')
        // 用 msvcrt 的 64 位字符串转换：win11(x64) kernel32 不导出 Interlocked*64
        //（编译器 intrinsic），msvcrt.dll 三平台必有。
        const strtoui64 = bind('msvcrt.dll', '_strtoui64', 'buf_ptr buf_ptr i32 -> u64n')
        const u64Max = strtoui64(strToBuf('18446744073709551615'), null, 10)
        t.check('u64n return 2^64-1', 18446744073709551615n, u64Max)
        const u64Prec = strtoui64(strToBuf('9007199254740993'), null, 10)
        t.check('u64n return 2^53+1', 9007199254740993n, u64Prec)

        const i64toa = bind('msvcrt.dll', '_i64toa', 'i64n buf_ptr i32 -> ptr')
        const outI = new ArrayBuffer(64)
        i64toa(-9223372036854775808n, outI, 10)
        t.check('i64n arg -2^63 toa', '-9223372036854775808', bufToString(outI))
        i64toa(9007199254740993n, outI, 10)
        t.check('i64n arg 2^53+1 toa', '9007199254740993', bufToString(outI))

        const ui64toa = bind('msvcrt.dll', '_ui64toa', 'u64n buf_ptr i32 -> ptr')
        const outU = new ArrayBuffer(64)
        ui64toa(18446744073709551615n, outU, 10)
        t.check('u64n arg 2^64-1 toa', '18446744073709551615', bufToString(outU))

        let errBig = ''
        try {
            (i64toa as unknown as (v: unknown, b: unknown, rad: unknown) => unknown)(123, outI, 10)
        } catch (e) {
            errBig = String(e)
        }
        t.checkTrue('i64n rejects number', errBig.includes('bigint'))
    },
}
