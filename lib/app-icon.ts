// 应用图标：从当前 exe 的 RT_GROUP_ICON 加载（quickwin 构建链用 resedit 盖 ID 101）。
// 旧 C 侧的 gui.LoadAppIcon（枚举任意 ID）已移除——自定义图标请自行
// SendMessage(WM_SETICON) 或直接 LoadImage。
import { NULL, PTR_SIZE, PtrArrayBuffer, type MaybePtr } from './ffi/ctype.js'
import { GetModuleHandle } from './windows/kernel32.js'
import { LoadImage } from './windows/user32.js'
import { LoadIconWithScaleDown } from './windows/comctl32.js'
import { getScaleFactor } from './dpi.js'
import { ImageType, LoadImageFlag } from '../constants'
import { APP_ICON_ID } from './consts.js'

export { APP_ICON_ID }

/**
 * 从当前 exe 的 APP_ICON_ID 图标组按 cx/cy 加载图标。
 * 必须用 LR_DEFAULTCOLOR（非 LR_SHARED）——共享缓存会忽略请求尺寸。
 * @returns HICON；exe 无该图标组 → NULL
 */
export function loadAppIcon(cx: number, cy: number): MaybePtr<'HICON'> {
    // 固定 IMAGE_ICON，故返回值必为 HICON（底层 <>ptr 是父类型，需收窄）
    return LoadImage(GetModuleHandle(NULL), APP_ICON_ID, ImageType.ICON, cx, cy, LoadImageFlag.DEFAULTCOLOR) as MaybePtr<'HICON'>
}

/** 句柄出参槽回读（ia32 4B / x64 8B）——照 test_registry 的 readPtr 先例 */
function readHandleSlot(buf: PtrArrayBuffer): number {
    const dv = new DataView(buf)
    return PTR_SIZE === 8
        ? dv.getUint32(0, true) + dv.getUint32(4, true) * 4294967296
        : dv.getUint32(0, true)
}

/**
 * 按系统 DPI 缩放后的实际像素加载应用图标：baseCx/baseCy 是 96 DPI 基准尺寸
 * （125% 时 16 → 20px），与 C 侧类图标 loadAppIconScaled 同构。
 * 优先 LoadIconWithScaleDown（Vista+：取最近的更大帧高质量缩小，避免 16px 帧
 * 被放大发虚）；XP / 失败回退 LoadImage 同尺寸。
 * @returns HICON；exe 无该图标组 → NULL
 */
export function loadAppIconScaled(baseCx: number, baseCy: number): MaybePtr<'HICON'> {
    const s = getScaleFactor()
    const cx = Math.round(baseCx * s)
    const cy = Math.round(baseCy * s)
    if (LoadIconWithScaleDown) {
        const slot = new PtrArrayBuffer(PTR_SIZE)
        if (LoadIconWithScaleDown(GetModuleHandle(NULL), APP_ICON_ID, cx, cy, slot) === 0) {
            const h = readHandleSlot(slot)
            if (h !== 0) return h as MaybePtr<'HICON'>
        }
    }
    return loadAppIcon(cx, cy)
}
