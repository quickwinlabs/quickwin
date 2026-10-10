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

/** 尺寸（8B，双架构同布局）：Button BM_GETIDEALSIZE 等出参槽（cx/cy 像素） */
export const SIZE = /* @__PURE__ */ struct('SIZE', {
    cx: 'i32',
    cy: 'i32',
})

/** 混合函数（4B，双架构同布局）：AlphaBlend 末参**按值**传（bind 的按值位
 *  `<BLENDFUNCTION>`，非 `<BLENDFUNCTION>ptr`）——4B POD 聚合体在 x64 走位置寄存器、
 *  ia32 压 4 字节，字段序须与 windows.h 逐字节一致。BlendOp 仅 AC_SRC_OVER(0)、
 *  BlendFlags 恒 0（MSDN）；AC_SRC_ALPHA(1) 是 AlphaFormat 的值（源带 premultiplied
 *  alpha 通道时置位）。纯入参位注册 encoder（对象直传，缺省字段跳过的零值合法）。 */
export const BLENDFUNCTION = /* @__PURE__ */ struct('BLENDFUNCTION', {
    BlendOp: 'u8',
    BlendFlags: 'u8',
    SourceConstantAlpha: 'u8',
    AlphaFormat: 'u8',
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

/** TEXTMETRICW（60B = 11 LONG + 4 WCHAR + 5 BYTE 尾部补齐，双架构同布局）：
 *  GetTextMetrics 纯出参位（不注册 encoder：TEXTMETRICW.alloc().ptr 进、decode 读回） */
export const TEXTMETRICW = /* @__PURE__ */ struct('TEXTMETRICW', {
    tmHeight: 'i32',
    tmAscent: 'i32',
    tmDescent: 'i32',
    tmInternalLeading: 'i32',
    tmExternalLeading: 'i32',
    tmAveCharWidth: 'i32',
    tmMaxCharWidth: 'i32',
    tmWeight: 'i32',
    tmOverhang: 'i32',
    tmDigitizedAspectX: 'i32',
    tmDigitizedAspectY: 'i32',
    tmFirstChar: 'u16',
    tmLastChar: 'u16',
    tmDefaultChar: 'u16',
    tmBreakChar: 'u16',
    tmItalic: 'u8',
    tmUnderlined: 'u8',
    tmStruckOut: 'u8',
    tmPitchAndFamily: 'u8',
    tmCharSet: 'u8',
})

/** WIN32_FIND_DATAW（592B 双架构同布局 = 8 头字段 44B + WCHAR[260] + WCHAR[14]，
 *  mingw wingdi.h 的 cAlternateFileName 为 WCHAR[14] 非 MSDN 的 CHAR[14]）：
 *  FindFirstFile/FindNextFile 纯出参位（不注册 encoder：WIN32_FIND_DATAW.alloc().ptr
 *  进、decode 读回）。FILETIME 是 align 4 的 8B 时间，以 u64 + pack 4 忠实布局
 *  （u64 自然 align 8 须 pack 压到 4）；时间值为 1601 起的 100ns 单元（bigint） */
export const WIN32_FIND_DATAW = /* @__PURE__ */ struct('WIN32_FIND_DATAW', {
    dwFileAttributes: 'u32',
    ftCreationTime: 'u64',
    ftLastAccessTime: 'u64',
    ftLastWriteTime: 'u64',
    nFileSizeHigh: 'u32',
    nFileSizeLow: 'u32',
    dwReserved0: 'u32',
    dwReserved1: 'u32',
    cFileName: 'u16[260]@utf-16le',
    cAlternateFileName: 'u16[14]@utf-16le',
}, { pack: 4 })

/** DOC_INFO_1W（3 指针随位宽：x64 24B / ia32 12B）：StartDocPrinter 纯入参位
 *  （注册 encoder：{ pDocName: WCHAR.encode(s).ptr, ... } 对象直传——指针字段收裸
 *  地址 number，字符串缓冲自行 WCHAR.encode 分配并保持引用） */
export const DOC_INFO_1W = /* @__PURE__ */ struct('DOC_INFO_1W', {
    pDocName: '<>ptr',
    pOutputFile: '<>ptr',
    pDatatype: '<>ptr',
})

/** PRINTER_INFO_2W（13 指针 + 8 DWORD：x64 136B / ia32 84B，双架构已由 test_ffi raw 实测）：
 *  EnumPrinters(Level=2) 出参数组元素。指针字段 decode 出地址 number，字符串须
 *  逐字宽读跟进；数组 = 单缓冲读回（structArray().decode(buf, count)：元素间无空洞，
 *  但缓冲尾部含字符串区 → byteLength 非整数倍，须显式 count）。纯出参不注册 encoder */
export const PRINTER_INFO_2W = /* @__PURE__ */ struct('PRINTER_INFO_2W', {
    pServerName: '<>ptr',
    pPrinterName: '<>ptr',
    pShareName: '<>ptr',
    pPortName: '<>ptr',
    pDriverName: '<>ptr',
    pComment: '<>ptr',
    pLocation: '<>ptr',
    pDevMode: '<>ptr',
    pSepFile: '<>ptr',
    pPrintProcessor: '<>ptr',
    pDatatype: '<>ptr',
    pParameters: '<>ptr',
    pSecurityDescriptor: '<>ptr',
    Attributes: 'u32',
    Priority: 'u32',
    DefaultPriority: 'u32',
    StartTime: 'u32',
    UntilTime: 'u32',
    Status: 'u32',
    cJobs: 'u32',
    AveragePPM: 'u32',
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

// ── 消息循环 / 绘制 / 窗口类（user32；偏移经 MinGW 头 x64+ia32 双架构实测）────────

/** MSG（48B x64 / 28B ia32）：GetMessage/PeekMessage/DispatchMessage 的消息槽 */
export const MSG = /* @__PURE__ */ struct('MSG', {
    hwnd: '<HWND>ptr',
    message: 'u32',
    wParam: '<>ptr',
    lParam: '<>ptr',
    time: 'u32',
    pt: POINT.__struct,
})

/** PAINTSTRUCT（72B x64 / 64B ia32）：BeginPaint 出参（整结构由 API 写入），EndPaint 归还 */
export const PAINTSTRUCT = /* @__PURE__ */ struct('PAINTSTRUCT', {
    hdc: '<HDC>ptr',
    fErase: 'i32',
    rcPaint: RECT.__struct,
    fRestore: 'i32',
    fIncUpdate: 'i32',
    rgbReserved: 'u8[32]',
})

/** WNDCLASSEXW（80B x64 / 48B ia32）：RegisterClassExW 入参；cbSize 必须 = WNDCLASSEXW.size */
export const WNDCLASSEXW = /* @__PURE__ */ struct('WNDCLASSEXW', {
    cbSize: 'u32',
    style: 'u32',
    lpfnWndProc: '<>ptr',
    cbClsExtra: 'i32',
    cbWndExtra: 'i32',
    hInstance: '<HMODULE>ptr',
    hIcon: '<>ptr',
    hCursor: '<>ptr',
    hbrBackground: '<>ptr',
    lpszMenuName: '<>ptr',
    lpszClassName: '<>ptr',
    hIconSm: '<>ptr',
})

// ── 显示模式（user32 EnumDisplaySettingsW/ChangeDisplaySettingsW）────────────────

/** DEVMODEW（220B，双架构同布局）：显示模式描述。dmFields = DM_* 决定 Change 生效项。
 *  union 的 display 分支平铺（dmPosition/ dmDisplayOrientation/ dmDisplayFixedOutput）——
 *  printer 分支同为 16B，平铺后偏移与 sizeof 均与实测一致；printer 场景不在本库用途内。
 *  dmSize/ dmDriverExtra 入参先置（dmSize = DEVMODEW.size；dmDriverExtra = 0），否则 API 拒绝 */
export const DEVMODEW = /* @__PURE__ */ struct('DEVMODEW', {
    dmDeviceName: 'u16[32]@utf-16le',
    dmSpecVersion: 'u16',
    dmDriverVersion: 'u16',
    dmSize: 'u16',
    dmDriverExtra: 'u16',
    dmFields: 'u32',
    dmPosition: 'i32[2]',
    dmDisplayOrientation: 'u32',
    dmDisplayFixedOutput: 'u32',
    dmColor: 'i16',
    dmDuplex: 'i16',
    dmYResolution: 'i16',
    dmTTOption: 'i16',
    dmCollate: 'i16',
    dmFormName: 'u16[32]@utf-16le',
    dmLogPixels: 'u16',
    dmBitsPerPel: 'u32',
    dmPelsWidth: 'u32',
    dmPelsHeight: 'u32',
    dmDisplayFlags: 'u32',
    dmDisplayFrequency: 'u32',
    dmICMMethod: 'u32',
    dmICMIntent: 'u32',
    dmMediaType: 'u32',
    dmDitherType: 'u32',
    dmReserved1: 'u32',
    dmReserved2: 'u32',
    dmPanningWidth: 'u32',
    dmPanningHeight: 'u32',
})

// ── 系统版本（ntdll RtlGetVersion）────────────────────────────────────────────

/** RtlGetVersion 的版本信息缓冲（148B，非标准 OSVERSIONINFOW）：按 148 字节分配并把
 *  dwOSVersionInfoSize 填成同值（尾部 128 字节 = szCSDVersion 区），否则 RtlGetVersion
 *  会越界写坏调用方堆导致子进程挂起。标准 OSVERSIONINFOW（宽字符 szCSDVersion[128]）
 *  应为 276B；148 是 win11 上实测过的值，保持不变 */
export const OSVERSIONINFO_148 = /* @__PURE__ */ struct('OSVERSIONINFO_148', {
    dwOSVersionInfoSize: 'u32',
    dwMajorVersion: 'u32',
    dwMinorVersion: 'u32',
    dwBuildNumber: 'u32',
    dwPlatformId: 'u32',
    szCSDVersion: 'u8[128]',
})

// ── 进程快照 / 内存统计（toolhelp + psapi，布局来源官方 tlhelp32.h / psapi.h）────────

/** PROCESSENTRY32W（Process32First/Next 就地迭代位；x86 556B / x64 564B——ULONG_PTR
 *  th32DefaultHeapID 随位宽，struct 按 os.arch 推）：调用前须把 offset 0 的 dwSize 预写
 *  成 size（MSDN：不初始化 dwSize 则 Process32First 失败）——alloc() 后
 *  new Uint32Array(buf)[0] = PROCESSENTRY32W.size 一次；First/Next 迭代间复用同一 buf
 *  （API 只改内容不改 dwSize），每轮 N.decode(buf) 读回 */
export const PROCESSENTRY32W = /* @__PURE__ */ struct('PROCESSENTRY32W', {
    dwSize: 'u32',
    cntUsage: 'u32',
    th32ProcessID: 'u32',
    th32DefaultHeapID: '<>ptr',
    th32ModuleID: 'u32',
    cntThreads: 'u32',
    th32ParentProcessID: 'u32',
    pcPriClassBase: 'i32',
    dwFlags: 'u32',
    szExeFile: 'u16[260]@utf-16le',
})

/** MODULEENTRY32W（Module32First/Next 就地迭代位；x86 1072B / x64 1088B——BYTE* +
 *  HMODULE 随位宽）。dwSize 预写同 PROCESSENTRY32W；modBaseAddr/hModule 仅在
 *  th32ProcessID 的进程上下文有效；szModule 定长 256 = MAX_MODULE_NAME32+1 */
export const MODULEENTRY32W = /* @__PURE__ */ struct('MODULEENTRY32W', {
    dwSize: 'u32',
    th32ModuleID: 'u32',
    th32ProcessID: 'u32',
    GlblcntUsage: 'u32',
    ProccntUsage: 'u32',
    modBaseAddr: '<>ptr',
    modBaseSize: 'u32',
    hModule: '<HMODULE>ptr',
    szModule: 'u16[256]@utf-16le',
    szExePath: 'u16[260]@utf-16le',
})

/** PROCESS_MEMORY_COUNTERS（GetProcessMemoryInfo 出参位；x86 40B / x64 72B）：官方 psapi.h
 *  为 cb + PageFaultCount 后接 8×SIZE_T——SIZE_T 随位宽（非全 DWORD），struct 按 os.arch 推。
 *  调用前 offset 0 的 cb 预写成 size（new Uint32Array(buf)[0] = N.size），实参 u32 cb 同传 size */
export const PROCESS_MEMORY_COUNTERS = /* @__PURE__ */ struct('PROCESS_MEMORY_COUNTERS', {
    cb: 'u32',
    PageFaultCount: 'u32',
    PeakWorkingSetSize: '<>ptr',
    WorkingSetSize: '<>ptr',
    QuotaPeakPagedPoolUsage: '<>ptr',
    QuotaPagedPoolUsage: '<>ptr',
    QuotaPeakNonPagedPoolUsage: '<>ptr',
    QuotaNonPagedPoolUsage: '<>ptr',
    PagefileUsage: '<>ptr',
    PeakPagefileUsage: '<>ptr',
})
