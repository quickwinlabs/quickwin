// DPI 与系统字体 —— gui 模块下沉到 JS 层的两处复合逻辑（原 js_getScaleFactor /
// js_createSystemDpiFont）。两者都只按「一次操作一次」调用，FFI 的固定溢价无感；
// 留在 C 只会与 lib/windows 的绑定重复一层，遂收在此处单点实现。
import { NULL, type Ptr } from './ffi/ctype.js'
import { GetDC, ReleaseDC, SystemParametersInfo } from './windows/user32.js'
import { GetDeviceCaps, CreateFontIndirect } from './windows/gdi32.js'
import { NONCLIENTMETRICSW } from './windows/structs.js'
import { DeviceCap, Spi } from '../constants'

/** 屏幕缩放系数（96 DPI = 1）：GetDC(NULL) → GetDeviceCaps(LOGPIXELSX) → ReleaseDC 成对释放 */
export function getScaleFactor(): number {
    const hdc = GetDC(NULL)
    const dpi = hdc ? GetDeviceCaps(hdc, DeviceCap.LOGPIXELSX) : 96
    if (hdc) ReleaseDC(NULL, hdc)
    return dpi / 96
}

/** 系统消息字体（CreateFontIndirectW(NONCLIENTMETRICS.lfMessageFont)）——界面控件的默认字体；
 *  cbSize/uiParam 必须与系统认知的结构尺寸一致：Vista+ 为 504（含尾部 iPaddedBorderWidth）、
 *  XP/2003 为 500 —— 先按 504 试，失败退回 500（lfMessageFont 落在前 500 字节内，尾部留 0）；
 *  两次都失败 → NULL，调用方按「无字体」处理（控件回落系统默认字体）。 */
export function createSystemDpiFont(): Ptr<'HGDIOBJ'> | NULL {
    const ncm = NONCLIENTMETRICSW.encode({ cbSize: NONCLIENTMETRICSW.size })
    if (!SystemParametersInfo(Spi.GETNONCLIENTMETRICS, NONCLIENTMETRICSW.size, ncm, 0)) {
        const legacySize = NONCLIENTMETRICSW.size - 4
        NONCLIENTMETRICSW.encode({ cbSize: legacySize }, ncm)
        if (!SystemParametersInfo(Spi.GETNONCLIENTMETRICS, legacySize, ncm, 0)) return NULL
    }
    return CreateFontIndirect(NONCLIENTMETRICSW.decode(ncm).lfMessageFont)
}
