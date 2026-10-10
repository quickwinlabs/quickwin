// gdi32 绑定（品牌约定见 lib/windows/user32.ts 头注释）：
//   - HDC 出入参用 <HDC>ptr（品牌指针 Ptr<'HDC'>，与 user32 的 GetDC/ReleaseDC 同型互认）
//   - GDI 对象通用句柄统一 <HGDIOBJ>ptr（HBRUSH/HPEN/HFONT/HBITMAP/HRGN 在 Win32 同为
//     HGDIOBJ）：创建/选入/取出/删除全链同品牌闭环，拦 DeleteObject(hdc) 类异种误传；
//     user32 结构里的 HBRUSH 字段仍收裸位——品牌值赋给裸 number 位天然兼容
//   - 结构位按方向分流：CreateFontIndirect 的 LOGFONTW 是纯入参位，注册 encoder 收
//     DeepPartial 对象直传（缺省字段跳过 = 保持 0 合法零值语义）
import { bind, type CodecMap } from '../ffi/bind.js'
import { LOGFONTW, POINT, RECT } from './structs.js'

// dll 名部分应用（工厂转调保泛型 infer，见 lib/windows/user32.ts 头注释；第三参透传 encoders）
const b = <const S extends string, const LE extends CodecMap = {}>(name: string, sig: S, encoders?: LE) =>
    bind('gdi32.dll', name, sig, encoders)

/** 创建实心画刷；配对 DeleteObject
 *  @returns 失败 → 0
 *  @param args_0 crColor 画刷颜色 0x00BBGGRR */
export const CreateSolidBrush = /*@__PURE__*/ b('CreateSolidBrush', 'u32 -> <HGDIOBJ>ptr')
/** 删除 GDI 对象（画刷/画笔/字体/位图等通用句柄，传 CreateXxx 返回的 number）
 *  @returns 成功 → 非 0
 *  @param args_0 hGdiObj */
export const DeleteObject = /*@__PURE__*/ b('DeleteObject', '<HGDIOBJ>ptr -> i32')
/** 取设备能力值
 *  @returns 索引对应的设备能力值
 *  @param args_0 hdc
 *  @param args_1 index 能力索引（LOGPIXELSX = 88，LOGPIXELSY = 90，BITSPIXEL = 12 等） */
export const GetDeviceCaps = /*@__PURE__*/ b('GetDeviceCaps', '<HDC>ptr! i32@DeviceCap -> i32')
/** 按 LOGFONTW 创建字体（入参位对象直传 DeepPartial：至少给 lfHeight 与 lfFaceName，其余缺省
 *  跳过保持 0）；配对 DeleteObject
 *  @returns 失败 → 0
 *  @param args_0 lplf LOGFONTW 对象 */
export const CreateFontIndirect = /*@__PURE__*/ b('CreateFontIndirectW', '<LOGFONTW>ptr -> <HGDIOBJ>ptr', { LOGFONTW })

// ============ 内存 DC / 位图（截屏类流程：CreateCompatibleDC → SelectObject → BitBlt → GetDIBits）============

/** 建与 hdc 兼容的内存 DC；配对 DeleteDC
 *  @returns 失败 → NULL
 *  @param args_0 hdc 参考 DC，NULL = 与屏幕兼容 */
export const CreateCompatibleDC = /*@__PURE__*/ b('CreateCompatibleDC', '<HDC>ptr -> <HDC>ptr')
/** 建与 hdc 兼容的位图（尺寸取决于 hdc 当前选中对象：内存 DC 刚建时选中 1×1 单色图，
 *  所以要传屏幕 DC）；配对 DeleteObject
 *  @returns 失败 → NULL
 *  @param args_0 hdc 参考 DC（决定位图格式，须为屏幕或真实 DC）
 *  @param args_1 cx 宽度（像素）
 *  @param args_2 cy 高度（像素） */
export const CreateCompatibleBitmap = /*@__PURE__*/ b('CreateCompatibleBitmap', '<HDC>ptr! i32 i32 -> <HGDIOBJ>ptr')

/** 创建独立位图（与任何 DC 无关）；bits 喂原始像素缓冲则直接初始化（NULL = 未初始化）；
 *  1bpp 单色行内 bit7 = 最左像素、行按 word(2B) 对齐（非 DIB 的 4B，MaskBlt 实测）；
 *  配对 DeleteObject
 *  @returns 失败 → 0
 *  @param args_0 nWidth 宽（像素）
 *  @param args_1 nHeight 高（像素）
 *  @param args_2 nPlanes 色平面数（恒 1）
 *  @param args_3 nBitCount 每像素位数（1 = 单色 / 32 = BGRA）
 *  @param args_4 lpBits 原始像素缓冲（ArrayBuffer，可 NULL） */
export const CreateBitmap = /*@__PURE__*/ b('CreateBitmap',
    'i32 i32 u32 u32 <BYTE>ptr -> <HGDIOBJ>ptr')

/** 把 GDI 对象选进 hdc（用完选回去再删除新对象）
 *  @returns 被替换的旧对象；失败 → NULL
 *  @param args_0 hdc 目标 DC
 *  @param args_1 h 新对象句柄（HGDIOBJ 通称） */
export const SelectObject = /*@__PURE__*/ b('SelectObject', '<HDC>ptr! <HGDIOBJ>ptr -> <HGDIOBJ>ptr')
/** 位块传送
 *  @returns 成功 → 非 0
 *  @param args_0 hdcDest 目标 DC
 *  @param args_1 xDest 目标左上角 x
 *  @param args_2 yDest 目标左上角 y
 *  @param args_3 cx 传送宽度
 *  @param args_4 cy 传送高度
 *  @param args_5 hdcSrc 源 DC
 *  @param args_6 x1 源起始 x
 *  @param args_7 y1 源起始 y
 *  @param args_8 dwRop gui.RasterOp.SRCCOPY 等互斥单选光栅操作码（标 @ 枚举拦手误值） */
// hdcDest 非空（!）；hdcSrc 在 PATCOPY 等特定 rop 下 C 允许 NULL，保持可空档。
export const BitBlt = /*@__PURE__*/ b('BitBlt', '<HDC>ptr! i32 i32 i32 i32 <HDC>ptr i32 i32 u32@RasterOp -> i32')
/** 取位图像素到 lpvBits（lpbmi 为 BITMAPINFO，32bpp BI_RGB 无颜色表时头部即全部：
 *  有颜色表的格式由调用方自备更大的缓冲）
 *  @returns 成功取到的扫描行数；失败 → 0
 *  @param args_0 hdc
 *  @param args_1 hbm 位图句柄
 *  @param args_2 uStartScan 起始扫描行
 *  @param args_3 cLines 扫描行数
 *  @param args_4 lpvBits 像素接收缓冲（ArrayBuffer）
 *  @param args_5 lpbmi BITMAPINFO 缓冲（BITMAPINFOHEADER.encode({...}).ptr）
 *  @param args_6 uUsage DIB_RGB_COLORS(0) */
export const GetDIBits = /*@__PURE__*/ b('GetDIBits', '<HDC>ptr! <HGDIOBJ>ptr u32 u32 <BYTE>ptr <>ptr u32 -> i32')
/** 取 GDI 对象信息到 lpv（hFont → LOGFONTW 等）
 *  @returns 写入的字节数；失败 → 0
 *  @param args_0 h GDI 对象句柄（字体/画笔/位图等）
 *  @param args_1 cb 输出缓冲字节数（如 LOGFONTW.size）
 *  @param args_2 lpv 输出缓冲（LOGFONTW.alloc() 等） */
export const GetObject = /*@__PURE__*/ b('GetObjectW', '<HGDIOBJ>ptr i32 <BYTE>ptr -> i32')
/** 删除内存 DC（CreateCompatibleDC 建的）
 *  @returns 成功 → 非 0
 *  @param args_0 hdc 要删的 DC */
export const DeleteDC = /*@__PURE__*/ b('DeleteDC', '<HDC>ptr! -> i32')

/** 用画刷图案填充矩形
 *  @returns 成功 → 非 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 x 左上角 x
 *  @param args_2 y 左上角 y
 *  @param args_3 w 宽度
 *  @param args_4 h 高度
 *  @param args_5 rop gui.RasterOp.PATCOPY / WHITENESS 等互斥单选光栅操作码 */
export const PatBlt = /*@__PURE__*/ b('PatBlt', '<HDC>ptr! i32 i32 i32 i32 u32@RasterOp -> i32')
/** 拉伸位图传送（源区 wSrc×hSrc 放/缩到目标 wDest×hDest）
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
 *  @param args_10 dwRop gui.RasterOp.SRCCOPY 等互斥单选光栅操作码 */
export const StretchBlt = /*@__PURE__*/ b('StretchBlt',
    '<HDC>ptr! i32 i32 i32 i32 <HDC>ptr i32 i32 i32 i32 u32@RasterOp -> i32')
/** 设置拉伸取色模式；放大时各模式像素同为源色，缩小时降采样策略不同
 *  （DELETESCANS 丢行 / HALFTONE 平均取色最保真）
 *  @returns 旧值
 *  @param args_0 hdc 目标 DC
 *  @param args_1 iMode gui.StretchBltMode.ANDSCANS(1) / ORSCANS(2) / DELETESCANS(3) / HALFTONE(4) */
export const SetStretchBltMode = /*@__PURE__*/ b('SetStretchBltMode', '<HDC>ptr! i32@StretchBltMode -> i32')
/** 读拉伸取色模式（值域 = gui.StretchBltMode 成员）；回传
 *  SetStretchBltMode 前需按成员值使用（裸 number 进不了枚举位）
 *  @returns number */
export const GetStretchBltMode = /*@__PURE__*/ b('GetStretchBltMode', '<HDC>ptr! -> i32')
/** 平行四边形位图传送（源矩形映射到 lpPoint 三点定的平行四边形 = 旋转/斜切贴图，
 *  源区随之缩放到三点形）
 *  @returns 成功 → 非 0
 *  @param args_0 hdcDest 目标 DC
 *  @param args_1 lpPoint 三点数组 [左上, 右上, 左下]（<POINT*>ptr，必须 3 点）
 *  @param args_2 hdcSrc 源 DC
 *  @param args_3 xSrc 源区左上 x
 *  @param args_4 ySrc 源区左上 y
 *  @param args_5 width 源区宽
 *  @param args_6 height 源区高
 *  @param args_7 hbmMask 可选单色掩码（NULL = 直接贴）
 *  @param args_8 xMask 掩码内起点 x（掩码为 NULL 时忽略）
 *  @param args_9 yMask 掩码内起点 y */
export const PlgBlt = /*@__PURE__*/ b('PlgBlt',
    '<HDC>ptr! <POINT*>ptr <HDC>ptr i32 i32 i32 i32 <>ptr i32 i32 -> i32', { POINT })
/** 单色掩码位块传送：掩码非零处取前景三元 rop、零处取背景三元 rop；
 *  dwRop = MAKEROP4(fore, back) 打包（gdi32.ts 不导出辅助，公式内联）：
 *    rop = (((back << 8) & 0xFF000000) | fore) >>> 0
 *  （背景操作码在 bit31..24、前景在 bit23..16、低 16 位被 GDI 忽略；
 *  hbmMask NULL = 等同 BitBlt 用 fore）
 *  @returns 成功 → 非 0
 *  @param args_0 hdcDest 目标 DC
 *  @param args_1 xDest 目标左上 x
 *  @param args_2 yDest 目标左上 y
 *  @param args_3 width 目标/源宽（MaskBlt 源目标同尺寸，不缩放）
 *  @param args_4 height 目标/源高
 *  @param args_5 hdcSrc 源 DC
 *  @param args_6 xSrc 源区左上 x
 *  @param args_7 ySrc 源区左上 y
 *  @param args_8 hbmMask 单色掩码位图（CreateBitmap(1bpp)，可 NULL）
 *  @param args_9 xMask 掩码内起点 x
 *  @param args_10 yMask 掩码内起点 y
 *  @param args_11 dwRop MAKEROP4 打包值（双 rop 组合域，非 @RasterOp 单值） */
export const MaskBlt = /*@__PURE__*/ b('MaskBlt',
    '<HDC>ptr! i32 i32 i32 i32 <HDC>ptr i32 i32 <>ptr i32 i32 u32 -> i32')
/** 把 DIB 位图画到目标 DC
 *  @returns 扫描行数；失败 → 0
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
    '<HDC>ptr! i32 i32 u32 u32 i32 i32 u32 u32 <BYTE>ptr <BYTE>ptr u32 -> i32')

/** 拉伸 DIB 传送（内存像素缓冲直接放/缩到目标，免创建 HBITMAP 中转）；
 *  DestWidth/DestHeight 传 0 = 源自然尺寸；SrcWidth/SrcHeight 负 = 翻转
 *  @returns 成功 → 扫描行数；失败 → 0
 *  @param args_1 xDest 目标左上 x
 *  @param args_2 yDest 目标左上 y
 *  @param args_3 DestWidth 目标宽
 *  @param args_4 DestHeight 目标高
 *  @param args_5 xSrc 源区左上 x
 *  @param args_6 ySrc 源区左上 y
 *  @param args_7 SrcWidth 源区宽
 *  @param args_8 SrcHeight 源区高
 *  @param args_9 lpvBits 像素缓冲（ArrayBuffer）
 *  @param args_10 lpbmi BITMAPINFO 缓冲（BITMAPINFOHEADER.encode({...}).ptr）
 *  @param args_11 iUsage DIB_RGB_COLORS(0)
 *  @param args_12 rop gui.RasterOp.SRCCOPY 等互斥单选光栅操作码 */
export const StretchDIBits = /*@__PURE__*/ b('StretchDIBits',
    '<HDC>ptr! i32 i32 i32 i32 i32 i32 i32 i32 <BYTE>ptr <BYTE>ptr u32 u32@RasterOp -> i32')

// ============ 画图原语（笔 / 线 / 形状 / 文字） ============

/** 取系统共享对象（笔/刷/字体/调色板）；共享句柄不要 DeleteObject——
 *  SelectObject 选入 hdc 生效（如 NULL_BRUSH 让形状只描边不填充）
 *  @returns 失败 → 0
 *  @param args_0 iObject gui.StockObject.NULL_BRUSH / BLACK_PEN / DEFAULT_GUI_FONT 等 */
export const GetStockObject = /*@__PURE__*/ b('GetStockObject', 'i32@StockObject -> <HGDIOBJ>ptr')

/** 创建网格纹理画刷（线色 = crColor，间隙 = 背景：SetBkMode=TRANSPARENT 透底、OPAQUE
 *  用 SetBkColor）；配对 DeleteObject
 *  @returns 失败 → 0
 *  @param args_0 iHatch gui.HatchStyle.HORIZONTAL（横线）/ VERTICAL / FDIAGONAL /
 *  BDIAGONAL / CROSS / DIAGCROSS
 *  @param args_1 crColor 纹理线颜色 0x00BBGGRR */
export const CreateHatchBrush = /*@__PURE__*/ b('CreateHatchBrush', 'i32@HatchStyle u32 -> <HGDIOBJ>ptr')

/** 创建位图平铺画刷（小位图铺满填充区；平铺锚定设备原点 (0,0)，与目标矩形角无关）；
 *  配对 DeleteObject —— 位图在画刷删除后再 DeleteObject（保守生命周期）
 *  @returns 失败 → 0
 *  @param args_0 hbm 位图句柄（CreateCompatibleBitmap 返回；调用前先退出选入状态） */
export const CreatePatternBrush = /*@__PURE__*/ b('CreatePatternBrush', '<HGDIOBJ>ptr -> <HGDIOBJ>ptr')

/** 创建画笔（选入 hdc 生效，SelectObject 选回旧对象后 DeleteObject 配对）
 *  @returns 失败 → 0
 *  @param args_0 iStyle 笔型（gui.PenStyle.SOLID / DASH / NULL 等）
 *  @param args_1 cWidth 笔宽（像素；>1 的几何宽设备相关，虚线样式可能被拉伸）
 *  @param args_2 crColor 笔色 0x00BBGGRR */
export const CreatePen = /*@__PURE__*/ b('CreatePen', 'i32@PenStyle i32 u32 -> <HGDIOBJ>ptr')
/** 设置文字/阴影背景填充模式
 *  @returns 旧模式（新建 DC 默认 OPAQUE）
 *  @param args_0 hdc 目标 DC
 *  @param args_1 iBkMode gui.BackgroundMode.OPAQUE（衬底填充）/ TRANSPARENT（透明） */
export const SetBkMode = /*@__PURE__*/ b('SetBkMode', '<HDC>ptr! i32@BackgroundMode -> i32')
/** 设置文字颜色
 *  @returns 旧 COLORREF（0x00BBGGRR）
 *  @param args_0 hdc 目标 DC
 *  @param args_1 color 新文字色 0x00BBGGRR */
export const SetTextColor = /*@__PURE__*/ b('SetTextColor', '<HDC>ptr! u32 -> u32')
/** 设置背景（SetBkMode=OPAQUE 时的衬底）颜色
 *  @returns 旧 COLORREF（0x00BBGGRR）
 *  @param args_0 hdc 目标 DC
 *  @param args_1 color 新背景色 0x00BBGGRR */
export const SetBkColor = /*@__PURE__*/ b('SetBkColor', '<HDC>ptr! u32 -> u32')
/** 保存 DC 当前绘图状态到 GDI 状态栈（颜色/模式/选中笔刷字体/裁剪区/映射模式…）；
 *  配对 RestoreDC——标准用法：进入绘制块 Save、退出 Restore
 *  @returns 状态 ID（0 = 失败）
 *  @param args_0 hdc 目标 DC */
export const SaveDC = /*@__PURE__*/ b('SaveDC', '<HDC>ptr! -> i32')
/** 从状态栈恢复 SaveDC 保存的 DC 状态（对应 ID 及更晚的保存随之失效）
 *  @returns 成功 → 非 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 state SaveDC 返回的状态 ID，或 -1 = 最近一次保存 */
export const RestoreDC = /*@__PURE__*/ b('RestoreDC', '<HDC>ptr! i32 -> i32')
/** 设置多边形填充规则
 *  @returns 旧值（新建 DC 默认 ALTERNATE = 奇偶规则）
 *  @param args_0 hdc 目标 DC
 *  @param args_1 iMode gui.PolyFillMode.ALTERNATE（自相交区域交替镂空）/
 *  WINDING（非零环绕，自相交区域整体实心） */
export const SetPolyFillMode = /*@__PURE__*/ b('SetPolyFillMode', '<HDC>ptr! i32@PolyFillMode -> i32')
/** 设置前景画笔与目的像素的混合方式（二元光栅模式）；
 *  R2_XORPEN 可逆（同路径画两次抵消原样），适合橡皮筋交互
 *  @returns 旧值（默认 R2_COPYPEN = 直接画）
 *  @param args_0 hdc 目标 DC
 *  @param args_1 iMode gui.RasterMode.R2_COPYPEN / R2_XORPEN / R2_NOT 等（单选，标 @ 枚举） */
export const SetROP2 = /*@__PURE__*/ b('SetROP2', '<HDC>ptr! i32@RasterMode -> i32')
/** 设置弧/弦/扇形的扫过方向
 *  @returns 旧值（新 DC 默认逆时针）
 *  @param args_0 hdc 目标 DC
 *  @param args_1 iDir gui.ArcDirection.COUNTERCLOCKWISE（默认）/ CLOCKWISE */
export const SetArcDirection = /*@__PURE__*/ b('SetArcDirection', '<HDC>ptr! i32@ArcDirection -> i32')
/** 读弧扫过方向
 *  @returns AD_COUNTERCLOCKWISE=1 / AD_CLOCKWISE=2；失败 → 0 */
export const GetArcDirection = /*@__PURE__*/ b('GetArcDirection', '<HDC>ptr! -> i32')

/** 移动画笔当前位置；lppt 接旧位置出参
 *  @returns 成功 → 非 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 x 新位置 x
 *  @param args_2 y 新位置 y
 *  @param args_3 lppt 出参位：传 POINT.alloc() 的 .ptr 接旧位置，或传 NULL 不要 ——
 *  刻意不注册 encoder（纯出参；对象形物化进引擎持有的缓冲，调用方读不到） */
export const MoveToEx = /*@__PURE__*/ b('MoveToEx', '<HDC>ptr! i32 i32 <POINT>ptr -> i32')
/** 从当前位置画线到 (x,y)（不含端点），当前位置随之移动
 *  @returns 成功 → 非 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 x 终点 x
 *  @param args_2 y 终点 y */
export const LineTo = /*@__PURE__*/ b('LineTo', '<HDC>ptr! i32 i32 -> i32')

/** 画折线（当前画笔描边，不填充、不自动闭合）
 *  @returns 成功 → 非 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 pts 点数组（<POINT*>ptr 数组位；空数组引擎编为 NULL，C 侧返回 0）
 *  @param args_2 cPoints 点数（= pts.length，C 侧显式计数位） */
export const Polyline = /*@__PURE__*/ b('Polyline', '<HDC>ptr! <POINT*>ptr i32 -> i32', { POINT })
/** 多边形（画笔描边 + 当前画刷填充，首尾自动闭合）
 *  @returns 成功 → 非 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 pts 点数组（<POINT*>ptr 数组位，空数组引擎编为 NULL）
 *  @param args_2 cPoints 点数（= pts.length） */
export const Polygon = /*@__PURE__*/ b('Polygon', '<HDC>ptr! <POINT*>ptr i32 -> i32', { POINT })
/** 矩形（画笔描边 + 当前画刷填充；右/下边缘不画入区域）
 *  @returns 成功 → 非 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 l 左上 x
 *  @param args_2 t 左上 y
 *  @param args_3 r 右下 x（不含）
 *  @param args_4 b 右下 y（不含） */
export const Rectangle = /*@__PURE__*/ b('Rectangle', '<HDC>ptr! i32 i32 i32 i32 -> i32')
/** 椭圆（外接矩形内切，边缘可达四边中点；描边 + 填充）
 *  @returns 成功 → 非 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 l 外接矩形左 x
 *  @param args_2 t 外接矩形上 y
 *  @param args_3 r 外接矩形右 x
 *  @param args_4 b 外接矩形下 y */
export const Ellipse = /*@__PURE__*/ b('Ellipse', '<HDC>ptr! i32 i32 i32 i32 -> i32')
/** 圆角矩形（四角为 w×h 椭圆弧；描边 + 填充）
 *  @returns 成功 → 非 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 l 左上 x
 *  @param args_2 t 左上 y
 *  @param args_3 r 右下 x（不含）
 *  @param args_4 b 右下 y（不含）
 *  @param args_5 w 四角椭圆横半径
 *  @param args_6 h 四角椭圆纵半径 */
export const RoundRect = /*@__PURE__*/ b('RoundRect', '<HDC>ptr! i32 i32 i32 i32 i32 i32 -> i32')

/** 画圆弧（外接矩形内切椭圆上起点→终点的弧，默认逆时针、SetArcDirection 可改向；
 *  仅描边，不填充、不闭合）
 *  @returns 成功 → 非 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 l 外接矩形左 x
 *  @param args_2 t 外接矩形上 y
 *  @param args_3 r 外接矩形右 x
 *  @param args_4 b 外接矩形下 y
 *  @param args_5 xStart 弧起点 x（矩形中心与该点连线在弧上的交点为起端）
 *  @param args_6 yStart 弧起点 y
 *  @param args_7 xEnd 弧终点 x
 *  @param args_8 yEnd 弧终点 y */
export const Arc = /*@__PURE__*/ b('Arc', '<HDC>ptr! i32 i32 i32 i32 i32 i32 i32 i32 -> i32')
/** 弓形（弧 + 起终点间弦闭合；描边 + 当前画刷填充）
 *  @returns 成功 → 非 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 l 外接矩形左 x
 *  @param args_2 t 外接矩形上 y
 *  @param args_3 r 外接矩形右 x
 *  @param args_4 b 外接矩形下 y
 *  @param args_5 xStart 弧起点 x
 *  @param args_6 yStart 弧起点 y
 *  @param args_7 xEnd 弧终点 x
 *  @param args_8 yEnd 弧终点 y */
export const Chord = /*@__PURE__*/ b('Chord', '<HDC>ptr! i32 i32 i32 i32 i32 i32 i32 i32 -> i32')
/** 扇形（弧 + 中心到两端半径闭合；描边 + 当前画刷填充）
 *  @returns 成功 → 非 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 l 外接矩形左 x
 *  @param args_2 t 外接矩形上 y
 *  @param args_3 r 外接矩形右 x
 *  @param args_4 b 外接矩形下 y
 *  @param args_5 xStart 弧起点 x（半径端）
 *  @param args_6 yStart 弧起点 y
 *  @param args_7 xEnd 弧终点 x
 *  @param args_8 yEnd 弧终点 y */
export const Pie = /*@__PURE__*/ b('Pie', '<HDC>ptr! i32 i32 i32 i32 i32 i32 i32 i32 -> i32')

/** 底层文字输出（颜色走 SetTextColor、衬底走 SetBkMode/SetBkColor，位置受 SetTextAlign
 *  默认左上对齐约束）
 *  @returns 成功 → 非 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 x 起点 x
 *  @param args_2 y 起点 y
 *  @param args_3 str 文本（<WCHAR>ptr 位直传 string，引擎 UTF-16 编码并持活到调用结束）
 *  @param args_4 c 字符数（= str.length；C 要字符数不是字节数，不含 NUL） */
export const TextOut = /*@__PURE__*/ b('TextOutW', '<HDC>ptr! i32 i32 <WCHAR>ptr i32 -> i32')
/** 设置 TextOut/ExtTextOut 的对齐与当前位置更新方式；TA_* 按位组合
 *  （如 gui.TextAlign.TA_CENTER | gui.TextAlign.TA_UPDATECP），故签名保持 u32 不标枚举
 *  @returns 旧 flags（新 DC 默认 TA_LEFT|TA_TOP|TA_NOUPDATECP = 0）
 *  @param args_0 hdc 目标 DC
 *  @param args_1 fMode gui.TextAlign 成员按位或 */
export const SetTextAlign = /*@__PURE__*/ b('SetTextAlign', '<HDC>ptr! u32 -> u32')
/** 按当前字体量字符串宽高（不含衬底与额外间距）
 *  @returns 成功 → 非 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 str 文本（<WCHAR>ptr 直传 string）
 *  @param args_2 c 字符数（= str.length）
 *  @param args_3 lpSize 出参位：SIZE.alloc().ptr 接 { cx, cy }，SIZE.decode(ptr) 读回
 *  （标 !：没出参此 API 无意义） */
export const GetTextExtentPoint32 = /*@__PURE__*/ b('GetTextExtentPoint32W',
    '<HDC>ptr! <WCHAR>ptr i32 <SIZE>ptr! -> i32')
/** 取当前字体完整度量（行高/ascent/descent/字符宽等 20 字段）
 *  @returns 成功 → 非 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 lptm 出参位：TEXTMETRICW.alloc().ptr 接、TEXTMETRICW.decode(ptr) 读回
 *  （标 !：没出参此 API 无意义，同 GetTextExtentPoint32 的 SIZE 位） */
export const GetTextMetrics = /*@__PURE__*/ b('GetTextMetricsW',
    '<HDC>ptr! <TEXTMETRICW>ptr! -> i32')
/** 底层文字输出增强版（可选矩形衬底/裁剪 + 可选每字符间距）
 *  @returns 成功 → 非 0
 *  @param args_0 hdc 目标 DC
 *  @param args_1 x 起点 x
 *  @param args_2 y 起点 y
 *  @param args_3 fOptions gui.TextOutOptions.ETO_OPAQUE（矩形填衬底）|
 *  ETO_CLIPPED（矩形裁剪字形）按位或（可 0 = 都不用）
 *  @param args_4 lprc ETO_OPAQUE/ETO_CLIPPED 的作用矩形：DeepPartial 对象直传 /
 *  RECT.alloc().ptr / NULL = 整个当前可裁剪区（有 encoder 的纯入参位三形态）
 *  @param args_5 str 文本（<WCHAR>ptr 直传 string）
 *  @param args_6 c 字符数（= str.length）
 *  @param args_7 lpDx 每字符间距数组位：本版仅收 NULL（默认等宽间距），数组形态留后续 */
export const ExtTextOut = /*@__PURE__*/ b('ExtTextOutW',
    '<HDC>ptr! i32 i32 u32 <RECT>ptr <WCHAR>ptr i32 <>ptr -> i32', { RECT })
