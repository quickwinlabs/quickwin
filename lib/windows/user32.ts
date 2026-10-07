// user32.dll 精选高频 API（85 个），逐函数独立导出：
//   - 签名对照 mingw winuser.h 原型手写；未被 import 的绑定经 esbuild 摇树不进产物
//   - WPARAM / LPARAM / LRESULT / UINT_PTR / LONG_PTR 及句柄混合值一律 <>ptr（指针宽度跨
//     架构正确；返回值 0 归一为 null、有符号读对齐 C 版 JS_NewInt64——-1 哨兵等负值保真）
//   - 入参字符串用 <WCHAR>ptr（string 编码为 UTF-16 + NUL，null → NULL 指针）；文本出参缓冲
//     用 <BYTE>ptr（宽字符串出参配 WCHAR.alloc(n).buf 当 buffer、WCHAR.decode(buf) 读回）；
//     回调参数用 <>ptr 接 closure() 的 ptr
//   - 结构位按方向分流（结构定义见 ./structs.ts）：
//       纯入参位 <N>ptr + 注册 encoder → DeepPartial 对象直传（缺省字段 doEncode 跳过）、
//         encode().ptr、null 三形态；
//       出参/就地位 <N>ptr 不注册 encoder → 位只收 def 分配的 .ptr（对象 encode 进调用方拿不到
//         的临时 buffer 会丢结果；ArrayBuffer 由 unknown layout fail-fast 拦下），
//         读回走 N.decode(buf|ptr)。统一流程：encode → call → decode
//   - 签名里的 LPCWSTR 若语义是 MAKEINTRESOURCE 整数（如 LoadCursorW 光标名），该位用 <>ptr
//   - HDC 借出/归还用 <HDC>ptr（品牌指针 Ptr<'HDC'>）：ReleaseDC 等归还位由 tsc 校验配对、
//     拦住误传 HWND；DrawText/FillRect 等消费位仍收 <>ptr（brand 是 number 子类型可直传）
//   - 返回/入参句柄位品牌化：HWND（窗口句柄形参与返回）、HMENU（菜单组出入参）、
//     HCURSOR（LoadCursor/SetCursor）一律 <N>ptr → Ptr<'N'> | null；gui.HWND 与
//     Ptr<"HWND"> 结构同型（quickwin.d.ts 字符串键 brand），react-qw 直传零桥接。
//     异种句柄互传（如 GetDesktopWindow() → DestroyMenu）由 tsc 拦下。混合值位保持
//     <>ptr：SetWindowPos 的 hWndInsertAfter（HWND_TOP 等常量）、AppendMenu.uIDNewItem
//     （命令 ID 或子菜单句柄）、MAKEINTRESOURCE 光标名，以及 HINSTANCE / HGLOBAL /
//     HBRUSH / 回调等非清单句柄
import * as os from 'os'
import { bind, type CodecMap } from '../ffi/bind.js'
// 只 import 注册了 encoder 的结构（纯入参位）；POINT 等出/就地位不注册，运行时无需引用
import { RECT, SCROLLINFO } from './structs.js'

// dll 名部分应用：85 个绑定共用，签名字符串不再重复 'user32.dll'。
// 不能用 bind.bind(null, dll)——泛型在部分应用点坍缩（返回 never）；工厂转调让
// S/LE/LD 在调用点正常 infer。第三参透传 encoders（结构入参位注册，见头注释方向约定）。
const b = <const S extends string, const LE extends CodecMap = {}>(name: string, sig: S, encoders?: LE) =>
    bind('user32.dll', name, sig, encoders)
// 推导保真探针：若返回类型退化（any/never 可赋给 string），本行不报错 → expect-error unused 反向暴露
// @ts-expect-error 函数返回值不能赋给 string
const _bProbe: string = b('GetDesktopWindow', ' -> <HWND>ptr')
void _bProbe

// ia32 的 user32.dll 不导出 *LongPtrW（32 位下它们是 Get/SetWindowLongW 的宏，mingw
// 仅 x64 提供真实符号）——按架构选真实导出名，导出名保持统一。
const LONG_PTR_SYM = os.arch === 'x64' ? 'PtrW' : 'W'

// ============ 窗口 / 基本 ============

/** 创建窗口（class/窗口名可传 string 或 null；hWndParent 收品牌 HWND、hMenu 收品牌 HMENU，均可 null）；失败 → null */
export const CreateWindowEx = /*@__PURE__*/ b('CreateWindowExW',
    'u32 <WCHAR>ptr <WCHAR>ptr u32 i32 i32 i32 i32 <HWND>ptr <HMENU>ptr <>ptr <>ptr -> <HWND>ptr')
/** 销毁窗口；成功 → 非 0 */
export const DestroyWindow = /*@__PURE__*/ b('DestroyWindow', '<HWND>ptr -> i32')
/** 显示/隐藏窗口（nCmdShow = gui.WindowStyle 类常量）；返回先前可见性 */
export const ShowWindow = /*@__PURE__*/ b('ShowWindow', '<HWND>ptr i32 -> i32')
/** 移动/缩放窗口；bRepaint 非 0 重绘 */
export const MoveWindow = /*@__PURE__*/ b('MoveWindow', '<HWND>ptr i32 i32 i32 i32 i32 -> i32')
/** 设窗口位置/层级（hWndInsertAfter 为 HWND 或 HWND_TOP 等常量——混合位保持 <>ptr） */
export const SetWindowPos = /*@__PURE__*/ b('SetWindowPos', '<HWND>ptr <>ptr i32 i32 i32 i32 u32 -> i32')
/** 取窗口外框矩形（屏幕坐标）；出参 encode → call → decode：RECT.encode() 传 .ptr、RECT.decode(实例) 读回 */
export const GetWindowRect = /*@__PURE__*/ b('GetWindowRect', '<HWND>ptr <RECT>ptr -> i32')
/** 取窗口客户区矩形；出参同上（encode → call → decode） */
export const GetClientRect = /*@__PURE__*/ b('GetClientRect', '<HWND>ptr <RECT>ptr -> i32')
/** 是否有效窗口句柄；是 → 非 0 */
export const IsWindow = /*@__PURE__*/ b('IsWindow', '<HWND>ptr -> i32')
/** 窗口是否可见；是 → 非 0 */
export const IsWindowVisible = /*@__PURE__*/ b('IsWindowVisible', '<HWND>ptr -> i32')
/** 窗口是否最小化；是 → 非 0 */
export const IsIconic = /*@__PURE__*/ b('IsIconic', '<HWND>ptr -> i32')
/** 取前台窗口句柄；无 → null */
export const GetForegroundWindow = /*@__PURE__*/ b('GetForegroundWindow', ' -> <HWND>ptr')
/** 请求设前台窗口；成功 → 非 0 */
export const SetForegroundWindow = /*@__PURE__*/ b('SetForegroundWindow', '<HWND>ptr -> i32')
/** 取桌面窗口句柄（恒非 null） */
export const GetDesktopWindow = /*@__PURE__*/ b('GetDesktopWindow', ' -> <HWND>ptr')
/** 按类名+标题查找顶层窗口；无 → null（两个参数都可传 null） */
export const FindWindow = /*@__PURE__*/ b('FindWindowW', '<WCHAR>ptr <WCHAR>ptr -> <HWND>ptr')
/** 在 hWndParent 的子窗口链里按类名+标题查找，从 hWndChildAfter 之后开始（均可传 NULL：
 *  parent = NULL 遍历顶层窗口，childAfter = NULL 从头开始，class/title = NULL 不过滤）；
 *  无更多窗口 → NULL。链式遍历：FindWindowEx(NULL, prev, NULL, NULL) */
export const FindWindowEx = /*@__PURE__*/ b('FindWindowExW',
    '<HWND>ptr <HWND>ptr <WCHAR>ptr <WCHAR>ptr -> <HWND>ptr')
/** 取窗口标题（宽字符写入 out buffer，返回写入字符数，不含 NUL）；
 *  out 传 WCHAR.alloc(n).buf（n = 字符数），读回 WCHAR.decode(buf) */
export const GetWindowText = /*@__PURE__*/ b('GetWindowTextW', '<HWND>ptr <BYTE>ptr i32 -> i32')
/** 设窗口标题（传 string 或 null 清空）；成功 → 非 0 */
export const SetWindowText = /*@__PURE__*/ b('SetWindowTextW', '<HWND>ptr <WCHAR>ptr -> i32')
/** 取窗口标题长度（字符数，不含 NUL） */
export const GetWindowTextLength = /*@__PURE__*/ b('GetWindowTextLengthW', '<HWND>ptr -> i32')
/** 取窗口类名（宽字符写入 out buffer，返回字符数）；
 *  out 传 WCHAR.alloc(n).buf（n = 字符数），读回 WCHAR.decode(buf) */
export const GetClassName = /*@__PURE__*/ b('GetClassNameW', '<HWND>ptr <BYTE>ptr i32 -> i32')
/** 取窗口附加数据（GWLP_* / GWL_* 索引）；0 → null（值有符号读；ia32 走 GetWindowLongW） */
export const GetWindowLongPtr = /*@__PURE__*/ b('GetWindowLong' + LONG_PTR_SYM, '<HWND>ptr i32 -> <>ptr')
/** 设窗口附加数据；返回先前值（0 → null，值有符号读） */
export const SetWindowLongPtr = /*@__PURE__*/ b('SetWindowLong' + LONG_PTR_SYM, '<HWND>ptr i32 <>ptr -> <>ptr')
/** 取窗口所属进程 ID 到 buffer（可传 null）；返回线程 ID */
export const GetWindowThreadProcessId = /*@__PURE__*/ b('GetWindowThreadProcessId', '<HWND>ptr <BYTE>ptr -> u32')
/** 启用/禁用窗口输入；返回先前状态 */
export const EnableWindow = /*@__PURE__*/ b('EnableWindow', '<HWND>ptr i32 -> i32')
/** 取父窗口；无 → null */
export const GetParent = /*@__PURE__*/ b('GetParent', '<HWND>ptr -> <HWND>ptr')
/** 设父窗口；返回先前父窗口 */
export const SetParent = /*@__PURE__*/ b('SetParent', '<HWND>ptr <HWND>ptr -> <HWND>ptr')
/** 按关系（GW_* / GW_OWNER）取相邻窗口；无 → null */
export const GetWindow = /*@__PURE__*/ b('GetWindow', '<HWND>ptr u32 -> <HWND>ptr')
/** 注册窗口类（WNDCLASSEXW 结构 buffer）；失败 → 0（ATOM） */
export const RegisterClassEx = /*@__PURE__*/ b('RegisterClassExW', '<BYTE>ptr -> u16')

// ============ 焦点 / 激活 ============

/** 设输入焦点；返回先前焦点窗口 */
export const SetFocus = /*@__PURE__*/ b('SetFocus', '<HWND>ptr -> <HWND>ptr')
/** 取调用线程输入焦点；无 → null */
export const GetFocus = /*@__PURE__*/ b('GetFocus', ' -> <HWND>ptr')
/** 取调用线程激活窗口；无 → null */
export const GetActiveWindow = /*@__PURE__*/ b('GetActiveWindow', ' -> <HWND>ptr')
/** 设调用线程激活窗口；返回先前窗口 */
export const SetActiveWindow = /*@__PURE__*/ b('SetActiveWindow', '<HWND>ptr -> <HWND>ptr')

// ============ 消息循环 ============

/** 取消息（MSG buffer，第二参 hwndFilter 收品牌 HWND 可 null；阻塞式，-1 = 出错、0 = WM_QUIT、>0 = 有消息）；分发前先 TranslateMessage */
export const GetMessage = /*@__PURE__*/ b('GetMessageW', '<BYTE>ptr <HWND>ptr u32 u32 -> i32')
/** 非阻塞查消息（第二参同上；wRemoveMsg = PM_NOREMOVE/PM_REMOVE）；有消息 → 非 0 */
export const PeekMessage = /*@__PURE__*/ b('PeekMessageW', '<BYTE>ptr <HWND>ptr u32 u32 u32 -> i32')
/** 把 WM_KEYDOWN/UP 转成字符消息（翻译结果留在队列）；可翻译 → 非 0 */
export const TranslateMessage = /*@__PURE__*/ b('TranslateMessage', '<BYTE>ptr -> i32')
/** 分发 MSG 给窗口过程；返回处理结果（0 → null，有符号读） */
export const DispatchMessage = /*@__PURE__*/ b('DispatchMessageW', '<BYTE>ptr -> <>ptr')
/** 异步投递消息到窗口线程队列；成功 → 非 0 */
export const PostMessage = /*@__PURE__*/ b('PostMessageW', '<HWND>ptr u32 <>ptr <>ptr -> i32')
/** 同步发送消息并等窗口过程处理；返回处理结果（0 → null，有符号读） */
export const SendMessage = /*@__PURE__*/ b('SendMessageW', '<HWND>ptr u32 <>ptr <>ptr -> <>ptr')
/** 退出消息循环（投递 WM_QUIT，wParam = 退出码） */
export const PostQuitMessage = /*@__PURE__*/ b('PostQuitMessage', 'i32 -> void')
/** 默认窗口过程（未处理消息的兜底）；返回处理结果（0 → null，有符号读） */
export const DefWindowProc = /*@__PURE__*/ b('DefWindowProcW', '<HWND>ptr u32 <>ptr <>ptr -> <>ptr')
/** 调用窗口过程（wndProc = GetWindowLongPtr(GWLP_WNDPROC) 读回的过程指针——无品牌混合位 <>ptr，
 *  仅对本线程窗口调用）；返回处理结果（0 → null，有符号读） */
export const CallWindowProc = /*@__PURE__*/ b('CallWindowProcW', '<>ptr <HWND>ptr u32 <>ptr <>ptr -> <>ptr')
/** 注册系统级唯一消息 ID（按字符串比较）；失败 → 0 */
export const RegisterWindowMessage = /*@__PURE__*/ b('RegisterWindowMessageW', '<WCHAR>ptr -> u32')

// ============ 绘制 / DC ============

/** 取窗口 DC（hWnd 传 null → 桌面窗口）；返回品牌 HDC，失败 → null；用完必须 ReleaseDC 配对 */
export const GetDC = /*@__PURE__*/ b('GetDC', '<HWND>ptr -> <HDC>ptr')
/** 归还 GetDC/GetWindowDC 取的 DC（首参收品牌 HWND、第二参收品牌 HDC，误传编译不过）；成功 → 非 0 */
export const ReleaseDC = /*@__PURE__*/ b('ReleaseDC', '<HWND>ptr <HDC>ptr -> i32')
/** 让窗口把自己画进 hdcBlt（可截被遮挡 / 最小化的窗口；位图须按整窗尺寸建，从 (0,0) 填满）；
 *  nFlags = PW_CLIENTONLY(1) / PW_RENDERFULLCONTENT(2，Win8.1+)，XP/Win7 传 0；成功 → 非 0 */
export const PrintWindow = /*@__PURE__*/ b('PrintWindow', '<HWND>ptr <HDC>ptr u32 -> i32')
/** 取整个窗口（含边框标题）DC；返回品牌 HDC，失败 → null，配对 ReleaseDC */
export const GetWindowDC = /*@__PURE__*/ b('GetWindowDC', '<HWND>ptr -> <HDC>ptr')
/** 开始重绘（PAINTSTRUCT buffer 接收绘制信息）；返回品牌 HDC，配对 EndPaint */
export const BeginPaint = /*@__PURE__*/ b('BeginPaint', '<HWND>ptr <BYTE>ptr -> <HDC>ptr')
/** 结束重绘（传 BeginPaint 同一 buffer）；成功 → 非 0 */
export const EndPaint = /*@__PURE__*/ b('EndPaint', '<HWND>ptr <BYTE>ptr -> i32')
/** 文本排版绘制（首参品牌 HDC 的 number 子类型直传；format = gui.DrawTextFlag；rect 双向不注册
 *  encoder——CALCRECT 就地写回须持 buffer：RECT.encode(初值) 传 .ptr、完成后 RECT.decode(实例) 读回）；返回文本行高 */
export const DrawText = /*@__PURE__*/ b('DrawTextW', '<>ptr <WCHAR>ptr i32 <RECT>ptr i32 -> i32')
/** 用画刷填充矩形（首参 HDC 同上；rect 收 DeepPartial RECT 对象 / encode().ptr；第三参 HBRUSH 无品牌 <>ptr）；返回填充高度 */
export const FillRect = /*@__PURE__*/ b('FillRect', '<>ptr <RECT>ptr <>ptr -> i32', { RECT })
/** 标记窗口区域失效（触发重绘；rect 收 DeepPartial RECT 对象 / RECT.encode().ptr，null 全窗）；成功 → 非 0 */
export const InvalidateRect = /*@__PURE__*/ b('InvalidateRect', '<HWND>ptr <RECT>ptr i32 -> i32', { RECT })
/** 立即重绘失效区域；成功 → 非 0 */
export const UpdateWindow = /*@__PURE__*/ b('UpdateWindow', '<HWND>ptr -> i32')

// ============ 光标 / 坐标 / 捕获 ============

/** 设光标形状（第 1 参收品牌 HCURSOR，误传 HWND 编译不过）；返回先前光标 */
export const SetCursor = /*@__PURE__*/ b('SetCursor', '<HCURSOR>ptr -> <HCURSOR>ptr')
/** 加载光标资源（hInstance 传 0 = 系统光标；名传 MAKEINTRESOURCE 整数，如 32512 = IDC_ARROW）；失败 → null */
export const LoadCursor = /*@__PURE__*/ b('LoadCursorW', '<>ptr <>ptr -> <HCURSOR>ptr')
/** 取光标屏幕坐标；出参 encode → call → decode（POINT.encode() 传 .ptr、POINT.decode(实例) 读回）；成功 → 非 0 */
export const GetCursorPos = /*@__PURE__*/ b('GetCursorPos', '<POINT>ptr -> i32')
/** 设光标屏幕坐标；成功 → 非 0 */
export const SetCursorPos = /*@__PURE__*/ b('SetCursorPos', 'i32 i32 -> i32')
/** 显示/隐藏光标（计数式：>0 显示）；返回新计数 */
export const ShowCursor = /*@__PURE__*/ b('ShowCursor', 'i32 -> i32')
/** 屏幕坐标 → 客户区坐标（就地更新不注册 encoder：POINT.encode(初值) 一步、传 .ptr、decode 读回）；成功 → 非 0 */
export const ScreenToClient = /*@__PURE__*/ b('ScreenToClient', '<HWND>ptr <POINT>ptr -> i32')
/** 客户区坐标 → 屏幕坐标（就地更新，同上）；成功 → 非 0 */
export const ClientToScreen = /*@__PURE__*/ b('ClientToScreen', '<HWND>ptr <POINT>ptr -> i32')
/** 批量坐标系转换（POINT buffer，cPoints 个点）；返回偏移差的低/高 16 位打包值 */
export const MapWindowPoints = /*@__PURE__*/ b('MapWindowPoints', '<HWND>ptr <HWND>ptr <BYTE>ptr u32 -> i32')
/** 取当前捕获鼠标的窗口；无 → null */
export const GetCapture = /*@__PURE__*/ b('GetCapture', ' -> <HWND>ptr')
/** 捕获鼠标输入到窗口；返回先前捕获窗口 */
export const SetCapture = /*@__PURE__*/ b('SetCapture', '<HWND>ptr -> <HWND>ptr')
/** 释放鼠标捕获；成功 → 非 0 */
export const ReleaseCapture = /*@__PURE__*/ b('ReleaseCapture', ' -> i32')

// ============ 键盘 / 输入 ============

/** 取虚拟键状态（SHORT：高位 0x8000 = 按下、低位 = 自上次调用的切换） */
export const GetKeyState = /*@__PURE__*/ b('GetKeyState', 'i32 -> i32')
/** 取虚拟键全局按下状态（高位 0x8000 = 当前按下） */
export const GetAsyncKeyState = /*@__PURE__*/ b('GetAsyncKeyState', 'i32 -> i32')
/** 取全部 256 键状态到 256 字节 buffer；成功 → 非 0 */
export const GetKeyboardState = /*@__PURE__*/ b('GetKeyboardState', '<BYTE>ptr -> i32')
/** 字符 → 虚拟键+修饰键（参传 charCode，如 65 = 'A'）；返回 SHORT（低字节 VK、高位 shift/ctrl/alt 掩码），无 → -1 */
export const VkKeyScan = /*@__PURE__*/ b('VkKeyScanW', 'u32 -> i32')

// ============ 计时器 ============

/** 设定时器（hWnd/id 传 null/0 = 自动分配 id；lpTimerFunc 传 null 用 WM_TIMER）；失败 → null */
export const SetTimer = /*@__PURE__*/ b('SetTimer', '<HWND>ptr <>ptr u32 <>ptr -> <>ptr')
/** 杀定时器（id 用 SetTimer 返回值）；成功 → 非 0 */
export const KillTimer = /*@__PURE__*/ b('KillTimer', '<HWND>ptr <>ptr -> i32')

// ============ 剪贴板 ============

/** 打开剪贴板（hWnd 可传 null）；成功 → 非 0，配对 CloseClipboard */
export const OpenClipboard = /*@__PURE__*/ b('OpenClipboard', '<HWND>ptr -> i32')
/** 关闭剪贴板；成功 → 非 0 */
export const CloseClipboard = /*@__PURE__*/ b('CloseClipboard', ' -> i32')
/** 清空剪贴板（须先 OpenClipboard）；成功 → 非 0 */
export const EmptyClipboard = /*@__PURE__*/ b('EmptyClipboard', ' -> i32')
/** 取剪贴板数据句柄（须先 OpenClipboard + 有数据）；无 → null */
export const GetClipboardData = /*@__PURE__*/ b('GetClipboardData', 'u32 -> <>ptr')
/** 放数据进剪贴板（hMem 所有权移交系统）；成功 → 非 0 */
export const SetClipboardData = /*@__PURE__*/ b('SetClipboardData', 'u32 <>ptr -> <>ptr')
/** 注册自定义剪贴板格式 ID；失败 → 0 */
export const RegisterClipboardFormat = /*@__PURE__*/ b('RegisterClipboardFormatW', '<WCHAR>ptr -> u32')
/** 剪贴板是否有指定格式数据；有 → 非 0 */
export const IsClipboardFormatAvailable = /*@__PURE__*/ b('IsClipboardFormatAvailable', 'u32 -> i32')

// ============ 菜单 ============

/** 取窗口菜单；无菜单 → null（返回品牌 HMENU） */
export const GetMenu = /*@__PURE__*/ b('GetMenu', '<HWND>ptr -> <HMENU>ptr')
/** 设/清窗口菜单（hMenu 传 null 清除；首参收品牌 HWND、第二参收品牌 HMENU，误传编译不过）；成功 → 非 0，改后需 DrawMenuBar */
export const SetMenu = /*@__PURE__*/ b('SetMenu', '<HWND>ptr <HMENU>ptr -> i32')
/** 重画菜单栏（首参收品牌 HWND）；成功 → 非 0 */
export const DrawMenuBar = /*@__PURE__*/ b('DrawMenuBar', '<HWND>ptr -> i32')
/** 追加菜单项（首参收品牌 HMENU；uFlags = gui.MF 类常量；uIDNewItem 命令 ID 或子菜单句柄——
 *  混合位保持 <>ptr；lpNewItem 可 string/null）；成功 → 非 0 */
export const AppendMenu = /*@__PURE__*/ b('AppendMenuW', '<HMENU>ptr u32 <>ptr <WCHAR>ptr -> i32')
/** 销毁菜单（收品牌 HMENU，误传 HWND 编译不过）；成功 → 非 0 */
export const DestroyMenu = /*@__PURE__*/ b('DestroyMenu', '<HMENU>ptr -> i32')
/** 设菜单项勾选状态（uCheck = MF_CHECKED 等）；返回先前状态（0xFFFFFFFF = 失败） */
export const CheckMenuItem = /*@__PURE__*/ b('CheckMenuItem', '<HMENU>ptr u32 u32 -> u32')
/** 启用/禁用/灰化菜单项；返回先前状态 */
export const EnableMenuItem = /*@__PURE__*/ b('EnableMenuItem', '<HMENU>ptr u32 u32 -> i32')
/** 取子菜单（按位置）；无 → null（出入参同为品牌 HMENU） */
export const GetSubMenu = /*@__PURE__*/ b('GetSubMenu', '<HMENU>ptr i32 -> <HMENU>ptr')
/** 弹出跟踪菜单（首参收品牌 HMENU；x,y 屏幕坐标；prcRect 可 null）；返回菜单项命令 ID 或 0 */
export const TrackPopupMenu = /*@__PURE__*/ b('TrackPopupMenu', '<HMENU>ptr u32 i32 i32 i32 <>ptr <BYTE>ptr -> i32')
/** 创建弹出菜单；失败 → null（返回品牌 HMENU，配对 DestroyMenu） */
export const CreatePopupMenu = /*@__PURE__*/ b('CreatePopupMenu', ' -> <HMENU>ptr')

// ============ 滚动条 ============

/** 设滚动参数（入参位对象直传：DeepPartial SCROLLINFO——cbSize 必须显式给 SCROLLINFO.size（Win32
 *  结构自描述要求，缺省跳过帮不了），fMask = SIF_* 决定写哪些项；redraw 非 0 立即重画）；返回滑块位置 */
export const SetScrollInfo = /*@__PURE__*/ b('SetScrollInfo', '<HWND>ptr u32 <SCROLLINFO>ptr i32 -> i32', { SCROLLINFO })
/** 取滚动参数（双向不注册 encoder：SCROLLINFO.encode({cbSize, fMask}) 一步 → 传 .ptr → decode 读回）；成功 → 非 0 */
export const GetScrollInfo = /*@__PURE__*/ b('GetScrollInfo', '<HWND>ptr u32 <SCROLLINFO>ptr -> i32')
/** 显示/隐藏滚动条（bar = SB_*，0=HORZ 1=VERT 3=BOTH；show 非 0 显示）；成功 → 非 0 */
export const ShowScrollBar = /*@__PURE__*/ b('ShowScrollBar', '<HWND>ptr u32 i32 -> i32')

// ============ 对话框 ============

/** 消息框（首参收品牌 HWND 可 null；仅在确实要弹窗时调用；MB_* 常量见 MSDN）；返回按钮 ID */
export const MessageBox = /*@__PURE__*/ b('MessageBoxW', '<HWND>ptr <WCHAR>ptr <WCHAR>ptr u32 -> i32')

// ============ 图像 ============

/** LoadImage——name 传 string（hinst=null 系统 IDI 图标或 .ico 文件路径；hinst=模块句柄则为资源名），
 *  <WCHAR>ptr 自动编码；uType = Win32 IMAGE_* 真值（BITMAP=0、CURSOR=1、ICON=2——与 gui.ImageType
 *  枚举当前值不同），fuLoad = Win32 LR_*（LOADFROMFILE=0x10、SHARED=0x8000，系统 IDI 需 SHARED）；
 *  失败 → null */
export const LoadImage = /*@__PURE__*/ b('LoadImageW', '<>ptr <WCHAR>ptr u32 i32 i32 u32 -> <>ptr')
/** LoadImage——name 传资源 ID 序数（MAKEINTRESOURCE 位 <>ptr 直传 number，如 IDI_APPLICATION=32512）；
 *  其余参数同 LoadImage */
export const LoadImageOrdinal = /*@__PURE__*/ b('LoadImageW', '<>ptr <>ptr u32 i32 i32 u32 -> <>ptr')

// ============ 杂项高频 ============

/** 取系统度量（nIndex = SM_*，0 = 屏宽、1 = 屏高） */
export const GetSystemMetrics = /*@__PURE__*/ b('GetSystemMetrics', 'i32 -> i32')
/** 读/写系统参数（uiAction = SPI_*；pvParam 为 buffer，如 SPI_GETNONCLIENTMETRICS）；成功 → 非 0 */
export const SystemParametersInfo = /*@__PURE__*/ b('SystemParametersInfoW', 'u32 u32 <BYTE>ptr u32 -> i32')
/** 枚举顶层窗口（回调传 closure() 的 ptr，返回 0 停止枚举）；全枚举完 → 非 0 */
export const EnumWindows = /*@__PURE__*/ b('EnumWindows', '<>ptr <>ptr -> i32')
