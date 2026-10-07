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

/** 创建实心画刷（color = 0x00BBGGRR）；失败 → 0；配对 DeleteObject
 *  @param args_0 crColor 画刷颜色 0x00BBGGRR */
export const CreateSolidBrush = /*@__PURE__*/ b('CreateSolidBrush', 'u32 -> <>ptr')
/** 删除 GDI 对象（画刷/画笔/字体/位图等通用句柄，传 CreateXxx 返回的 number）；成功 → 非 0
 *  @param args_0 hGdiObj 要删除的 GDI 对象句柄（<>ptr 收宽） */
export const DeleteObject = /*@__PURE__*/ b('DeleteObject', '<>ptr -> i32')
/** 取设备能力值（hdc 收品牌 HDC；index = LOGPIXELSX(88)/LOGPIXELSY(90)/BITSPIXEL 等）
 *  @param args_0 hdc 设备上下文（HDC 品牌）
 *  @param args_1 index 能力索引（LOGPIXELSX = 88，LOGPIXELSY = 90，BITSPIXEL = 12 等） */
export const GetDeviceCaps = /*@__PURE__*/ b('GetDeviceCaps', '<HDC>ptr i32 -> i32')
/** 按 LOGFONTW 创建字体（入参位对象直传 DeepPartial：至少给 lfHeight 与 lfFaceName，其余缺省
 *  跳过保持 0）；失败 → 0；配对 DeleteObject
 *  @param args_0 lplf LOGFONTW 对象（DeepPartial 直传） */
export const CreateFontIndirect = /*@__PURE__*/ b('CreateFontIndirectW', '<LOGFONTW>ptr -> <>ptr', { LOGFONTW })

// ============ 内存 DC / 位图（截屏类流程：CreateCompatibleDC → SelectObject → BitBlt → GetDIBits）============

/** 建与 hdc 兼容的内存 DC（hdc 传 NULL = 与屏幕兼容）；返回品牌 HDC，失败 → NULL；配对 DeleteDC
 *  @param args_0 hdc 参考 DC（HDC 品牌），NULL = 与屏幕兼容 */
export const CreateCompatibleDC = /*@__PURE__*/ b('CreateCompatibleDC', '<HDC>ptr -> <HDC>ptr')
/** 建与 hdc 兼容的位图（尺寸取决于 hdc 当前选中对象：内存 DC 刚建时选中 1×1 单色图，
 *  所以要传屏幕 DC）；失败 → NULL；配对 DeleteObject
 *  @param args_0 hdc 参考 DC（决定位图格式，须为屏幕或真实 DC）
 *  @param args_1 cx 宽度（像素）
 *  @param args_2 cy 高度（像素） */
export const CreateCompatibleBitmap = /*@__PURE__*/ b('CreateCompatibleBitmap', '<HDC>ptr i32 i32 -> <>ptr')
/** 把 GDI 对象选进 hdc，返回被替换的旧对象（用完选回去再删除新对象）；失败 → NULL
 *  @param args_0 hdc 目标 DC（HDC 品牌）
 *  @param args_1 h 新对象句柄（HGDIOBJ 通称，<>ptr 收宽） */
export const SelectObject = /*@__PURE__*/ b('SelectObject', '<HDC>ptr <>ptr -> <>ptr')
/** 位块传送（dwRop 如 SRCCOPY = 0x00CC0020）；成功 → 非 0
 *  @param args_0 hdcDest 目标 DC
 *  @param args_1 xDest 目标左上角 x
 *  @param args_2 yDest 目标左上角 y
 *  @param args_3 cx 传送宽度
 *  @param args_4 cy 传送高度
 *  @param args_5 hdcSrc 源 DC
 *  @param args_6 x1 源起始 x
 *  @param args_7 y1 源起始 y
 *  @param args_8 dwRop 光栅操作码（SRCCOPY = 0x00CC0020） */
export const BitBlt = /*@__PURE__*/ b('BitBlt', '<HDC>ptr i32 i32 i32 i32 <HDC>ptr i32 i32 u32 -> i32')
/** 取位图像素到 lpvBits（直接收 ArrayBuffer；lpbmi 为 BITMAPINFO，32bpp BI_RGB 无颜色表时头部即全部：
 *  传 BITMAPINFOHEADER.encode({...}).ptr；有颜色表的格式由调用方自备更大的缓冲）；
 *  uUsage = DIB_RGB_COLORS(0)；返回成功取到的扫描行数，失败 → 0
 *  @param args_0 hdc 设备上下文
 *  @param args_1 hbm 位图句柄
 *  @param args_2 uStartScan 起始扫描行
 *  @param args_3 cLines 扫描行数
 *  @param args_4 lpvBits 像素接收缓冲（ArrayBuffer）
 *  @param args_5 lpbmi BITMAPINFO 缓冲（BITMAPINFOHEADER.encode({...}).ptr）
 *  @param args_6 uUsage DIB_RGB_COLORS(0) */
export const GetDIBits = /*@__PURE__*/ b('GetDIBits', '<HDC>ptr <>ptr u32 u32 <BYTE>ptr <>ptr u32 -> i32')
/** 取 GDI 对象信息到 lpv（hFont → LOGFONTW 等；cb = 缓冲字节数，如 LOGFONTW.size；
 *  out 传 LOGFONTW.encode()）；返回写入的字节数，失败 → 0
 *  @param args_0 h GDI 对象句柄（字体/画笔/位图等）
 *  @param args_1 cb 输出缓冲字节数（如 LOGFONTW.size）
 *  @param args_2 lpv 输出缓冲（LOGFONTW.encode() 等） */
export const GetObject = /*@__PURE__*/ b('GetObjectW', '<>ptr i32 <BYTE>ptr -> i32')
/** 删除内存 DC（CreateCompatibleDC 建的）；成功 → 非 0
 *  @param args_0 hdc 要删的 DC（HDC 品牌） */
export const DeleteDC = /*@__PURE__*/ b('DeleteDC', '<HDC>ptr -> i32')

/** 用画刷图案填充矩形（x/y/w/h = 目标区；rop = PATCOPY/PATINVERT 等）；成功 → 非 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 x 左上角 x
 *  @param args_2 y 左上角 y
 *  @param args_3 w 宽度
 *  @param args_4 h 高度
 *  @param args_5 rop 光栅操作码（PATCOPY 等） */
export const PatBlt = /*@__PURE__*/ b('PatBlt', '<HDC>ptr i32 i32 i32 i32 u32 -> i32')
/** 把 DIB 位图画到目标 DC（DestWidth/Height 目标尺寸，xSrc/ySrc 起始源点，NumScans 扫描行数；
 *  lpvBits 直接收 ArrayBuffer，lpbmi 传 BITMAPINFO 缓冲、coloruse = DIB_RGB_COLORS(0)）；返回扫描行数，失败 → 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 xDest 目标左上角 x
 *  @param args_2 yDest 目标左上角 y
 *  @param args_3 DestWidth 目标宽度
 *  @param args_4 DestHeight 目标高度
 *  @param args_5 xSrc 源起始 x
 *  @param args_6 ySrc 源起始 y
 *  @param args_7 uStartScan 起始扫描行
 *  @param args_8 uNumScans 扫描行数
 *  @param args_9 lpvBits 像素缓冲（ArrayBuffer）
 *  @param args_10 lpbmi BITMAPINFO 缓冲
 *  @param args_11 iUsage DIB_RGB_COLORS(0) */
export const SetDIBitsToDevice = /*@__PURE__*/ b('SetDIBitsToDevice',
    '<HDC>ptr i32 i32 u32 u32 i32 i32 u32 u32 <BYTE>ptr <BYTE>ptr u32 -> i32')
