// gdi32 绑定（品牌约定见 lib/windows/user32.ts 头注释）：
//   - HDC 出入参用 <HDC>ptr（品牌指针 Ptr<'HDC'>，与 user32 的 GetDC/ReleaseDC 同型互认）
//   - GDI 对象通用句柄（HBRUSH/HPEN/HFONT/HBITMAP 在 Win32 同为 HGDIOBJ）保持 <>ptr——
//     异种对象互传由运行时句柄有效性判定，类型层不设品牌
//   - 结构位按方向分流：CreateFontIndirect 的 LOGFONTW 是纯入参位，注册 encoder 收
//     DeepPartial 对象直传（缺省字段跳过 = 保持 0 合法零值语义）
import { bind, type CodecMap } from '../ffi/bind.js'
import { LOGFONTW } from './structs.js'

// dll 名部分应用（工厂转调保泛型 infer，见 lib/windows/user32.ts 头注释；第三参透传 encoders）
const b = <const S extends string, const LE extends CodecMap = {}>(name: string, sig: S, encoders?: LE) =>
    bind('gdi32.dll', name, sig, encoders)

/** 创建实心画刷（color = 0x00BBGGRR）；失败 → null；配对 DeleteObject */
export const CreateSolidBrush = /*@__PURE__*/ b('CreateSolidBrush', 'u32 -> <>ptr')
/** 删除 GDI 对象（画刷/画笔/字体/位图等通用句柄，传 CreateXxx 返回的 number）；成功 → 非 0 */
export const DeleteObject = /*@__PURE__*/ b('DeleteObject', '<>ptr -> i32')
/** 取设备能力值（hdc 收品牌 HDC；index = LOGPIXELSX(88)/LOGPIXELSY(90)/BITSPIXEL 等） */
export const GetDeviceCaps = /*@__PURE__*/ b('GetDeviceCaps', '<HDC>ptr i32 -> i32')
/** 按 LOGFONTW 创建字体（入参位对象直传 DeepPartial：至少给 lfHeight 与 lfFaceName，其余缺省
 *  跳过保持 0）；失败 → null；配对 DeleteObject */
export const CreateFontIndirect = /*@__PURE__*/ b('CreateFontIndirectW', '<LOGFONTW>ptr -> <>ptr', { LOGFONTW })
