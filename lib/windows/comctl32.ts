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
 *  @param args_1 hbmImage 位图句柄（gdi32 <HGDIOBJ>ptr 产物，如 CreateCompatibleBitmap）
 *  @param args_2 hbmMask 掩码位图；32bpp 图像传 NULL */
export const ImageListAdd = /*@__PURE__*/ b('ImageList_Add', '<HIMAGELIST>ptr <HGDIOBJ>ptr <HGDIOBJ>ptr -> i32')
/** 销毁图像列表
 *  @returns 成功 → 非 0 */
export const ImageListDestroy = /*@__PURE__*/ b('ImageList_Destroy', '<HIMAGELIST>ptr -> i32')

/** 按目标尺寸缩放加载图标（LoadIconWithScaleDown；**Vista+**，需 comctl32 v6 激活——
 *  XP 的 comctl32 无此导出，故为**可选绑定**（bind() 模块顶层立即解析，缺符号 throw
 *  会拖垮整个脚本启动），老系统上本常量为 null，调用方必须回退 LoadImage）
 *  @returns HRESULT：0 = 成功，phico 写入图标句柄；非 0 = 失败（phico 未写）
 *  @param args_0 hinst 资源所在模块（GetModuleHandle(NULL) 取 exe）
 *  @param args_1 pszName 资源名 / MAKEINTRESOURCE 序数（<>ptr 收整数序数）
 *  @param args_2 cx 目标宽（物理像素）  @param args_3 cy 目标高
 *  @param args_4 [out] phico：句柄写回，PtrArrayBuffer(PTR_SIZE) 读回 */
export const LoadIconWithScaleDown = (() => {
    try {
        return b('LoadIconWithScaleDown', '<HMODULE>ptr <>ptr i32 i32 <BYTE>ptr -> i32')
    } catch {
        return null    // XP 等老系统无此导出
    }
})()
