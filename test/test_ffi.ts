import * as std from 'std'
import * as win from 'win'
import * as ffi from 'ffi'
import * as os from 'os'
import { Tester } from './test_helper.js'

const MAX_WCHARS = 4096

function decodeWideAtPtr(ptr: number): string {
    if (!ptr) return ''
    const chars: number[] = []
    let pos = ptr
    while (chars.length < MAX_WCHARS) {
        const low = ffi.readByte(pos)
        const high = ffi.readByte(pos + 1)
        const ch = low + high * 256
        if (ch === 0) break
        chars.push(ch)
        pos += 2
    }
    return String.fromCharCode(...chars)
}

function readPtr(dv: DataView, offset: number): number {
    if (os.arch === 'ia32') {
        return dv.getUint32(offset, true)
    }
    const low = dv.getUint32(offset, true)
    const high = dv.getUint32(offset + 4, true)
    return low + high * 4294967296
}

const STATUS_FLAGS: [number, string][] = [
    [0x00000001, 'PAUSED'],
    [0x00000002, 'ERROR'],
    [0x00000004, 'PENDING_DELETION'],
    [0x00000008, 'PAPER_JAM'],
    [0x00000010, 'PAPER_OUT'],
    [0x00000020, 'MANUAL_FEED'],
    [0x00000040, 'PAPER_PROBLEM'],
    [0x00000080, 'OFFLINE'],
    [0x00000100, 'IO_ACTIVE'],
    [0x00000200, 'BUSY'],
    [0x00000400, 'PRINTING'],
    [0x00000800, 'OUTPUT_BIN_FULL'],
    [0x00001000, 'NOT_AVAILABLE'],
    [0x00002000, 'WAITING'],
    [0x00004000, 'PROCESSING'],
    [0x00008000, 'INITIALIZING'],
    [0x00010000, 'WARMING_UP'],
    [0x00020000, 'TONER_LOW'],
    [0x00040000, 'NO_TONER'],
    [0x00080000, 'PAGE_PUNT'],
    [0x00100000, 'USER_INTERVENTION'],
    [0x00200000, 'OUT_OF_MEMORY'],
    [0x00400000, 'DOOR_OPEN'],
    [0x00800000, 'SERVER_UNKNOWN'],
    [0x01000000, 'POWER_SAVE'],
    [0x02000000, 'SERVER_OFFLINE'],
    [0x04000000, 'DRIVER_UPDATE'],
];

function formatStatus(status: number): string {
    if (status === 0) return 'OK'
    const parts: string[] = []
    for (const [flag, name] of STATUS_FLAGS) {
        if (status & flag) parts.push(name)
    }
    return parts.join('|') || 'UNKNOWN'
}

export const suite = {
    name: 'ffi',
    run: (t: Tester) => {
        t.section('EnumPrintersW')
        const hWinspool = win.LoadLibrary('winspool.drv')
        t.checkTrue('LoadLibrary("winspool.drv") succeeds', hWinspool !== null)
        if (!hWinspool) return

        const enumPrinters = win.GetProcAddress(hWinspool, 'EnumPrintersW')
        t.checkTrue('GetProcAddress("EnumPrintersW") succeeds', enumPrinters !== null)
        if (!enumPrinters) return

        const flags = 0x06
        const level = 2
        const neededBuf = new Uint32Array(new ArrayBuffer(4))
        const returnedBuf = new Uint32Array(new ArrayBuffer(4))

        const ret1 = ffi.ffiCall(
            enumPrinters,
            [
                ffi.FFI_TYPE_UINT32,
                ffi.FFI_TYPE_POINTER,
                ffi.FFI_TYPE_UINT32,
                ffi.FFI_TYPE_POINTER,
                ffi.FFI_TYPE_UINT32,
                ffi.FFI_TYPE_POINTER,
                ffi.FFI_TYPE_POINTER,
            ],
            [
                flags,
                null,
                level,
                null,
                0,
                neededBuf.buffer,
                returnedBuf.buffer,
            ],
            ffi.FFI_TYPE_SINT32
        )
        std.printf('  first call: ret=%d needed=%d returned=%d\n', ret1, neededBuf[0], returnedBuf[0])
        t.checkTrue('pcbNeeded > 0', neededBuf[0]! > 0)
        if (neededBuf[0]! <= 0) return

        const printerBuf = new ArrayBuffer(neededBuf[0]!)
        const ret2 = ffi.ffiCall(
            enumPrinters,
            [
                ffi.FFI_TYPE_UINT32,
                ffi.FFI_TYPE_POINTER,
                ffi.FFI_TYPE_UINT32,
                ffi.FFI_TYPE_POINTER,
                ffi.FFI_TYPE_UINT32,
                ffi.FFI_TYPE_POINTER,
                ffi.FFI_TYPE_POINTER,
            ],
            [
                flags,
                null,
                level,
                printerBuf,
                neededBuf[0]!,
                neededBuf.buffer,
                returnedBuf.buffer,
            ],
            ffi.FFI_TYPE_SINT32
        )
        t.checkTrue('EnumPrintersW succeeds', ret2 !== 0)
        if (ret2 === 0) return

        std.printf('  printers found: %d\n', returnedBuf[0])

        if (returnedBuf[0]! > 0) {
            const dv = new DataView(printerBuf)
            // PRINTER_INFO_2W layout (MinGW verified):
            //   x64: sizeof=136 name=8 port=24 drv=32 comment=40 location=48 status=124
            //   ia32: sizeof=84 name=4 port=12 drv=16 comment=20 location=24 status=72
            const ia32 = os.arch === 'ia32'
            const structSize = ia32 ? 84 : 136
            const offName = ia32 ? 4 : 8
            const offPort = ia32 ? 12 : 24
            const offDrv = ia32 ? 16 : 32
            const offComment = ia32 ? 20 : 40
            const offLocation = ia32 ? 24 : 48
            const offStatus = ia32 ? 72 : 124

            for (let i = 0; i < returnedBuf[0]! && i < 20; i++) {
                const off = i * structSize
                const name = decodeWideAtPtr(readPtr(dv, off + offName))
                const port = decodeWideAtPtr(readPtr(dv, off + offPort))
                const driver = decodeWideAtPtr(readPtr(dv, off + offDrv))
                const location = decodeWideAtPtr(readPtr(dv, off + offLocation))
                const comment = decodeWideAtPtr(readPtr(dv, off + offComment))
                const status = dv.getUint32(off + offStatus, true)
                std.printf('  [%d] %s\n', i + 1, name)
                std.printf('       port: %s\n', port)
                std.printf('       driver: %s\n', driver)
                if (location) std.printf('       location: %s\n', location)
                if (comment) std.printf('       comment: %s\n', comment)
                std.printf('       status: 0x%08X (%s)\n', status, formatStatus(status))
            }
        } else {
            std.printf('  no printers installed (skip)\n')
        }

        t.section('PTR accepts raw number handles (XP 32-bit fix)')
        const hUser32 = win.LoadLibrary('user32.dll')
        t.checkTrue('LoadLibrary("user32.dll") succeeds', hUser32 !== null)
        if (hUser32) {
            const getDC = win.GetProcAddress(hUser32, 'GetDC')
            t.checkTrue('GetProcAddress("GetDC") succeeds', getDC !== null)
            if (getDC) {
                const screenDc = ffi.ffiCall(getDC, [ffi.FFI_TYPE_POINTER], [0], ffi.FFI_TYPE_POINTER)
                t.checkTrue('PTR slot takes number (NULL hwnd) and returns a DC handle', screenDc !== 0 && screenDc !== null)
                const bogus = ffi.ffiCall(getDC, [ffi.FFI_TYPE_POINTER], [0x12345678], ffi.FFI_TYPE_POINTER)
                t.checkTrue('PTR slot takes non-zero number without throwing', bogus === 0 || bogus === null)
            }
        }
    }
}
