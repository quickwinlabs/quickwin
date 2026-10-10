// user32.dll 精选高频 API（85 个），逐函数独立导出：
//   - 签名对照 mingw winuser.h 原型手写；未被 import 的绑定经 esbuild 摇树不进产物
//   - WPARAM / LPARAM / LRESULT / UINT_PTR / LONG_PTR 及句柄混合值一律 <>ptr（指针宽度跨
//     架构正确；返回值 0 保真（C→JS 不做 0→null）、有符号读对齐 C 版 JS_NewInt64——-1 哨兵等负值保真）
//   - 入参字符串用 <WCHAR>ptr（string 编码为 UTF-16 + NUL，无字符串传 NULL）；文本出参缓冲
//     用 <BYTE>ptr（宽字符串出参配 WCHAR.alloc(n) 当 buffer、WCHAR.decode(buf) 读回）；
//     回调参数用 <>ptr 接 closure() 的 ptr
//   - 结构位按方向分流（结构定义见 ./structs.ts）：
//       纯入参位 <N>ptr + 注册 encoder → DeepPartial 对象直传（缺省字段 doEncode 跳过）、
//         alloc().ptr、NULL 三形态；
//       出参/就地位 <N>ptr 不注册 encoder → 位只收 def 分配的 .ptr（对象 encode 进调用方拿不到
//         的临时 buffer 会丢结果；ArrayBuffer 由 unknown layout fail-fast 拦下），
//         读回走 N.decode(buf|ptr)。统一流程：encode → call → decode
//   - 签名里的 <WCHAR>ptr 若语义是 MAKEINTRESOURCE 整数（如 LoadCursorW 光标名），该位用 <>ptr
//   - HDC 借出/归还与消费位统一 <HDC>ptr（品牌指针 Ptr<'HDC'>）：ReleaseDC 等归还位由 tsc
//     校验配对拦住误传 HWND，DrawText/FillRect 等消费位同收品牌、拦住裸 number 误传
//   - 返回/入参句柄位品牌化：HWND（窗口句柄形参与返回）、HMENU（菜单组出入参）、
//     HCURSOR（LoadCursor/SetCursor）一律 <N>ptr → Ptr<'N'> | NULL；gui.HWND 与
//     Ptr<"HWND"> 结构同型（quickwin.d.ts 字符串键 brand），react-qw 直传零桥接。
//     异种句柄互传（如 GetDesktopWindow() → DestroyMenu）由 tsc 拦下。混合值位保持
//     <>ptr：SetWindowPos 的 hWndInsertAfter（HWND_TOP 等常量）、AppendMenu.uIDNewItem
//     （命令 ID 或子菜单句柄）、MAKEINTRESOURCE 光标名，以及 HBRUSH / 回调等非清单
//     句柄（HINSTANCE 即 HMODULE：走 <HMODULE>ptr 与 win 模块同型；剪贴板句柄走
//     <HGLOBAL>ptr 自产自收）
import * as os from 'os'
import { bind, type CodecMap } from '../ffi/bind.js'
// 只 import 注册了 encoder 的结构（纯入参位）；POINT 等出/就地位不注册，运行时无需引用
import { MSG, RECT, SCROLLINFO, WNDCLASSEXW } from './structs.js'

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

/** 创建窗口
 *  @returns 窗口句柄；失败 → NULL
 *  @param args_0 dwExStyle WS_EX_*
 *  @param args_1 lpClassName 窗口类名 string 或 NULL
 *  @param args_2 lpWindowName 窗口标题 string 或 NULL
 *  @param args_3 dwStyle WS_*（gui.WindowStyle 类常量）
 *  @param args_4 x 初始左上角（CW_USEDEFAULT = -1）
 *  @param args_5 y 初始左上角（CW_USEDEFAULT = -1）
 *  @param args_6 nWidth
 *  @param args_7 nHeight
 *  @param args_8 hWndParent 父窗口（可 NULL）
 *  @param args_9 hMenu 菜单句柄或子窗口 ID（可 NULL）
 *  @param args_10 hInstance 模块句柄（可 NULL）
 *  @param args_11 lpParam 窗口创建参数，传 NULL */
export const CreateWindowEx = /*@__PURE__*/ b('CreateWindowExW',
    'u32 <WCHAR>ptr <WCHAR>ptr u32 i32 i32 i32 i32 <HWND>ptr <HMENU>ptr <HMODULE>ptr <>ptr -> <HWND>ptr')
/** 销毁窗口
 *  @returns 成功 → 非 0
 *  @param args_0 hWnd */
export const DestroyWindow = /*@__PURE__*/ b('DestroyWindow', '<HWND>ptr -> i32')
/** 显示/隐藏窗口（nCmdShow = gui.WindowStyle 类常量）
 *  @returns 先前可见性
 *  @param args_0 hWnd
 *  @param args_1 nCmdShow 显示命令（SW_SHOW/SW_HIDE 等） */
export const ShowWindow = /*@__PURE__*/ b('ShowWindow', '<HWND>ptr i32@ShowWindowCmd -> i32')
/** 移动/缩放窗口
 *  @returns 成功 → 非 0；失败 → 0（原因见 GetLastError）
 *  @param args_0 hWnd
 *  @param args_1 x 新左上角
 *  @param args_2 y 新左上角
 *  @param args_3 nWidth 新宽度
 *  @param args_4 nHeight 新高度
 *  @param args_5 bRepaint 非 0 立即重绘 */
export const MoveWindow = /*@__PURE__*/ b('MoveWindow', '<HWND>ptr i32 i32 i32 i32 i32 -> i32')
/** 设窗口位置/层级
 *  @returns 成功 → 非 0；失败 → 0（原因见 GetLastError）
 *  @param args_0 hWnd
 *  @param args_1 hWndInsertAfter 置前窗口或 HWND_TOP(-1)/BOTTOM(-2)/NOTOPMOST(-2) 常量
 *  @param args_2 x 新位置
 *  @param args_3 y 新位置
 *  @param args_4 cx 新宽度
 *  @param args_5 cy 新高度
 *  @param args_6 uFlags SWP_* 标志（SWP_NOMOVE=0x2/SWP_NOSIZE=0x1 等） */
// hwndInsertAfter 标 <>ptr@SetWindowPosHwnd：该位收 HWND_TOP 等窗口序常量（非任意窗口句柄），
// 值域是枚举而非句柄 —— 指针位 @ 标注试点。
export const SetWindowPos = /*@__PURE__*/ b('SetWindowPos', '<HWND>ptr <>ptr@SetWindowPosHwnd i32 i32 i32 i32 u32 -> i32')
/** 取窗口外框矩形（屏幕坐标）
 *  @returns 成功 → 非 0；失败 → 0（原因见 GetLastError）
 *  @param args_0 hWnd
 *  @param args_1 lpRect 出参槽，传 RECT.alloc().ptr、RECT.decode 读回 */
export const GetWindowRect = /*@__PURE__*/ b('GetWindowRect', '<HWND>ptr <RECT>ptr -> i32')
/** 取窗口客户区矩形
 *  @returns 成功 → 非 0；失败 → 0（原因见 GetLastError）
 *  @param args_0 hWnd
 *  @param args_1 lpRect 出参槽，传 RECT.alloc().ptr、RECT.decode 读回 */
export const GetClientRect = /*@__PURE__*/ b('GetClientRect', '<HWND>ptr <RECT>ptr -> i32')
/** 是否有效窗口句柄
 *  @returns 是 → 非 0
 *  @param args_0 hWnd */
export const IsWindow = /*@__PURE__*/ b('IsWindow', '<HWND>ptr -> i32')
/** 窗口是否可见
 *  @returns 是 → 非 0
 *  @param args_0 hWnd */
export const IsWindowVisible = /*@__PURE__*/ b('IsWindowVisible', '<HWND>ptr -> i32')
/** 窗口是否最小化
 *  @returns 是 → 非 0
 *  @param args_0 hWnd */
export const IsIconic = /*@__PURE__*/ b('IsIconic', '<HWND>ptr -> i32')
/** 取前台窗口
 *  @returns 前台窗口句柄；无 → NULL */
export const GetForegroundWindow = /*@__PURE__*/ b('GetForegroundWindow', ' -> <HWND>ptr')
/** 请求设前台窗口
 *  @returns 成功 → 非 0
 *  @param args_0 hWnd 目标窗口 */
export const SetForegroundWindow = /*@__PURE__*/ b('SetForegroundWindow', '<HWND>ptr -> i32')
/** 取桌面窗口
 *  @returns 桌面窗口句柄（恒非 NULL） */
export const GetDesktopWindow = /*@__PURE__*/ b('GetDesktopWindow', ' -> <HWND>ptr')
/** 按类名+标题查找顶层窗口
 *  @returns 窗口句柄；无 → NULL
 *  @param args_0 lpClassName 窗口类名 string 或 NULL
 *  @param args_1 lpWindowName 窗口标题 string 或 NULL */
export const FindWindow = /*@__PURE__*/ b('FindWindowW', '<WCHAR>ptr <WCHAR>ptr -> <HWND>ptr')
/** 在 hWndParent 的子窗口链里按类名+标题查找，从 hWndChildAfter 之后开始；
 *  链式遍历：FindWindowEx(NULL, prev, NULL, NULL)
 *  @returns 窗口句柄；无更多窗口 → NULL
 *  @param args_0 hWndParent 父窗口，NULL = 遍历顶层
 *  @param args_1 hWndChildAfter 起始子窗口，NULL = 从头
 *  @param args_2 lpszClass 类名 string 或 NULL = 不过滤
 *  @param args_3 lpszWindow 标题 string 或 NULL = 不过滤 */
export const FindWindowEx = /*@__PURE__*/ b('FindWindowExW',
    '<HWND>ptr <HWND>ptr <WCHAR>ptr <WCHAR>ptr -> <HWND>ptr')
/** 取窗口标题
 *  @returns 写入字符数，不含 NUL
 *  @param args_0 hWnd
 *  @param args_1 lpString 出参缓冲，传 WCHAR.alloc(n)、WCHAR.decode(buf) 读回
 *  @param args_2 nMaxCount 缓冲容量（字符数，含 NUL 余量） */
export const GetWindowText = /*@__PURE__*/ b('GetWindowTextW', '<HWND>ptr <BYTE>ptr i32 -> i32')
/** 设窗口标题（传 string 或 NULL 清空）
 *  @returns 成功 → 非 0
 *  @param args_0 hWnd
 *  @param args_1 lpString 新标题 string 或 NULL */
export const SetWindowText = /*@__PURE__*/ b('SetWindowTextW', '<HWND>ptr <WCHAR>ptr -> i32')
/** 取窗口标题长度
 *  @returns 标题长度（字符数，不含 NUL）
 *  @param args_0 hWnd */
export const GetWindowTextLength = /*@__PURE__*/ b('GetWindowTextLengthW', '<HWND>ptr -> i32')
/** 取窗口类名
 *  @returns 写入字符数
 *  @param args_0 hWnd
 *  @param args_1 lpClassName 出参缓冲，传 WCHAR.alloc(n)、WCHAR.decode(buf) 读回
 *  @param args_2 nMaxCount 缓冲容量（字符数） */
export const GetClassName = /*@__PURE__*/ b('GetClassNameW', '<HWND>ptr <BYTE>ptr i32 -> i32')
/** 取窗口附加数据（ia32 走 GetWindowLongW）
 *  @returns 附加数据值；0 保真（值有符号读）
 *  @param args_0 hWnd
 *  @param args_1 nIndex 索引（GWLP_WNDPROC/GWLP_USERDATA/GWL_STYLE 等） */
export const GetWindowLongPtr = /*@__PURE__*/ b('GetWindowLong' + LONG_PTR_SYM, '<HWND>ptr i32@Gwlp -> <>ptr')
/** 设窗口附加数据
 *  @returns 先前值（0 保真，值有符号读）
 *  @param args_0 hWnd
 *  @param args_1 nIndex 索引（GWLP_* / GWL_*）
 *  @param args_2 dwNewLong 新值（整数或指针混合值） */
export const SetWindowLongPtr = /*@__PURE__*/ b('SetWindowLong' + LONG_PTR_SYM, '<HWND>ptr i32@Gwlp <>ptr -> <>ptr')
/** 取窗口所属线程（第二参可传 NULL 不取进程 ID）
 *  @returns 线程 ID
 *  @param args_0 hWnd
 *  @param args_1 lpdwProcessId 出参槽，传 Uint32Array(1).buffer 或 NULL */
export const GetWindowThreadProcessId = /*@__PURE__*/ b('GetWindowThreadProcessId', '<HWND>ptr <BYTE>ptr -> u32')
/** 启用/禁用窗口输入
 *  @returns 先前状态
 *  @param args_0 hWnd
 *  @param args_1 bEnable 非 0 启用 */
export const EnableWindow = /*@__PURE__*/ b('EnableWindow', '<HWND>ptr i32 -> i32')
/** 取父窗口
 *  @returns 父窗口句柄；无 → NULL
 *  @param args_0 hWnd */
export const GetParent = /*@__PURE__*/ b('GetParent', '<HWND>ptr -> <HWND>ptr')
/** 设父窗口
 *  @returns 先前父窗口
 *  @param args_0 hWndChild 子窗口
 *  @param args_1 hWndNewParent 新父窗口 */
export const SetParent = /*@__PURE__*/ b('SetParent', '<HWND>ptr <HWND>ptr -> <HWND>ptr')
/** 按关系取相邻窗口
 *  @returns 窗口句柄；无 → NULL
 *  @param args_0 hWnd
 *  @param args_1 uCmd 关系（GW_CHILD=4/GW_HWNDNEXT=2/GW_OWNER=4 等 GW_*） */
export const GetWindow = /*@__PURE__*/ b('GetWindow', '<HWND>ptr u32@GetWindowCmd -> <HWND>ptr')
/** 注册窗口类
 *  @returns 类 ATOM；失败 → 0
 *  @param args_0 lpwcx WNDCLASSEXW.encode({ cbSize: WNDCLASSEXW.size, ... }).ptr（见 structs.ts） */
export const RegisterClassEx = /*@__PURE__*/ b('RegisterClassExW', '<WNDCLASSEXW>ptr -> u16', { WNDCLASSEXW })

// ============ 焦点 / 激活 ============

/** 设输入焦点
 *  @returns 先前焦点窗口
 *  @param args_0 hWnd 接收焦点的窗口 */
export const SetFocus = /*@__PURE__*/ b('SetFocus', '<HWND>ptr -> <HWND>ptr')
/** 取调用线程输入焦点
 *  @returns 焦点窗口句柄；无 → NULL */
export const GetFocus = /*@__PURE__*/ b('GetFocus', ' -> <HWND>ptr')
/** 取调用线程激活窗口
 *  @returns 激活窗口句柄；无 → NULL */
export const GetActiveWindow = /*@__PURE__*/ b('GetActiveWindow', ' -> <HWND>ptr')
/** 设调用线程激活窗口
 *  @returns 先前窗口
 *  @param args_0 hWnd */
export const SetActiveWindow = /*@__PURE__*/ b('SetActiveWindow', '<HWND>ptr -> <HWND>ptr')

// ============ 消息循环 ============

/** 取消息（阻塞式）；分发前先 TranslateMessage
 *  @returns -1 = 出错、0 = WM_QUIT、>0 = 有消息
 *  @param args_0 lpMsg MSG 出参缓冲（MSG.alloc().ptr，品牌位不收裸 PAB）
 *  @param args_1 hWndFilter 窗口过滤，可 NULL
 *  @param args_2 wMsgFilterMin 消息下限，0 = 不过滤
 *  @param args_3 wMsgFilterMax 消息上限，0 = 不过滤 */
export const GetMessage = /*@__PURE__*/ b('GetMessageW', '<MSG>ptr <HWND>ptr u32 u32 -> i32')
/** 非阻塞查消息
 *  @returns 有消息 → 非 0
 *  @param args_0 lpMsg MSG 出参缓冲
 *  @param args_1 hWndFilter 窗口过滤，可 NULL
 *  @param args_2 wMsgFilterMin 消息下限，0 = 不过滤
 *  @param args_3 wMsgFilterMax 消息上限，0 = 不过滤
 *  @param args_4 wRemoveMsg PM_NOREMOVE(0) / PM_REMOVE(1) */
export const PeekMessage = /*@__PURE__*/ b('PeekMessageW', '<MSG>ptr <HWND>ptr u32 u32 u32 -> i32')
/** 把 WM_KEYDOWN/UP 转成字符消息（翻译结果留在队列）
 *  @returns 可翻译 → 非 0
 *  @param args_0 lpMsg 取到的 MSG 缓冲（GetMessage/PeekMessage 的出参） */
export const TranslateMessage = /*@__PURE__*/ b('TranslateMessage', '<MSG>ptr -> i32', { MSG })
/** 分发 MSG 给窗口过程
 *  @returns 处理结果（0 保真，有符号读）
 *  @param args_0 lpMsg MSG 缓冲（GetMessage/PeekMessage 的出参） */
export const DispatchMessage = /*@__PURE__*/ b('DispatchMessageW', '<MSG>ptr -> <>ptr', { MSG })
/** 异步投递消息到窗口线程队列
 *  @returns 成功 → 非 0
 *  @param args_0 hWnd 目标窗口
 *  @param args_1 Msg 消息号（WM_*）
 *  @param args_2 wParam 消息参数（混合位）
 *  @param args_3 lParam 消息参数（混合位） */
export const PostMessage = /*@__PURE__*/ b('PostMessageW', '<HWND>ptr u32@AnyMsg <>ptr <>ptr -> i32')
/** 同步发送消息并等窗口过程处理
 *  @returns 处理结果（0 保真，有符号读）
 *  @param args_0 hWnd 目标窗口
 *  @param args_1 Msg 消息号（WM_*）
 *  @param args_2 wParam 消息参数（整数或缓冲指针）
 *  @param args_3 lParam 消息参数（整数或缓冲指针） */
export const SendMessage = /*@__PURE__*/ b('SendMessageW', '<HWND>ptr u32@AnyMsg <>ptr <>ptr -> <>ptr')
/** 退出消息循环（投递 WM_QUIT，wParam = 退出码）
 *  @param args_0 nExitCode 退出码 */
export const PostQuitMessage = /*@__PURE__*/ b('PostQuitMessage', 'i32 -> void')
/** 默认窗口过程（未处理消息的兜底）
 *  @returns 处理结果（0 保真，有符号读）
 *  @param args_0 hWnd
 *  @param args_1 Msg 消息号
 *  @param args_2 wParam 消息参数
 *  @param args_3 lParam 消息参数 */
export const DefWindowProc = /*@__PURE__*/ b('DefWindowProcW', '<HWND>ptr u32@AnyMsg <>ptr <>ptr -> <>ptr')
/** 调用窗口过程（wndProc = GetWindowLongPtr(GWLP_WNDPROC) 读回的过程指针——无品牌混合位，
 *  仅对本线程窗口调用）
 *  @returns 处理结果（0 保真，有符号读）
 *  @param args_0 lpPrevWndFunc 原窗口过程指针
 *  @param args_1 hWnd
 *  @param args_2 Msg 消息号
 *  @param args_3 wParam 消息参数
 *  @param args_4 lParam 消息参数 */
export const CallWindowProc = /*@__PURE__*/ b('CallWindowProcW', '<>ptr <HWND>ptr u32@AnyMsg <>ptr <>ptr -> <>ptr')
/** 注册系统级唯一消息 ID（按字符串比较）
 *  @returns 消息 ID；失败 → 0
 *  @param args_0 lpString 消息名 string */
export const RegisterWindowMessage = /*@__PURE__*/ b('RegisterWindowMessageW', '<WCHAR>ptr -> u32')

// ============ 绘制 / DC ============

/** 取窗口 DC（hWnd 传 NULL → 桌面窗口）；用完必须 ReleaseDC 配对
 *  @returns DC；失败 → NULL
 *  @param args_0 hWnd NULL = 桌面窗口 */
export const GetDC = /*@__PURE__*/ b('GetDC', '<HWND>ptr -> <HDC>ptr')
/** 归还 GetDC/GetWindowDC 取的 DC（首参窗口句柄、第二参 DC，误传编译不过）
 *  @returns 成功 → 非 0
 *  @param args_0 hWnd 取 DC 时的窗口句柄
 *  @param args_1 hdc 要归还的 DC */
export const ReleaseDC = /*@__PURE__*/ b('ReleaseDC', '<HWND>ptr <HDC>ptr! -> i32')
/** 让窗口把自己画进 hdcBlt（可截被遮挡 / 最小化的窗口；位图须按整窗尺寸建，从 (0,0) 填满）
 *  @returns 成功 → 非 0
 *  @param args_0 hWnd 被截窗口
 *  @param args_1 hdcBlt 目标 DC
 *  @param args_2 nFlags PW_* 标志（PW_CLIENTONLY=1/PW_RENDERFULLCONTENT=2，Win8.1+），XP/Win7 传 0 */
export const PrintWindow = /*@__PURE__*/ b('PrintWindow', '<HWND>ptr <HDC>ptr! u32 -> i32')
/** 取整个窗口（含边框标题）DC；配对 ReleaseDC
 *  @returns DC；失败 → NULL
 *  @param args_0 hWnd */
export const GetWindowDC = /*@__PURE__*/ b('GetWindowDC', '<HWND>ptr -> <HDC>ptr')
/** 开始重绘；配对 EndPaint
 *  @returns DC
 *  @param args_0 hWnd 重绘窗口
 *  @param args_1 lpPaint 出参槽，PAINTSTRUCT.alloc().ptr（见 structs.ts） */
export const BeginPaint = /*@__PURE__*/ b('BeginPaint', '<HWND>ptr <PAINTSTRUCT>ptr -> <HDC>ptr')
/** 结束重绘（传 BeginPaint 同一 buffer）
 *  @returns 成功 → 非 0
 *  @param args_0 hWnd 重绘窗口
 *  @param args_1 lpPaint BeginPaint 同一 PAINTSTRUCT 缓冲 */
export const EndPaint = /*@__PURE__*/ b('EndPaint', '<HWND>ptr <PAINTSTRUCT>ptr -> i32')
/** 文本排版绘制
 *  @returns 文本行高
 *  @param args_0 hdc 目标 DC
 *  @param args_1 lpchText 文本 string（自动 UTF-16 编码）
 *  @param args_2 cchText 字符数（-1 = 自动算到 NUL）
 *  @param args_3 lpRect 矩形（双向不注册 encoder；CALCRECT 就地写回：RECT.encode(初值) 传 .ptr、decode 读回）
 *  @param args_4 uFormat DT_* 排版标志（gui.DrawTextFlag） */
export const DrawText = /*@__PURE__*/ b('DrawTextW', '<HDC>ptr! <WCHAR>ptr i32 <RECT>ptr i32 -> i32')
/** 用画刷填充矩形
 *  @returns 填充高度
 *  @param args_0 hdc 目标 DC
 *  @param args_1 lprc 矩形（DeepPartial RECT 对象或 RECT.alloc().ptr）
 *  @param args_2 hbr 画刷句柄（无品牌 <>ptr） */
export const FillRect = /*@__PURE__*/ b('FillRect', '<HDC>ptr! <RECT>ptr <>ptr -> i32', { RECT })

/** 用画刷画 1px 空心矩形边框（只描边不填充）；成功与否请以像素/后续状态断言
 *  @returns 返回值 Windows 版本间不可靠
 *  @param args_1 lprc 矩形（DeepPartial RECT 对象或 RECT.alloc().ptr）
 *  @param args_2 hbr 画刷句柄（CreateSolidBrush 等返回的 <>ptr 族内互传） */
export const FrameRect = /*@__PURE__*/ b('FrameRect', '<HDC>ptr! <RECT>ptr <>ptr -> i32', { RECT })

/** 矩形区域逐像素按位取反（白→黑、红→青；再反一次可逆还原）
 *  @returns 成功 → 非 0
 *  @param args_1 lprc 矩形（DeepPartial RECT 对象或 RECT.alloc().ptr） */
export const InvertRect = /*@__PURE__*/ b('InvertRect', '<HDC>ptr! <RECT>ptr -> i32', { RECT })
/** 标记窗口区域失效（触发重绘）
 *  @returns 成功 → 非 0
 *  @param args_0 hWnd
 *  @param args_1 lpRect 失效区域（DeepPartial RECT / .ptr / NULL = 全窗）
 *  @param args_2 bErase 非 0 先擦背景 */
export const InvalidateRect = /*@__PURE__*/ b('InvalidateRect', '<HWND>ptr <RECT>ptr i32 -> i32', { RECT })
/** 立即重绘失效区域
 *  @returns 成功 → 非 0
 *  @param args_0 hWnd */
export const UpdateWindow = /*@__PURE__*/ b('UpdateWindow', '<HWND>ptr -> i32')

// ============ 光标 / 坐标 / 捕获 ============

/** 设光标形状（误传 HWND 编译不过）
 *  @returns 先前光标
 *  @param args_0 hCursor 光标句柄 */
export const SetCursor = /*@__PURE__*/ b('SetCursor', '<HCURSOR>ptr -> <HCURSOR>ptr')
/** 加载光标资源
 *  @returns 光标句柄；失败 → NULL
 *  @param args_0 hInstance 模块句柄，NULL = 系统光标
 *  @param args_1 lpCursorName MAKEINTRESOURCE 整数（如 32512 = IDC_ARROW）直传 */
export const LoadCursor = /*@__PURE__*/ b('LoadCursorW', '<HMODULE>ptr <>ptr -> <HCURSOR>ptr')
/** 取光标屏幕坐标
 *  @returns 成功 → 非 0
 *  @param args_0 lpPoint 出参槽，传 POINT.alloc().ptr、POINT.decode 读回 */
export const GetCursorPos = /*@__PURE__*/ b('GetCursorPos', '<POINT>ptr -> i32')
/** 设光标屏幕坐标
 *  @returns 成功 → 非 0
 *  @param args_0 x 屏幕 x
 *  @param args_1 y 屏幕 y */
export const SetCursorPos = /*@__PURE__*/ b('SetCursorPos', 'i32 i32 -> i32')
/** 显示/隐藏光标（计数式）
 *  @returns 新计数
 *  @param args_0 bShow >0 显示（内部计数），<0 隐藏 */
export const ShowCursor = /*@__PURE__*/ b('ShowCursor', 'i32 -> i32')
/** 屏幕坐标 → 客户区坐标（就地更新，双向不注册 encoder）
 *  @returns 成功 → 非 0
 *  @param args_0 hWnd 目标窗口
 *  @param args_1 lpPoint 就地更新的 POINT（encode(初值) 传 .ptr、decode 读回） */
export const ScreenToClient = /*@__PURE__*/ b('ScreenToClient', '<HWND>ptr <POINT>ptr -> i32')
/** 客户区坐标 → 屏幕坐标（就地更新，同上）
 *  @returns 成功 → 非 0
 *  @param args_0 hWnd 源窗口
 *  @param args_1 lpPoint 就地更新的 POINT（同 ScreenToClient） */
export const ClientToScreen = /*@__PURE__*/ b('ClientToScreen', '<HWND>ptr <POINT>ptr -> i32')
/** 批量坐标系转换
 *  @returns 偏移差的低/高 16 位打包值
 *  @param args_0 hWndFrom 源窗口
 *  @param args_1 hWndTo 目标窗口
 *  @param args_2 lpPoints POINT 数组缓冲
 *  @param args_3 cPoints 点数 */
export const MapWindowPoints = /*@__PURE__*/ b('MapWindowPoints', '<HWND>ptr <HWND>ptr <BYTE>ptr u32 -> i32')
/** 取当前捕获鼠标的窗口
 *  @returns 窗口句柄；无 → NULL */
export const GetCapture = /*@__PURE__*/ b('GetCapture', ' -> <HWND>ptr')
/** 捕获鼠标输入到窗口
 *  @returns 先前捕获窗口
 *  @param args_0 hWnd 接收捕获的窗口 */
export const SetCapture = /*@__PURE__*/ b('SetCapture', '<HWND>ptr -> <HWND>ptr')
/** 释放鼠标捕获
 *  @returns 成功 → 非 0 */
export const ReleaseCapture = /*@__PURE__*/ b('ReleaseCapture', ' -> i32')

// ============ 键盘 / 输入 ============

/** 取虚拟键状态
 *  @returns SHORT：高位 0x8000 = 按下、低位 = 自上次调用的切换
 *  @param args_0 nVirtKey 虚拟键码（VK_*） */
export const GetKeyState = /*@__PURE__*/ b('GetKeyState', 'i32 -> i32')
/** 取虚拟键全局按下状态
 *  @returns 高位 0x8000 = 当前按下
 *  @param args_0 nVirtKey 虚拟键码（VK_*） */
export const GetAsyncKeyState = /*@__PURE__*/ b('GetAsyncKeyState', 'i32 -> i32')
/** 取全部 256 键状态
 *  @returns 成功 → 非 0
 *  @param args_0 lpKeyState 出参槽，自备 256 字节 buffer */
export const GetKeyboardState = /*@__PURE__*/ b('GetKeyboardState', '<BYTE>ptr -> i32')
/** 字符 → 虚拟键+修饰键
 *  @returns SHORT（低字节 VK、高位 shift/ctrl/alt 掩码），无 → -1
 *  @param args_0 ch 字符码（如 65 = 'A'） */
export const VkKeyScan = /*@__PURE__*/ b('VkKeyScanW', 'u32 -> i32')

// ============ 计时器 ============

/** 设定时器（hWnd/id 传 NULL/0 = 自动分配 id；lpTimerFunc 传 NULL 用 WM_TIMER）
 *  @returns 定时器 ID（自动分配时从返回值读回）；失败 → 0
 *  @param args_0 hWnd 关联窗口，可 NULL
 *  @param args_1 id 定时器 ID（0 = 自动分配）
 *  @param args_2 uElapse 间隔毫秒
 *  @param args_3 lpTimerFunc 回调指针（closure().ptr），NULL = WM_TIMER 消息 */
export const SetTimer = /*@__PURE__*/ b('SetTimer', '<HWND>ptr <>ptr u32 <>ptr -> <>ptr')
/** 杀定时器（id 用 SetTimer 返回值）
 *  @returns 成功 → 非 0
 *  @param args_0 hWnd 关联窗口，可 NULL
 *  @param args_1 id 定时器 ID（SetTimer 返回值） */
export const KillTimer = /*@__PURE__*/ b('KillTimer', '<HWND>ptr <>ptr -> i32')

// ============ 剪贴板 ============

/** 打开剪贴板；配对 CloseClipboard
 *  @returns 成功 → 非 0
 *  @param args_0 hWnd 拥有窗口，可 NULL */
export const OpenClipboard = /*@__PURE__*/ b('OpenClipboard', '<HWND>ptr -> i32')
/** 关闭剪贴板
 *  @returns 成功 → 非 0 */
export const CloseClipboard = /*@__PURE__*/ b('CloseClipboard', ' -> i32')
/** 清空剪贴板（须先 OpenClipboard）
 *  @returns 成功 → 非 0 */
export const EmptyClipboard = /*@__PURE__*/ b('EmptyClipboard', ' -> i32')
/** 取剪贴板数据（须先 OpenClipboard + 有数据）
 *  @returns 数据句柄；无 → NULL
 *  @param args_0 uFormat 剪贴板格式（CF_* 或 RegisterClipboardFormat 返回值） */
export const GetClipboardData = /*@__PURE__*/ b('GetClipboardData', 'u32 -> <HGLOBAL>ptr')
/** 放数据进剪贴板
 *  @returns 成功 → 非 0
 *  @param args_0 uFormat 剪贴板格式
 *  @param args_1 hMem 全局内存句柄（所有权移交系统后勿再用） */
export const SetClipboardData = /*@__PURE__*/ b('SetClipboardData', 'u32 <HGLOBAL>ptr -> <HGLOBAL>ptr')
/** 注册自定义剪贴板格式 ID
 *  @returns 格式 ID；失败 → 0
 *  @param args_0 lpszFormat 格式名 string */
export const RegisterClipboardFormat = /*@__PURE__*/ b('RegisterClipboardFormatW', '<WCHAR>ptr -> u32')
/** 剪贴板是否有指定格式数据
 *  @returns 有 → 非 0
 *  @param args_0 format 剪贴板格式（CF_*） */
export const IsClipboardFormatAvailable = /*@__PURE__*/ b('IsClipboardFormatAvailable', 'u32 -> i32')

// ============ 菜单 ============

/** 取窗口菜单
 *  @returns 菜单句柄；无菜单 → NULL
 *  @param args_0 hWnd */
export const GetMenu = /*@__PURE__*/ b('GetMenu', '<HWND>ptr -> <HMENU>ptr')
/** 设/清窗口菜单；改后需 DrawMenuBar
 *  @returns 成功 → 非 0
 *  @param args_0 hWnd
 *  @param args_1 hMenu 新菜单，NULL 清除 */
export const SetMenu = /*@__PURE__*/ b('SetMenu', '<HWND>ptr <HMENU>ptr -> i32')
/** 重画菜单栏
 *  @returns 成功 → 非 0
 *  @param args_0 hWnd */
export const DrawMenuBar = /*@__PURE__*/ b('DrawMenuBar', '<HWND>ptr -> i32')
/** 追加菜单项
 *  @returns 成功 → 非 0
 *  @param args_0 hMenu 目标菜单
 *  @param args_1 uFlags MF_* 标志（MF_STRING/MF_SEPARATOR/MF_POPUP 等）
 *  @param args_2 uIDNewItem 命令 ID 或子菜单句柄（混合位）
 *  @param args_3 lpNewItem 菜单项文本 string 或 NULL */
export const AppendMenu = /*@__PURE__*/ b('AppendMenuW', '<HMENU>ptr u32 <>ptr <WCHAR>ptr -> i32')
/** 销毁菜单（误传 HWND 编译不过）
 *  @returns 成功 → 非 0
 *  @param args_0 hMenu */
export const DestroyMenu = /*@__PURE__*/ b('DestroyMenu', '<HMENU>ptr -> i32')
/** 设菜单项勾选状态
 *  @returns 先前状态（0xFFFFFFFF = 失败）
 *  @param args_0 hMenu
 *  @param args_1 uIDItem 菜单项 ID 或位置（依 uFlags MF_BYPOSITION）
 *  @param args_2 uCheck MF_CHECKED/MF_UNCHECKED 等 */
export const CheckMenuItem = /*@__PURE__*/ b('CheckMenuItem', '<HMENU>ptr u32 u32 -> u32')
/** 启用/禁用/灰化菜单项
 *  @returns 先前状态
 *  @param args_0 hMenu
 *  @param args_1 uIDItem 菜单项 ID 或位置
 *  @param args_2 uEnable MF_ENABLED/MF_GRAYED/MF_DISABLED 等 */
export const EnableMenuItem = /*@__PURE__*/ b('EnableMenuItem', '<HMENU>ptr u32 u32 -> i32')
/** 取子菜单（按位置）
 *  @returns 子菜单句柄；无 → NULL（出入参同型）
 *  @param args_0 hMenu 父菜单
 *  @param args_1 nPos 子菜单位置索引 */
export const GetSubMenu = /*@__PURE__*/ b('GetSubMenu', '<HMENU>ptr i32 -> <HMENU>ptr')
/** 弹出跟踪菜单
 *  @returns 菜单项命令 ID 或 0
 *  @param args_0 hMenu 弹出菜单
 *  @param args_1 uFlags TPM_* 标志
 *  @param args_2 x 屏幕 x
 *  @param args_3 y 屏幕 y
 *  @param args_4 nReserved 保留，传 0
 *  @param args_5 prcRect 点击区矩形（DeepPartial RECT / .ptr / NULL）
 *  @param args_6 hdc 参考 DC，可 NULL */
export const TrackPopupMenu = /*@__PURE__*/ b('TrackPopupMenu', '<HMENU>ptr u32 i32 i32 i32 <RECT>ptr <HDC>ptr -> i32', { RECT })
/** 创建弹出菜单；配对 DestroyMenu
 *  @returns 菜单句柄；失败 → NULL */
export const CreatePopupMenu = /*@__PURE__*/ b('CreatePopupMenu', ' -> <HMENU>ptr')

// ============ 滚动条 ============

/** 设滚动参数
 *  @returns 滑块位置
 *  @param args_0 hWnd
 *  @param args_1 nBar 滚动条（SB_HORZ=0/SB_VERT=1/SB_CTL=2）
 *  @param args_2 lpScrollInfo DeepPartial SCROLLINFO（cbSize 必须显式给 SCROLLINFO.size——Win32
 *    结构自描述要求，缺省跳过帮不了；fMask = SIF_* 决定写哪些项）
 *  @param args_3 redraw 非 0 立即重画 */
export const SetScrollInfo = /*@__PURE__*/ b('SetScrollInfo', '<HWND>ptr u32 <SCROLLINFO>ptr i32 -> i32', { SCROLLINFO })
/** 取滚动参数（双向不注册 encoder）
 *  @returns 成功 → 非 0
 *  @param args_0 hWnd
 *  @param args_1 nBar 滚动条（SB_*）
 *  @param args_2 lpScrollInfo SCROLLINFO.encode({cbSize, fMask}) 传 .ptr、decode 读回 */
export const GetScrollInfo = /*@__PURE__*/ b('GetScrollInfo', '<HWND>ptr u32 <SCROLLINFO>ptr -> i32')
/** 显示/隐藏滚动条
 *  @returns 成功 → 非 0
 *  @param args_0 hWnd
 *  @param args_1 bar 滚动条（0=HORZ 1=VERT 3=BOTH）
 *  @param args_2 show 非 0 显示 */
export const ShowScrollBar = /*@__PURE__*/ b('ShowScrollBar', '<HWND>ptr u32 i32 -> i32')

// ============ 对话框 ============

/** 消息框（仅在确实要弹窗时调用；MB_* 常量见 MSDN）
 *  @returns 按钮 ID
 *  @param args_0 hWnd 父窗口，可 NULL
 *  @param args_1 lpText 正文 string
 *  @param args_2 lpCaption 标题 string
 *  @param args_3 uType MB_* 样式（MB_OK/MB_YESNO 等） */
export const MessageBox = /*@__PURE__*/ b('MessageBoxW', '<HWND>ptr <WCHAR>ptr <WCHAR>ptr u32 -> i32')

// ============ 图像 ============

/** 按名加载图像（string 自动编码；uType/fuLoad 用 Win32 真值——与 gui.ImageType 枚举当前值
 *  不同）
 *  @returns 图像句柄；失败 → 0
 *  @param args_0 hinst 模块句柄，NULL = 系统资源或 .ico 文件
 *  @param args_1 name 图像名 string（资源名或文件路径）
 *  @param args_2 uType IMAGE_* 真值（BITMAP=0/CURSOR=1/ICON=2）
 *  @param args_3 cx 期望宽度（0 = 原始）
 *  @param args_4 cy 期望高度（0 = 原始）
 *  @param args_5 fuLoad LR_* 标志（LR_LOADFROMFILE=0x10/LR_SHARED=0x8000，系统 IDI 需 SHARED） */
export const LoadImage = /*@__PURE__*/ b('LoadImageW', '<HMODULE>ptr <WCHAR>ptr u32 i32 i32 u32 -> <>ptr')
/** 按资源 ID 序数加载图像（name 直传 MAKEINTRESOURCE 整数）；其余同 LoadImage
 *  @returns 图像句柄；失败 → 0
 *  @param args_0 hinst 模块句柄
 *  @param args_1 name 资源 ID 序数（如 IDI_APPLICATION=32512）
 *  @param args_2 uType IMAGE_* 真值
 *  @param args_3 cx 期望宽度（0 = 原始）
 *  @param args_4 cy 期望高度（0 = 原始）
 *  @param args_5 fuLoad LR_* 标志 */
export const LoadImageOrdinal = /*@__PURE__*/ b('LoadImageW', '<HMODULE>ptr <>ptr u32 i32 i32 u32 -> <>ptr')

// ============ 杂项高频 ============

/** 取系统度量
 *  @returns 度量值
 *  @param args_0 nIndex 度量索引（SM_CXSCREEN=0/SM_CYSCREEN=1 等 SM_*） */
export const GetSystemMetrics = /*@__PURE__*/ b('GetSystemMetrics', 'i32 -> i32')
/** 读/写系统参数
 *  @returns 成功 → 非 0
 *  @param args_0 uiAction SPI_* 操作码
 *  @param args_1 uiParam 参数（随操作而定，常为缓冲大小或 0）
 *  @param args_2 pvParam 数据 buffer（如 SPI_GETNONCLIENTMETRICS 的缓冲）
 *  @param args_3 fWinIni SPIF_* 写入标志（0 = 仅当前会话） */
export const SystemParametersInfo = /*@__PURE__*/ b('SystemParametersInfoW', 'u32 u32 <BYTE>ptr u32 -> i32')
/** 枚举顶层窗口
 *  @returns 全枚举完 → 非 0
 *  @param args_0 lpEnumFunc 回调指针（closure(stdcall)().ptr），回调返 0 停止
 *  @param args_1 lParam 透传给回调的附加值（常传 0） */
export const EnumWindows = /*@__PURE__*/ b('EnumWindows', '<>ptr <>ptr -> i32')

// ============ 显示模式（分辨率/刷新率）============

/** 枚举显示模式（iDevNum 从 0 起逐个枚举）
 *  @returns 找到 → 非 0；枚举尽 → 0
 *  @param args_0 lpszDeviceName 设备名，NULL = 主显示设备
 *  @param args_1 iDevNum 模式序号（0 起递增；-1 = 当前设置）
 *  @param args_2 lpDevMode DEVMODEW 出参缓冲（双向不注册 encoder，只收 def 的 .ptr；
 *    encode({ dmSize: DEVMODEW.size }).ptr 传入、decode 读回） */
export const EnumDisplaySettings = /*@__PURE__*/ b('EnumDisplaySettingsW', '<WCHAR>ptr u32 <DEVMODEW>ptr -> i32')
/** 改显示模式
 *  @returns DISP_CHANGE_*（0 = DISP_CHANGE_SUCCESSFUL）
 *  @param args_0 lpDevMode DEVMODEW 缓冲（须先枚举/预置 dmSize+dmFields，
 *    DM_PELSWIDTH|DM_PELSHEIGHT 等决定生效项；收 encode(...).ptr）
 *  @param args_1 dwFlags CDS_* 标志（0 = 仅当前会话、CDS_UPDATEREGISTRY = 写注册表持久化） */
export const ChangeDisplaySettings = /*@__PURE__*/ b('ChangeDisplaySettingsW', '<DEVMODEW>ptr u32 -> i32')
