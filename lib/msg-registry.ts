import type { HWND } from 'gui'
import type { MaybePtr, Ptr } from './ffi/ctype.js'
import type { WmMsg, LbMsg, TcMsg, LvMsg, HdmMsg, ButtonMsg, ButtonExtMsg, EditMsg, ComboBoxMsg, ProgressMsg, TbMsg, DtMsg, TvMsg, TtMsg } from '../constants'

/**
 * 消息 → wParam/lParam 类型注册表（全局 interface 声明合并，仿 EnumMap / QuickWinClassRegistry）。
 *
 * 框架预填「已知消息」（组件/渲染器/示例实际用到的窗口消息 + 控件消息）；消费方在
 * 自己的 .d.ts 里追加自定义消息（声明合并）：
 *   // script 文件（无 import/export）：
 *   interface QuickWinMsgRegistry { 0x8001: { wParam: number; lParam: number } }
 *   // 或 module 文件：
 *   export {}; declare global { interface QuickWinMsgRegistry { 0x8001: { wParam: number; lParam: number } } }
 *
 * key = 消息号（数字字面量），value = 该消息的 wParam/lParam 类型。参数位为「发送」语义
 * （调用方传什么）：指针形 lParam 用 MaybePtr<'X'>（组件/消费方传品牌化 buf.ptr 或 NULL），
 * 打包数字用 number（字符串语义的消息（WM_SETTEXT/ADDSTRING）也走 MaybePtr<'WCHAR'> 品牌指针）。
 *
 * 绝大多数消息两个参数都是纯 number（打包/计数/标志/索引），由 PlainMsg 联合 + 映射
 * `extends Record<PlainMsg, { wParam: number; lParam: number }>` 一行收编，避免几十条重复
 * `{ wParam: number; lParam: number }` 手写。Record 的键是 K 的「值」（数字字面量），
 * 因此同值不同枚举成员（如 TbMsg.SETRANGE 与 ProgressMsg.SETRANGE32 都是 1030、裸宏
 * 1047/1048/1053）会被吸收成同一个数字键；消费方传任一枚举成员或裸数字字面量都能匹配
 * （TS：枚举成员可赋给同值数字字面量，实测验证）。
 *
 * 非纯（number|string / MaybePtr）条目逐条显式，不并入 PlainMsg。
 *
 * 未注册的消息（含内置枚举未覆盖的裸数字）视为「消费方不关心」：
 *   - onEvent 里 `e.msg === X` 比较 → TS2367；
 *   - gui.SendMessage 传 X → 无重载匹配 → TS2769。
 * 运行时未注册消息仍会到达窗口过程（窗口过程是发到该 hwnd 的所有消息的接收端），
 * 经默认转发（DefWindowProc / callOldWndProc）透传，不影响不关心的消费方。
 *
 * 注意：constants.ts 由 tools/gen_const.c 自动生成（gen_const.exe 在 VM 里跑），
 * 本注册表与 WEvent/SendMessageCall 推导必须放在手写文件里（本文件），勿进 constants.ts。
 */

/** 纯 number 消息的参数形状（打包/计数/标志/索引/坐标） */
type PlainMsgParams = { wParam: number; lParam: number }

/** 纯 number（wParam/lParam 都真是 number）消息的字面量联合：打包/计数/标志/索引/坐标。
 *  Record 映射收编为 { wParam: number; lParam: number }；同值键（1030/1047/1048/1053）吸收。 */
type PlainMsg =
    // —— 窗口消息（onEvent 会收到；部分也经 gui.SendMessage 发送）——
    | WmMsg.NULL | WmMsg.CREATE | WmMsg.DESTROY | WmMsg.COMMAND | WmMsg.PAINT
    | WmMsg.CLOSE | WmMsg.ERASEBKGND | WmMsg.SETCURSOR | WmMsg.GETFONT | WmMsg.SIZE
    | WmMsg.NCHITTEST | WmMsg.NCLBUTTONDOWN | WmMsg.VSCROLL | WmMsg.HSCROLL
    | WmMsg.MOUSEWHEEL | WmMsg.CHAR | WmMsg.LBUTTONDOWN | WmMsg.LBUTTONUP
    | WmMsg.KEYDOWN | WmMsg.KEYUP | WmMsg.MOUSEMOVE
    // —— 控件消息（gui.SendMessage 发送；不 arrive onEvent）——
    | EditMsg.GETSEL | EditMsg.SETSEL
    | LvMsg.GETHEADER | LvMsg.DELETECOLUMN | LvMsg.SETEXTENDEDLISTVIEWSTYLE
    | LvMsg.DELETEALLITEMS | LvMsg.SETCOLUMNWIDTH
    | HdmMsg.GETITEMCOUNT
    // 1030 = TbMsg.SETRANGE = ProgressMsg.SETRANGE32（同值不同枚举成员）。
    // 必须用裸数字键：TS 的 Record<同值双枚举, V> 键异常（两个同值枚举成员作 mapped key 冲突，
    // 消费方传任一枚举成员/裸 1030 都 TS2769）；裸键则枚举成员 ⊆ 同值字面量，两者都匹配
    | 1030
    | TbMsg.SETPOS | TbMsg.GETPOS | ProgressMsg.SETPOS
    | ComboBoxMsg.RESETCONTENT | ComboBoxMsg.SETCURSEL | ComboBoxMsg.GETCURSEL
    | ButtonMsg.SETCHECK | ButtonMsg.GETCHECK
    | TvMsg.GETCOUNT | TvMsg.DELETEITEM | TvMsg.SETEXTENDEDSTYLE
    | LbMsg.RESETCONTENT | LbMsg.SETCURSEL | LbMsg.SETTOPINDEX | LbMsg.GETCURSEL
    | TcMsg.DELETEALLITEMS | TcMsg.SETCURSEL | TcMsg.GETCURSEL
    // 1048 = TtMsg.SETMAXTIPWIDTH = TB_BUTTONCOUNT（裸数字宏：枚举键吸收）
    | TtMsg.SETMAXTIPWIDTH
    | TtMsg.ACTIVATE
    // —— 工具栏消息（examples/execd/tray.ts 用裸数字宏）——
    | TbMsg.SETLINESIZE // 1047 = TB_GETBUTTON（= TbMsg.SETLINESIZE 同值）
    | 1053 // TB_GETITEMRECT（裸宏，无枚举成员）

declare global {
    interface QuickWinMsgRegistry extends Record<PlainMsg, PlainMsgParams> {
        // —— 非纯条目（MaybePtr）逐条显式 ——
        // WM_SETTEXT 的 lParam 是 WCHAR 串/指针（bench 经 gui.SendMessage 发送品牌指针）
        [WmMsg.SETTEXT]: { wParam: number; lParam: MaybePtr<'WCHAR'> }
        [WmMsg.GETTEXT]: { wParam: number; lParam: MaybePtr<'WCHAR'> }
        [WmMsg.NOTIFY]: { wParam: number; lParam: MaybePtr<'NMHDR'> }
        [WmMsg.SETFONT]: { wParam: MaybePtr<'HGDIOBJ'>; lParam: number }
        [EditMsg.SETCUEBANNER]: { wParam: number; lParam: MaybePtr<'WCHAR'> }
        [LvMsg.SETIMAGELIST]: { wParam: number; lParam: MaybePtr<'HIMAGELIST'> }
        [LvMsg.INSERTCOLUMNW]: { wParam: number; lParam: MaybePtr<'LVCOLUMNW'> }
        [LvMsg.INSERTITEMW]: { wParam: number; lParam: MaybePtr<'LVITEMW'> }
        [LvMsg.SETITEMW]: { wParam: number; lParam: MaybePtr<'LVITEMW'> }
        [LvMsg.SUBITEMHITTEST]: { wParam: number; lParam: MaybePtr<'LVHITTESTINFO'> }
        [DtMsg.SETSYSTEMTIME]: { wParam: number; lParam: MaybePtr<'SYSTEMTIME'> }
        [ButtonExtMsg.GETIDEALSIZE]: { wParam: number; lParam: MaybePtr<'SIZE'> }
        [TvMsg.INSERTITEMW]: { wParam: number; lParam: MaybePtr<'TVINSERTSTRUCT'>; ret: Ptr<'HTREEITEM'> }
        // HTREEITEM 句柄（TreeView 项）：EXPAND/SELECTITEM/GETNEXTITEM 的 lParam 是项句柄或 NULL
        [TvMsg.EXPAND]: { wParam: number; lParam: MaybePtr<'HTREEITEM'> }
        [TvMsg.SELECTITEM]: { wParam: number; lParam: MaybePtr<'HTREEITEM'> }
        [TvMsg.GETNEXTITEM]: { wParam: number; lParam: MaybePtr<'HTREEITEM'>; ret: Ptr<'HTREEITEM'> }
        [TcMsg.INSERTITEMW]: { wParam: number; lParam: MaybePtr<'TCITEMW'> }
        [TtMsg.ADDTOOLW]: { wParam: number; lParam: MaybePtr<'TTTOOLINFOW'> }
        [TtMsg.DELTOOLW]: { wParam: number; lParam: MaybePtr<'TTTOOLINFOW'> }
        [ComboBoxMsg.ADDSTRING]: { wParam: number; lParam: MaybePtr<'WCHAR'> }
        [LbMsg.ADDSTRING]: { wParam: number; lParam: MaybePtr<'WCHAR'> }
    }
}

/** 注册表全部消息号之并（框架预填 ∪ 消费方注册）；未注册时不含，用于 onEvent/SendMessage 值域 */
export type RegisteredMsg = keyof QuickWinMsgRegistry

/** 注册表 value 去掉发送返回类型（onEvent 接收无 ret） */
type MsgParams<K extends keyof QuickWinMsgRegistry> = Omit<QuickWinMsgRegistry[K], 'ret'>
/** 发送返回类型：显式 ret（如 INSERTITEMW 的 Ptr<'HTREEITEM'>）或默认 number */
type MsgRet<K extends keyof QuickWinMsgRegistry> =
    QuickWinMsgRegistry[K] extends { ret: infer R } ? R : number
/** onEvent 收到的单条消息：hwnd + msg 判别名 + 注册表参数 */
type MsgEvent<K extends keyof QuickWinMsgRegistry> = { hwnd: HWND; msg: K } & MsgParams<K>

/** onEvent 收到的消息判别联合：msg 判别名，窄化后 wParam/lParam 类型来自注册表。
 *  参数位为「接收」语义（C 侧以打包数字传给窗口过程；个别发送消息（如 ADDSTRING）的
 *  lParam 在注册表里是 MaybePtr<'WCHAR'>，但该消息不会 arrive，仅在 SendMessage 侧用到）。 */
export type WEvent =
    { [K in keyof QuickWinMsgRegistry]: MsgEvent<K> }[keyof QuickWinMsgRegistry]

/** 联合 → 函数交叉（重载签名）：TS 把交叉的函数类型当重载解析 */
type UnionToIntersection<U> = (U extends any ? (x: U) => void : never) extends (x: infer I) => void ? I : never

/** gui.SendMessage 的重载形式：每个已知/注册消息一条签名，未注册消息无签名 → TS2769。
 *  参数位为「发送」语义（调用方传什么）；运行时实现不变（js_SendMessage，见 src/quickjs-gui.c）。 */
export type SendMessageCall = UnionToIntersection<
    { [K in keyof QuickWinMsgRegistry]:
        (hwnd: HWND, msg: K, wParam: QuickWinMsgRegistry[K]['wParam'], lParam: QuickWinMsgRegistry[K]['lParam']) => MsgRet<K>
    }[keyof QuickWinMsgRegistry]
>
