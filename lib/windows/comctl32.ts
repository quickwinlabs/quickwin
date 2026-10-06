// comctl32 绑定（ImageList 系列；HIMAGELIST 为不透明句柄保持 <>ptr）
import { bind } from '../ffi/bind.js'

// dll 名部分应用（工厂转调保泛型 infer，见 lib/windows/user32.ts 头注释）
const b = <const S extends string>(name: string, sig: S) => bind('comctl32.dll', name, sig)

/** 创建图像列表（flags = ILC_*，ILC_COLOR32 = 4；initial/grow 传 0 用默认值）；失败 → null */
export const ImageListCreate = /*@__PURE__*/ b('ImageList_Create', 'i32 i32 u32 i32 i32 -> <>ptr')
/** 追加位图到图像列表；返回新图像索引（-1 失败） */
export const ImageListAdd = /*@__PURE__*/ b('ImageList_Add', '<>ptr <>ptr -> i32')
/** 销毁图像列表；成功 → 非 0 */
export const ImageListDestroy = /*@__PURE__*/ b('ImageList_Destroy', '<>ptr -> i32')
