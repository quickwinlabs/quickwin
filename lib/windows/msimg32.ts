// msimg32 绑定（透明色键的位图传送，Win2000+ 系统自带 DLL）
import { bind } from '../ffi/bind.js'

// dll 名部分应用（工厂转调保泛型 infer，见 lib/windows/user32.ts 头注释）
const b = <const S extends string>(name: string, sig: S) => bind('msimg32.dll', name, sig)

/** 颜色键透明传送（crTransparent 色的源像素不画、透出目标底色；源区与目标可不同大 =
 *  拉伸 + 透明一次完成）
 *  @returns 成功 → 非 0
 *  @param args_0 hdcDest 目标 DC
 *  @param args_1 xDest 目标左上 x
 *  @param args_2 yDest 目标左上 y
 *  @param args_3 wDest 目标宽
 *  @param args_4 hDest 目标高
 *  @param args_5 hdcSrc 源 DC
 *  @param args_6 xSrc 源区左上 x
 *  @param args_7 ySrc 源区左上 y
 *  @param args_8 wSrc 源区宽
 *  @param args_9 hSrc 源区高
 *  @param args_10 crTransparent 键色 0x00BBGGRR（取低 3 字节与源像素 RGB 比较） */
export const TransparentBlt = /*@__PURE__*/ b('TransparentBlt',
    '<HDC>ptr! i32 i32 i32 i32 <HDC>ptr i32 i32 i32 i32 u32 -> i32')
