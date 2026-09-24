import * as std from 'std'
import * as gui from 'gui'
import * as win from 'win'
import * as ffi from 'ffi'

const user32 = win.LoadLibrary('user32.dll')
if (!user32) { print('LoadLibrary user32 failed'); std.exit(1) }

function loadProc(lib: win.HMODULE, name: string): number {
    const ptr = win.GetProcAddress(lib, name)
    if (!ptr) { print('GetProcAddress ' + name + ' failed'); std.exit(1) }
    return ptr
}

const EnumDisplaySettingsA = loadProc(user32, 'EnumDisplaySettingsA')
const ChangeDisplaySettingsA = loadProc(user32, 'ChangeDisplaySettingsA')

/** DEVMODEA used by EnumDisplaySettings; driver reports actual dmSize (often 124). */
const DEVMODE_SIZE = 220
const DM_PELSWIDTH = 0x00800000
const DM_PELSHEIGHT = 0x01000000
const ENUM_CURRENT_SETTINGS = -1
const CDS_UPDATEREGISTRY = 0x00000001
const CDS_TEST = 0x00000002

const DISP_CHANGE: Record<number, string> = {
    0: 'SUCCESSFUL',
    1: 'RESTART',
    [-1]: 'FAILED',
    [-2]: 'BADMODE',
    [-3]: 'NOTUPDATED',
    [-4]: 'BADFLAGS',
    [-5]: 'BADPARAM',
    [-6]: 'BADDUALVIEW',
}

function newDevMode(): ArrayBuffer {
    const buf = new ArrayBuffer(DEVMODE_SIZE)
    new DataView(buf).setUint16(36, DEVMODE_SIZE, true)
    return buf
}

function enumMode(modeNum: number, buf: ArrayBuffer): number {
    return ffi.ffiCall(
        EnumDisplaySettingsA,
        [ffi.FFI_TYPE_POINTER, ffi.FFI_TYPE_SINT32, ffi.FFI_TYPE_POINTER],
        [null, modeNum, buf],
        ffi.FFI_TYPE_SINT32,
    )
}

function getPels(dv: DataView): [number, number, number] {
    return [dv.getUint32(108, true), dv.getUint32(112, true), dv.getUint32(120, true)]
}

function applyFromCurrent(w: number, h: number, flags: number, label: string): number | null {
    const dm = newDevMode()
    if (!enumMode(ENUM_CURRENT_SETTINGS, dm)) {
        print(label + ': EnumDisplaySettings CURRENT failed')
        return null
    }
    const dv = new DataView(dm)
    const before = getPels(dv)
    const size = dv.getUint16(36, true)
    const extra = dv.getUint16(38, true)
    const fields = dv.getUint32(40, true)
    const bpp = dv.getUint32(104, true)
    const freq = dv.getUint32(120, true)
    print(label + ': base size=' + size + ' extra=' + extra + ' fields=0x' + fields.toString(16) +
        ' ' + before[0] + 'x' + before[1] + '@' + freq + ' bpp=' + bpp)

    dv.setUint32(40, fields | DM_PELSWIDTH | DM_PELSHEIGHT, true)
    dv.setUint32(108, w, true)
    dv.setUint32(112, h, true)

    const ret = ffi.ffiCall(
        ChangeDisplaySettingsA,
        [ffi.FFI_TYPE_POINTER, ffi.FFI_TYPE_UINT32],
        [dm, flags],
        ffi.FFI_TYPE_SINT32,
    )
    print(label + ': ChangeDisplaySettings ' + w + 'x' + h +
        ' flags=0x' + flags.toString(16) + ' ret=' + ret + ' (' + (DISP_CHANGE[ret] ?? '?') + ')')
    return ret
}

const targetW = Number(scriptArgs[1] ?? '1024')
const targetH = Number(scriptArgs[2] ?? '768')
if (!Number.isFinite(targetW) || !Number.isFinite(targetH) || targetW <= 0 || targetH <= 0) {
    print('usage: qwin.exe setres.js [width] [height]')
    std.exit(1)
}

print('before GetScreenSize: ' + JSON.stringify(gui.GetScreenSize()))

const probe = newDevMode()
const modes32: string[] = []
for (let i = 0; i < 200; i++) {
    if (!enumMode(i, probe)) break
    const dv = new DataView(probe)
    if (dv.getUint32(104, true) !== 32) continue
    const p = getPels(dv)
    modes32.push(p[0] + 'x' + p[1] + '@' + p[2])
}
print('32bpp modes sample: ' + modes32.slice(0, 25).join(', ') + (modes32.length > 25 ? ' ...' : ''))

const testRet = applyFromCurrent(targetW, targetH, CDS_TEST, 'TEST')
if (testRet === 0) {
    applyFromCurrent(targetW, targetH, 0, 'DYNAMIC')
    print('after dynamic GetScreenSize: ' + JSON.stringify(gui.GetScreenSize()))
    applyFromCurrent(targetW, targetH, CDS_UPDATEREGISTRY, 'REGISTRY')
    print('after registry GetScreenSize: ' + JSON.stringify(gui.GetScreenSize()))
} else if (testRet !== null) {
    print('target rejected; try 800x600')
    const t2 = applyFromCurrent(800, 600, CDS_TEST, 'TEST800')
    if (t2 === 0) {
        applyFromCurrent(800, 600, 0, 'DYNAMIC800')
        print('after 800x600 GetScreenSize: ' + JSON.stringify(gui.GetScreenSize()))
    }
}
