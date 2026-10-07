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

/** 进程启动信息（CreateProcessW 纯入参位）：指针字段随进程位宽（x86 68B / x64 104B，struct 按 os.arch 推，
 *  os.arch 是编译期进程指针宽度，WOW64 下 32 位进程得 ia32 布局）。cb 必须 = STARTUPINFOW.size
 *  （结构自描述是 Win32 要求）；dwFlags 含 STARTF_USESTDHANDLES(0x100) 时才读 hStd* */
export const STARTUPINFOW = struct('STARTUPINFOW', {
    cb: 'u32',
    lpReserved: '<>ptr',
    lpDesktop: '<>ptr',
    lpTitle: '<>ptr',
    dwX: 'u32',
    dwY: 'u32',
    dwXSize: 'u32',
    dwYSize: 'u32',
    dwXCountChars: 'u32',
    dwYCountChars: 'u32',
    dwFillAttribute: 'u32',
    dwFlags: 'u32',
    wShowWindow: 'u16',
    cbReserved2: 'u16',
    lpReserved2: '<>ptr',
    hStdInput: '<>ptr',
    hStdOutput: '<>ptr',
    hStdError: '<>ptr',
})

/** 新进程信息（CreateProcessW 出参位：x86 16B / x64 24B）：hProcess/hThread 用完要 CloseHandle */
export const PROCESS_INFORMATION = struct('PROCESS_INFORMATION', {
    hProcess: '<>ptr',
    hThread: '<>ptr',
    dwProcessId: 'u32',
    dwThreadId: 'u32',
})

/** 位图信息头（40B）：GetDIBits/SetDIBitsToDevice 的 BITMAPINFO 头部（32bpp BI_RGB 无颜色表，
 *  头部即全部）；biHeight 负 = 自顶向下；写 BMP 文件时也是文件内的信息头 */
export const BITMAPINFOHEADER = struct('BITMAPINFOHEADER', {
    biSize: 'u32',
    biWidth: 'i32',
    biHeight: 'i32',
    biPlanes: 'u16',
    biBitCount: 'u16',
    biCompression: 'u32',
    biSizeImage: 'u32',
    biXPelsPerMeter: 'i32',
    biYPelsPerMeter: 'i32',
    biClrUsed: 'u32',
    biClrImportant: 'u32',
})

/** BMP 文件头（14B，pack 2：文件格式按 2 字节紧凑排布，不是 Win32 调用的结构）：
 *  bfType = 0x4d42（'BM'），bfOffBits = 14 + 40（文件头 + 信息头，无颜色表） */
export const BITMAPFILEHEADER = struct('BITMAPFILEHEADER', {
    bfType: 'u16',
    bfSize: 'u32',
    bfReserved1: 'u16',
    bfReserved2: 'u16',
    bfOffBits: 'u32',
}, { pack: 2 })
