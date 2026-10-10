import * as ffi from 'ffi'
import * as os from 'os'
import { WCHAR } from '../lib/ffi/bind.js'
import { NULL, PtrArrayBuffer, type Ptr } from '../lib/ffi/ctype.js'
import {
    FormatMessage, GetComputerName, GetEnvironmentVariable, GetLocalTime,
    GetModuleFileName, GetSystemDirectory, GetSystemTimeAsFileTime, GlobalAlloc,
    GlobalLock, GlobalUnlock, QueryPerformanceCounter, QueryPerformanceFrequency,
    RtlMoveMemory, Sleep,
} from '../lib/windows/kernel32.js'
import {
    CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard,
    RegisterClipboardFormat, SetClipboardData,
} from '../lib/windows/user32.js'
import {
    GetFileVersionInfoSize, GetFileVersionInfo, VerQueryValue,
} from '../lib/windows/version.js'
import { SYSTEMTIME } from '../lib/windows/structs.js'
import { Tester } from './test_helper.js'

// 进程内存跟进读：ffi 只有 readByte（无 DataView/写通道），u32 小端拼值 / 指针随位宽
// （| 是有符号 32 位运算，>>> 0 归一无符号——0xFEEF04BD 类高位值否则读成负数）
function readU32At(addr: number): number {
    return (ffi.readByte(addr) | (ffi.readByte(addr + 1) << 8) |
        (ffi.readByte(addr + 2) << 16) | (ffi.readByte(addr + 3) << 24)) >>> 0
}
function readPtr(dv: DataView, offset: number): number {
    if (os.arch === 'ia32') return dv.getUint32(offset, true)
    return dv.getUint32(offset, true) + dv.getUint32(offset + 4, true) * 4294967296
}

export const suite = {
    name: 'sysinfo',
    run: (t: Tester) => {
        t.section('QueryPerformanceCounter: frequency + monotonic')
        const freqB = new PtrArrayBuffer(8)
        t.checkTrue('QueryPerformanceFrequency ok', QueryPerformanceFrequency(freqB) !== 0)
        const freq = new DataView(freqB).getBigInt64(0, true)
        t.checkTrue(`frequency sane (${freq})`, freq > 0n)
        const c1 = new PtrArrayBuffer(8)
        const c2 = new PtrArrayBuffer(8)
        QueryPerformanceCounter(c1)
        QueryPerformanceCounter(c2)
        const v1 = new DataView(c1).getBigInt64(0, true)
        const v2 = new DataView(c2).getBigInt64(0, true)
        t.checkTrue(`counter monotonic (${v1} <= ${v2})`, v1 <= v2)

        t.section('Sleep: QPC-measured elapsed lands in interval')
        QueryPerformanceCounter(c1)
        Sleep(50)
        QueryPerformanceCounter(c2)
        const elapsedMs = Number((new DataView(c2).getBigInt64(0, true) -
            new DataView(c1).getBigInt64(0, true)) * 1000n / freq)
        t.checkTrue(`Sleep(50) -> ${elapsedMs}ms in [30, 3000)`, elapsedMs >= 30 && elapsedMs < 3000)

        t.section('GetLocalTime / GetSystemTimeAsFileTime')
        const st = SYSTEMTIME.alloc()
        GetLocalTime(st.ptr)
        const got = SYSTEMTIME.decode(st)
        t.checkTrue(`year sane (${got.wYear})`, got.wYear >= 2024 && got.wYear <= 2100)
        t.checkTrue(`month sane (${got.wMonth})`, got.wMonth >= 1 && got.wMonth <= 12)
        const ftB = new PtrArrayBuffer(8)
        GetSystemTimeAsFileTime(ftB)
        const ft = new DataView(ftB).getBigUint64(0, true)
        t.checkTrue(`FILETIME > 0 (${ft})`, ft > 0n)

        t.section('env / computer name / module path')
        const pathW = WCHAR.alloc(4096)
        const pathLen = GetEnvironmentVariable('PATH', pathW, 4096)
        t.checkTrue(`PATH non-empty (${pathLen} chars)`, pathLen > 0)
        const nameW = WCHAR.alloc(260)
        const nameLenB = new PtrArrayBuffer(4)
        new Uint32Array(nameLenB)[0] = 260
        t.checkTrue('GetComputerName ok', GetComputerName(nameW, nameLenB) !== 0)
        const compName = WCHAR.decode(nameW)
        t.checkTrue(`computer name non-empty (${compName})`, compName.length > 0)
        const modW = WCHAR.alloc(520)
        const modLen = GetModuleFileName(NULL, modW, 520)
        const modPath = WCHAR.decode(modW)
        t.checkTrue(`exe path has qwin (${modLen > 0})`, /qwin/i.test(modPath))

        t.section('FormatMessage: error 2 -> readable text')
        const msgW = WCHAR.alloc(512)
        const msgLen = FormatMessage(0x1200 /* FROM_SYSTEM | IGNORE_INSERTS */,
            NULL, 2 /* ERROR_FILE_NOT_FOUND */, 0, msgW, 512, NULL)
        // 语言无关断言（VM 中/英文系统都可过）：错误 2 的系统文字必然 > 4 字符
        t.checkTrue(`error 2 message non-empty (${msgLen} chars)`, msgLen > 4)

        t.section('clipboard roundtrip: CF_UNICODETEXT (GlobalAlloc/RtlMoveMemory)')
        t.checkTrue('OpenClipboard', OpenClipboard(NULL) !== 0)
        t.checkTrue('EmptyClipboard', EmptyClipboard() !== 0)
        const clipText = 'QuickWin clip roundtrip 你好'
        const clipSrc = WCHAR.encode(clipText)             // 自带 NUL 终止
        const hMem = GlobalAlloc(0x2 /* GMEM_MOVEABLE */, clipSrc.byteLength)
        t.checkTrue(`GlobalAlloc valid (${hMem})`, hMem !== 0)
        const clipDst = GlobalLock(hMem)
        t.checkTrue(`GlobalLock address (${clipDst})`, clipDst !== 0)
        RtlMoveMemory(clipDst, clipSrc, clipSrc.byteLength)
        GlobalUnlock(hMem)
        const setR = SetClipboardData(13 /* CF_UNICODETEXT */, hMem)
        t.checkTrue('SetClipboardData (ownership -> system)', setR !== 0)
        CloseClipboard()
        t.checkTrue('OpenClipboard (read back)', OpenClipboard(NULL) !== 0)
        const hRead = GetClipboardData(13)
        t.checkTrue('GetClipboardData handle', hRead !== 0)
        const pRead = hRead ? GlobalLock(hRead) : 0
        const back = pRead ? WCHAR.decode(pRead as Ptr<'WCHAR'>) : ''
        if (pRead) GlobalUnlock(hRead)
        CloseClipboard()
        t.check('clip text roundtrip', clipText, back)
        t.checkTrue('RegisterClipboardFormat', RegisterClipboardFormat('QuickWinClipFmt') !== 0)

        t.section('version resource of kernel32.dll')
        const sysW = WCHAR.alloc(300)
        GetSystemDirectory(sysW, 300)                       // 尾不带反斜杠
        const k32Path = `${WCHAR.decode(sysW)}\\kernel32.dll`
        const hB = new PtrArrayBuffer(4)
        const vSize = GetFileVersionInfoSize(k32Path, hB)
        t.checkTrue(`version size > 0 (${vSize})`, vSize > 0)
        if (vSize > 0) {
            const vHandle = new Uint32Array(hB)[0]!
            const vBuf = new PtrArrayBuffer(vSize)
            t.checkTrue('GetFileVersionInfo', GetFileVersionInfo(k32Path, vHandle, vSize, vBuf) !== 0)
            const pBuf = new PtrArrayBuffer(8)
            const pLen = new PtrArrayBuffer(4)
            t.checkTrue('VerQueryValue root block', VerQueryValue(vBuf, '\\', pBuf, pLen) !== 0)
            const rootAddr = readPtr(new DataView(pBuf), 0)
            const rootLen = new Uint32Array(pLen)[0]
            t.checkTrue(`VS_FIXEDFILEINFO len >= 52 (${rootLen})`, rootLen! >= 52)
            t.check('VS_FIXEDFILEINFO signature', 0xfeef04bd, readU32At(rootAddr))
            const fms = readU32At(rootAddr + 8)
            const fls = readU32At(rootAddr + 12)
            const ver = `${fms >>> 16}.${fms & 0xffff}.${fls >>> 16}.${fls & 0xffff}`
            t.checkTrue(`file version sane (${ver})`, fms !== 0 || fls !== 0)
        }
    },
}
