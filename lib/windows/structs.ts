import { struct } from '../ffi/struct.js'

// lib/windows 消费的 Win32 结构（CType IR，按本机架构 MSVC 对齐；这批全为定长标量/字符串，
// ia32/x64 同布局）。形参位方向约定见 lib/windows/user32.ts 头注释：
//   纯入参位注册 encoder（DeepPartial 对象直传，缺省字段跳过），出参/双向位不注册
//   （位只收 def 分配的 .ptr，读回走 decode —— 对象 encode 进调用方拿不到的临时 buffer 会丢结果）。

/** 矩形（16B）：GetClientRect/GetWindowRect 出参、InvalidateRect/FillRect 入参 */
export const RECT = struct('RECT', {
    left: 'i32',
    top: 'i32',
    right: 'i32',
    bottom: 'i32',
})

/** 点（8B）：GetCursorPos 出参、ScreenToClient/ClientToScreen 就地更新 */
export const POINT = struct('POINT', {
    x: 'i32',
    y: 'i32',
})

/** 滚动参数（28B）：cbSize 必须 = SCROLLINFO.size（结构自描述是 Win32 要求，缺省跳过帮不了）；
 *  fMask = SIF_* 决定 Set 写哪些项 / Get 读哪些项 */
export const SCROLLINFO = struct('SCROLLINFO', {
    cbSize: 'u32',
    fMask: 'u32',
    nMin: 'i32',
    nMax: 'i32',
    nPage: 'u32',
    nPos: 'i32',
    nTrackPos: 'i32',
})

/** LOGFONTW（92B）：lfFaceName 走字符串糖（u16[32]@utf-16le）直读写 string；
 *  精度/质量类字段缺省跳过 = 保持 0（FW_DONTCARE/ANSI_CHARSET 等合法零值语义） */
export const LOGFONTW = struct('LOGFONTW', {
    lfHeight: 'i32',
    lfWidth: 'i32',
    lfEscapement: 'i32',
    lfOrientation: 'i32',
    lfWeight: 'i32',
    lfItalic: 'u8',
    lfUnderline: 'u8',
    lfStrikeOut: 'u8',
    lfCharSet: 'u8',
    lfOutPrecision: 'u8',
    lfClipPrecision: 'u8',
    lfQuality: 'u8',
    lfPitchAndFamily: 'u8',
    lfFaceName: 'u16[32]@utf-16le',
})
