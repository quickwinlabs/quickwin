// comctl32 绑定（ImageList 系列；HIMAGELIST 不透明句柄走 <HIMAGELIST>ptr 自产自收，
// Add 的 hbm 位与 gdi32 的 <HGDIOBJ>ptr 同型互认——CreateBitmap 产物直传）
import { bind } from '../ffi/bind.js'

// dll 名部分应用（工厂转调保泛型 infer，见 lib/windows/user32.ts 头注释）
const b = <const S extends string>(name: string, sig: S) => bind('comctl32.dll', name, sig)
/** 建图像列表；配对 ImageListDestroy
 *  @returns 图像列表句柄；失败 → NULL
 *  @param args_0 cx/cy 图像尺寸  @param args_2 flags ILC_* 组合
 *  @param args_3 cInitial 初始容量  @param args_4 cGrow 增长步长 */
export const ImageListCreate = /*@__PURE__*/ b('ImageList_Create', 'i32 i32 u32 i32 i32 -> <HIMAGELIST>ptr')
/** 加位图进图像列表
 *  @returns 新索引（-1 失败）
 *  @param args_0 himl 图像列表句柄
 *  @param args_1 hbm 位图句柄（gdi32 <HGDIOBJ>ptr 产物，如 CreateCompatibleBitmap） */
export const ImageListAdd = /*@__PURE__*/ b('ImageList_Add', '<HIMAGELIST>ptr <HGDIOBJ>ptr -> i32')
/** 销毁图像列表
 *  @returns 成功 → 非 0 */
export const ImageListDestroy = /*@__PURE__*/ b('ImageList_Destroy', '<HIMAGELIST>ptr -> i32')
