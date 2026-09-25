import * as std from 'std'
import * as gui from 'gui'
import { Tester } from './test_helper.js'
import { bind, bindLib } from '../lib/ffi-bind.js'

export const suite = {
    name: 'ffi-bind',
    run: (t: Tester) => {
        t.section('bind single proc')
        const getDC = bind('user32.dll', 'GetDC', 'ptr -> ptr')
        const dc = getDC(0)
        t.checkTrue('bind GetDC(NULL) returns screen DC', !!dc)

        t.section('bindLib batch with wstr auto-encode')
        const user32 = bindLib('user32.dll', {
            DrawTextW: 'ptr wstr i32 ptr i32 -> i32',
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
        const lstrcmpI = bind('kernel32.dll', 'lstrcmpW', 'wstr wstr -> i32')
        const lstrcmpU = bind('kernel32.dll', 'lstrcmpW', 'wstr wstr -> u32')
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
    },
}
