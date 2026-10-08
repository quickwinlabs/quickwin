import { struct } from '../ffi/struct.js'

// 全仓库 Win32 结构的集中定义点（CType IR，按本机架构 MSVC 对齐；这批全为定长标量/字符串，
// ia32/x64 同布局）。形参位方向约定见 lib/windows/user32.ts 头注释：
//   纯入参位注册 encoder（DeepPartial 对象直传，缺省字段跳过），出参/双向位不注册
//   （位只收 def 分配的 .ptr，读回走 decode —— 对象 encode 进调用方拿不到的临时 buffer 会丢结果）。
// 每个定义的 struct() 调用前都标 @__PURE__（调用只构造定义、无副作用），esbuild 据此摇掉
// bundle 未引用的布局；集中到一个文件后没这个标记会把全部结构拖进每个 bundle。

/** 矩形（16B）：GetClientRect/GetWindowRect 出参、InvalidateRect/FillRect 入参 */
export const RECT = /* @__PURE__ */ struct('RECT', {
    left: 'i32',
    top: 'i32',
    right: 'i32',
    bottom: 'i32',
})

/** 点（8B）：GetCursorPos 出参、ScreenToClient/ClientToScreen 就地更新 */
export const POINT = /* @__PURE__ */ struct('POINT', {
    x: 'i32',
    y: 'i32',
})

/** 滚动参数（28B）：cbSize 必须 = SCROLLINFO.size（结构自描述是 Win32 要求，缺省跳过帮不了）；
 *  fMask = SIF_* 决定 Set 写哪些项 / Get 读哪些项 */
export const SCROLLINFO = /* @__PURE__ */ struct('SCROLLINFO', {
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
export const LOGFONTW = /* @__PURE__ */ struct('LOGFONTW', {
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
export const STARTUPINFOW = /* @__PURE__ */ struct('STARTUPINFOW', {
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
    wShowWindow: 'u16@ShowWindowCmd',
    cbReserved2: 'u16',
    lpReserved2: '<>ptr',
    hStdInput: '<HFILE>ptr',
    hStdOutput: '<HFILE>ptr',
    hStdError: '<HFILE>ptr',
})

/** 新进程信息（CreateProcessW 出参位：x86 16B / x64 24B）：hProcess/hThread 用完要 CloseHandle。
 *  字段标 '!'：CreatePipe/CreateProcess 成功路径下句柄必非零 —— decode 直出 Ptr 免收窄，
 *  且对 0 当场 throw：忘判 CreateProcess 成功就 decode 时在 decode 处拦下（下游 '! 消费位'
 *  的 callPacked 检查为第二层兜底）。 */
export const PROCESS_INFORMATION = /* @__PURE__ */ struct('PROCESS_INFORMATION', {
    hProcess: '<HPROCESS>ptr!',
    hThread: '<HTHREAD>ptr!',
    dwProcessId: 'u32',
    dwThreadId: 'u32',
})

/** 位图信息头（40B）：GetDIBits/SetDIBitsToDevice 的 BITMAPINFO 头部（32bpp BI_RGB 无颜色表，
 *  头部即全部）；biHeight 负 = 自顶向下；写 BMP 文件时也是文件内的信息头 */
export const BITMAPINFOHEADER = /* @__PURE__ */ struct('BITMAPINFOHEADER', {
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
export const BITMAPFILEHEADER = /* @__PURE__ */ struct('BITMAPFILEHEADER', {
    bfType: 'u16',
    bfSize: 'u32',
    bfReserved1: 'u16',
    bfReserved2: 'u16',
    bfOffBits: 'u32',
}, { pack: 2 })

// ── 通用对话框（跨组件/示例共享）───────────────────────────────────────

/** OPENFILENAMEW（GetOpenFileNameW）。Win2000+ 定义含尾部 pvReserved/dwReserved/FlagsEx
 *  （即 XP 系统上的真实 sizeof=152/88） */
export const OPENFILENAMEW = /* @__PURE__ */ struct('OPENFILENAMEW', {
    lStructSize: 'u32',
    hwndOwner: '<HWND>ptr',
    hInstance: '<HMODULE>ptr',
    lpstrFilter: '<>ptr',
    lpstrCustomFilter: '<>ptr',
    nMaxCustFilter: 'u32',
    nFilterIndex: 'u32',
    lpstrFile: '<>ptr',
    nMaxFile: 'u32',
    lpstrFileTitle: '<>ptr',
    nMaxFileTitle: 'u32',
    lpstrInitialDir: '<>ptr',
    lpstrTitle: '<>ptr',
    Flags: 'u32',
    nFileOffset: 'u16',
    nFileExtension: 'u16',
    lpstrDefExt: '<>ptr',
    lCustData: '<>ptr',
    lpfnHook: '<>ptr',
    lpTemplateName: '<>ptr',
    pvReserved: '<>ptr',
    dwReserved: 'u32',
    FlagsEx: 'u32',
})

/** BROWSEINFOW（SHBrowseForFolderW） */
export const BROWSEINFOW = /* @__PURE__ */ struct('BROWSEINFOW', {
    hwndOwner: '<HWND>ptr',
    pidlRoot: '<>ptr',
    pszDisplayName: '<>ptr',
    lpszTitle: '<>ptr',
    ulFlags: 'u32',
    lpfn: '<>ptr',
    lParam: '<>ptr',
    iImage: 'i32',
})

// ── WM_NOTIFY 通知结构（NMHDR 必须先定义，各通知结构嵌套其 __struct）────────

// NMHDR = hwndFrom(ptr) + idFrom(ptr) + code(i32)。
// 用 ffi-struct 定义以复现 MSVC/嵌套结构的“尾 padding 传染”（内嵌 NMHDR 占满 24/12 字节）。
// 各通知结构把它作为首字段嵌套（NMHDR.__struct），字段偏移由 struct 按进程位宽推出。
export const NMHDR = /* @__PURE__ */ struct('NMHDR', {
    hwndFrom: '<HWND>ptr',
    idFrom: '<>ptr',
    code: 'i32',
})

export const SYSTEMTIME = /* @__PURE__ */ struct('SYSTEMTIME', {
    wYear: 'u16',
    wMonth: 'u16',
    wDayOfWeek: 'u16',
    wDay: 'u16',
    wHour: 'u16',
    wMinute: 'u16',
    wSecond: 'u16',
    wMilliseconds: 'u16',
})

/** DTN_DATETIMECHANGE 通知（DateTimePicker）：NMHDR + dwFlags + SYSTEMTIME */
export const NMDATETIMECHANGE = /* @__PURE__ */ struct('NMDATETIMECHANGE', {
    hdr: NMHDR.__struct,
    dwFlags: 'u32',
    st: SYSTEMTIME.__struct,
})

// LITEM = Link 控件项。MAX_LINKID_TEXT = 48，L_MAX_URL_LENGTH = 2048 + 32 + sizeof("://") = 2084；
// 宽字符数组走字符串糖（'u16[N]@utf-16le'），decode 直接得到 string（读到 NUL 为止）。
export const LITEM = /* @__PURE__ */ struct('LITEM', {
    mask: 'u32',
    iLink: 'i32',
    state: 'u32',
    stateMask: 'u32',
    szID: 'u16[48]@utf-16le',
    szUrl: 'u16[2084]@utf-16le',
})

/** NMLINK = NMHDR + LITEM（Link 的 NM_CLICK 等通知） */
export const NMLINK = /* @__PURE__ */ struct('NMLINK', {
    hdr: NMHDR.__struct,
    item: LITEM.__struct,
})

/** NMCUSTOMDRAW（自绘通知基结构）：嵌套 NMHDR 以复现 MSVC 尾 padding 传染，offsetOf 保证 ia32/x64 均正确 */
export const NMCUSTOMDRAW = /* @__PURE__ */ struct('NMCUSTOMDRAW', {
    hdr: NMHDR.__struct,
    dwDrawStage: 'u32',
    hdc: '<HDC>ptr',
    rc: 'i32[4]',
    dwItemSpec: '<>ptr',
    uItemState: 'u32',
    lItemlParam: '<>ptr',
})

/** NMLVCUSTOMDRAW = NMCUSTOMDRAW + 颜色/子项字段（ListView 自绘） */
export const NMLVCUSTOMDRAW = /* @__PURE__ */ struct('NMLVCUSTOMDRAW', {
    hdr: NMHDR.__struct,
    dwDrawStage: 'u32',
    hdc: '<HDC>ptr',
    rc: 'i32[4]',
    dwItemSpec: '<>ptr',
    uItemState: 'u32',
    lItemlParam: '<>ptr',
    clrText: 'u32',
    clrTextBk: 'u32',
    iSubItem: 'i32',
    dwItemType: 'u32',
})

// NMLISTVIEW / NMITEMACTIVATE 前缀字段布局一致（iItem..uChanged）
export const NMLISTVIEW = /* @__PURE__ */ struct('NMLISTVIEW', {
    hdr: NMHDR.__struct,
    iItem: 'i32',
    iSubItem: 'i32',
    uNewState: 'u32',
    uOldState: 'u32',
    uChanged: 'u32',
    ptAction: 'i32[2]',
    lParam: '<>ptr',
})

// ── 通用控件（comctl32）结构 ────────────────────────────────────────

export const TCITEMW = /* @__PURE__ */ struct('TCITEMW', {
    mask: 'u32',
    dwState: 'u32',
    dwStateMask: 'u32',
    pszText: '<>ptr',
    cchTextMax: 'i32',
    iImage: 'i32',
    lParam: '<>ptr',
})

export const TTTOOLINFOW = /* @__PURE__ */ struct('TTTOOLINFOW', {
    cbSize: 'u32',
    uFlags: 'u32',
    hwnd: '<HWND>ptr',
    uId: '<>ptr',
    rect: 'i32[4]',
    hinst: '<HMODULE>ptr',
    lpszText: '<>ptr',
    lParam: '<>ptr',
    lpReserved: '<>ptr', // WinXP+ 追加字段（系统 sizeof 含之）
})

export const TVITEM = /* @__PURE__ */ struct('TVITEM', {
    mask: 'u32',
    hItem: '<>ptr',
    state: 'u32',
    stateMask: 'u32',
    pszText: '<>ptr',
    cchTextMax: 'i32',
    iImage: 'i32',
    iSelectedImage: 'i32',
    cChildren: 'i32',
    lParam: '<>ptr',
})

/** TVINSERTSTRUCT：hParent/hInsertAfter + item 内嵌 TVITEM（TreeView 插入项） */
export const TVINSERTSTRUCT = /* @__PURE__ */ struct('TVINSERTSTRUCT', {
    hParent: '<>ptr',
    hInsertAfter: '<>ptr',
    item: TVITEM.__struct,
})

/** LVM_SUBITEMHITTEST 的 LVHITTESTINFO（24B）：pt 是入参，iItem/iSubItem 是出参（入参先置 -1） */
export const LVHITTESTINFO = /* @__PURE__ */ struct('LVHITTESTINFO', {
    pt: 'i32[2]',
    flags: 'u32',
    iItem: 'i32',
    iSubItem: 'i32',
    iGroup: 'i32',
})

export const LVITEMW = /* @__PURE__ */ struct('LVITEMW', {
    mask: 'u32',
    iItem: 'i32',
    iSubItem: 'i32',
    state: 'u32',
    stateMask: 'u32',
    pszText: '<>ptr',
    cchTextMax: 'i32',
    iImage: 'i32',
    lParam: '<>ptr',
    iIndent: 'i32',
    iGroupId: 'i32',
    cColumns: 'u32',
    puColumns: '<>ptr',
    piColFmt: '<>ptr',
    iGroup: 'i32',
})

export const LVCOLUMNW = /* @__PURE__ */ struct('LVCOLUMNW', {
    mask: 'u32',
    fmt: 'i32',
    cx: 'i32',
    pszText: '<>ptr',
    cchTextMax: 'i32',
    iSubItem: 'i32',
    iImage: 'i32',
    iOrder: 'i32',
    cxMin: 'i32',
    cxDefault: 'i32',
    cxIdeal: 'i32',
})
