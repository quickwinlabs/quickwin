// 应用图标：从当前 exe 的 RT_GROUP_ICON 加载（quickwin 构建链用 resedit 盖 ID 101）。
// 旧 C 侧的 gui.LoadAppIcon（枚举任意 ID）已移除——自定义图标请自行
// SendMessage(WM_SETICON) 或直接 LoadImageOrdinal。
import { NULL, type MaybePtr } from './ffi/ctype.js'
import { GetModuleHandle } from './windows/kernel32.js'
import { LoadImageOrdinal } from './windows/user32.js'
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
    return LoadImageOrdinal(GetModuleHandle(NULL), APP_ICON_ID, ImageType.ICON, cx, cy, LoadImageFlag.DEFAULTCOLOR) as MaybePtr<'HICON'>
}
