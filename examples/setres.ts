import * as std from 'std'
import * as gui from 'gui'
import { NULL } from '../lib/ffi/ctype.js'
import { ChangeDisplaySettings, EnumDisplaySettings } from '../lib/windows/user32.js'
import { DEVMODEW } from '../lib/windows/structs.js'

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

function newDevMode() {
    // dmSize = 结构自身大小是 Win32 要求（否则 API 拒绝）；其余字段由 Enum 就地填充
    return DEVMODEW.encode({ dmSize: DEVMODEW.size })
}

function applyFromCurrent(w: number, h: number, flags: number, label: string): number | null {
    const dm = newDevMode()
    if (!EnumDisplaySettings(NULL, ENUM_CURRENT_SETTINGS, dm.ptr)) {
        print(label + ': EnumDisplaySettings CURRENT failed')
        return null
    }
    const cur = DEVMODEW.decode(dm)
    print(label + ': base size=' + cur.dmSize + ' extra=' + cur.dmDriverExtra +
        ' fields=0x' + cur.dmFields.toString(16) +
        ' ' + cur.dmPelsWidth + 'x' + cur.dmPelsHeight +
        '@' + cur.dmDisplayFrequency + ' bpp=' + cur.dmBitsPerPel)

    // 复用同一 buffer 原地改三项（encode 缺省字段跳过 = 保留 Enum 填的其余项）
    DEVMODEW.encode({
        dmFields: cur.dmFields | DM_PELSWIDTH | DM_PELSHEIGHT,
        dmPelsWidth: w,
        dmPelsHeight: h,
    }, dm)

    const ret = ChangeDisplaySettings(dm.ptr, flags)
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
    if (!EnumDisplaySettings(NULL, i, probe.ptr)) break
    const dm = DEVMODEW.decode(probe)
    if (dm.dmBitsPerPel !== 32) continue
    modes32.push(dm.dmPelsWidth + 'x' + dm.dmPelsHeight + '@' + dm.dmDisplayFrequency)
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
