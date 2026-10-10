import * as os from 'os'
import * as gui from 'gui'
import { NULL, PtrArrayBuffer } from '../lib/ffi/ctype.js'
import {
    RegCloseKey, RegCreateKeyEx, RegDeleteKey, RegOpenKeyEx,
    RegQueryValueEx, RegSetValueEx,
} from '../lib/windows/advapi32.js'
import { Tester } from './test_helper.js'

// 跨架构读指针宽句柄（ia32 4B / x64 8B）—— 照 test_ffi.ts 的 readPtr 先例
function readPtr(dv: DataView, offset: number): number {
    if (os.arch === 'ia32') {
        return dv.getUint32(offset, true)
    }
    const low = dv.getUint32(offset, true)
    const high = dv.getUint32(offset + 4, true)
    return low + high * 4294967296
}

// REG_SZ 数据 = UTF-16LE 含结尾 NUL；读回按字节数截到 NUL
function wbuf(s: string) {
    const p = new PtrArrayBuffer((s.length + 1) * 2)
    const dv = new DataView(p)
    for (let i = 0; i <= s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), true)
    return p
}
function wstr(dv: DataView, bytes: number): string {
    let out = ''
    for (let i = 0; i + 1 < bytes; i += 2) {
        const ch = dv.getUint16(i, true)
        if (!ch) break
        out += String.fromCharCode(ch)
    }
    return out
}

// 测试键：HKCU\Software\QuickWinTest（suite 结束时删除；中途 FAIL 会在下次 run 时复用）
const KEY = 'Software\\QuickWinTest'
const MSG = 'hello registry'

export const suite = {
    name: 'registry',
    run: (t: Tester) => {
        t.section('RegCreateKeyEx: create test key under HKCU')
        const phk = new PtrArrayBuffer(8)
        // hKey 位双来源：预定义键常量（HKEY_CURRENT_USER = 0x80000001 的 i32 形）
        // 或真实句柄——裸 <>ptr 位收两者；符号/零扩展语义由本调用实测检验
        const rcCreate = RegCreateKeyEx(gui.HKey.CURRENT_USER, KEY, 0, NULL, 0,
            gui.RegAccess.ALL_ACCESS, NULL, phk, NULL)
        t.check('create key = ERROR_SUCCESS', 0, rcCreate)
        if (rcCreate !== 0) return                          // 基座失败，后续无意义
        const hkey = readPtr(new DataView(phk), 0)
        t.checkTrue(`key handle non-null (${hkey})`, hkey !== 0)

        t.section('RegSetValueEx + RegQueryValueEx: REG_SZ roundtrip')
        const data = wbuf(MSG)
        t.check('set REG_SZ = ERROR_SUCCESS', 0,
            RegSetValueEx(hkey, 'greeting', 0, gui.RegType.SZ, data, (MSG.length + 1) * 2))
        const pType = new PtrArrayBuffer(4)
        const pCb = new PtrArrayBuffer(4)
        const pData = new PtrArrayBuffer(64)
        new DataView(pCb).setUint32(0, 64, true)            // 双向 lpcbData：入 = 缓冲大小须预写
        t.check('query = ERROR_SUCCESS', 0,
            RegQueryValueEx(hkey, 'greeting', NULL, pType, pData, pCb))
        t.check('type = REG_SZ', 1, new DataView(pType).getUint32(0, true))
        t.check('size = (len+1)*2', (MSG.length + 1) * 2, new DataView(pCb).getUint32(0, true))
        t.check('data roundtrip', MSG, wstr(new DataView(pData), (MSG.length + 1) * 2))

        t.section('RegQueryValueEx: size probe (lpData = NULL)')
        new DataView(pCb).setUint32(0, 0, true)             // 预写 0：只查类型/尺寸
        t.check('probe = ERROR_SUCCESS', 0,
            RegQueryValueEx(hkey, 'greeting', NULL, NULL, NULL, pCb))
        t.check('probe size', (MSG.length + 1) * 2, new DataView(pCb).getUint32(0, true))

        t.section('RegOpenKeyEx: reopen + missings')
        const phk2 = new PtrArrayBuffer(8)
        t.check('reopen = ERROR_SUCCESS', 0,
            RegOpenKeyEx(gui.HKey.CURRENT_USER, KEY, 0, gui.RegAccess.READ, phk2))
        const hkey2 = readPtr(new DataView(phk2), 0)
        t.check('missing value → ERROR_FILE_NOT_FOUND', 2,
            RegQueryValueEx(hkey2, 'no-such-value', NULL, NULL, NULL, NULL))
        t.check('missing key → ERROR_FILE_NOT_FOUND', 2,
            RegOpenKeyEx(gui.HKey.CURRENT_USER, KEY + 'X', 0, gui.RegAccess.READ,
                new PtrArrayBuffer(8)))
        RegCloseKey(hkey2)

        t.section('RegDeleteKey + RegCloseKey: cleanup')
        t.check('delete key = ERROR_SUCCESS', 0,
            RegDeleteKey(gui.HKey.CURRENT_USER, KEY))
        t.check('close = ERROR_SUCCESS', 0, RegCloseKey(hkey))
        t.check('open deleted → ERROR_FILE_NOT_FOUND', 2,
            RegOpenKeyEx(gui.HKey.CURRENT_USER, KEY, 0, gui.RegAccess.READ,
                new PtrArrayBuffer(8)))
    },
}
