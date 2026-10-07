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

// ============ 内存 DC / 位图（截屏类流程：CreateCompatibleDC → SelectObject → BitBlt → GetDIBits）============

/** 建与 hdc 兼容的内存 DC（hdc 传 NULL = 与屏幕兼容）；返回品牌 HDC，失败 → NULL；配对 DeleteDC */
export const CreateCompatibleDC = /*@__PURE__*/ b('CreateCompatibleDC', '<HDC>ptr -> <HDC>ptr')
/** 建与 hdc 兼容的位图（尺寸取决于 hdc 当前选中对象：内存 DC 刚建时选中 1×1 单色图，
 *  所以要传屏幕 DC）；失败 → NULL；配对 DeleteObject */
export const CreateCompatibleBitmap = /*@__PURE__*/ b('CreateCompatibleBitmap', '<HDC>ptr i32 i32 -> <>ptr')
/** 把 GDI 对象选进 hdc，返回被替换的旧对象（用完选回去再删除新对象）；失败 → NULL */
export const SelectObject = /*@__PURE__*/ b('SelectObject', '<HDC>ptr <>ptr -> <>ptr')
/** 位块传送（dwRop 如 SRCCOPY = 0x00CC0020）；成功 → 非 0 */
export const BitBlt = /*@__PURE__*/ b('BitBlt', '<HDC>ptr i32 i32 i32 i32 <HDC>ptr i32 i32 u32 -> i32')
/** 取位图像素到 lpvBits（直接收 ArrayBuffer；lpbmi 为 BITMAPINFO，32bpp BI_RGB 无颜色表时头部即全部：
 *  传 BITMAPINFOHEADER.encode({...}).ptr；有颜色表的格式由调用方自备更大的缓冲）；
 *  uUsage = DIB_RGB_COLORS(0)；返回成功取到的扫描行数，失败 → 0 */
export const GetDIBits = /*@__PURE__*/ b('GetDIBits', '<HDC>ptr <>ptr u32 u32 <BYTE>ptr <>ptr u32 -> i32')
/** 取 GDI 对象信息到 lpv（hFont → LOGFONTW 等；cb = 缓冲字节数，如 LOGFONTW.size；
 *  out 传 LOGFONTW.encode()）；返回写入的字节数，失败 → 0 */
export const GetObject = /*@__PURE__*/ b('GetObjectW', '<>ptr i32 <BYTE>ptr -> i32')
/** 删除内存 DC（CreateCompatibleDC 建的）；成功 → 非 0 */
export const DeleteDC = /*@__PURE__*/ b('DeleteDC', '<HDC>ptr -> i32')
