import type { HWND } from 'gui'
import type { WEvent } from '../msg-registry.js'

// 标准 Win32 控件类（CreateWindow 的 lpClassName 真实字符串，含 comctl32 注册类）。
// 未列出的类（自定义控件 / 第三方类）走 QuickWinClassRegistry 全局注册，见下。
type Win32Class =
  | 'BUTTON' | 'STATIC' | 'EDIT' | 'COMBOBOX' | 'LISTBOX' | 'SCROLLBAR'
  | 'SysListView32' | 'SysTreeView32' | 'msctls_trackbar32' | 'msctls_progress32'
  | 'SysDateTimePick32' | 'SysMonthCal32' | 'SysTabControl32' | 'SysHeader32'
  | 'ToolbarWindow32' | 'msctls_statusbar32' | 'ReBarWindow32' | 'msctls_updown32'
  | 'SysAnimate32' | 'msctls_hotkey32' | 'SysIPAddress32' | 'RichEdit20W'
  | 'ComboBoxEx32' | 'tooltips_class32' | 'SysLink'

// 自定义控件类名注册表 —— 全局 interface 声明合并（仿 EnumMap，见 lib/ffi/ctype.ts）。
// 用户在自己的 .d.ts 里直接扩展（空表默认：keyof = never，type 只剩 Win32Class）：
//   // script 文件（无 import/export）：
//   interface QuickWinClassRegistry { MyCtrl: true }
//   // 或 module 文件：
//   export {}; declare global { interface QuickWinClassRegistry { MyCtrl: true } }
// 勿用 declare module 'react'：用户 import specifier 形态不定，模块匹配不上会静默失效，
// 且会把注册表绑死在 react 模块上（严格 jsxImportSource 路径用全新 namespace，够不到）。
// 运行时自定义控件仍需先 RegisterClass 注册类，类型层只是约束类名。
declare global {
  interface QuickWinClassRegistry {}
}

interface WStyle {
  width?: number | 'auto'; height?: number | 'auto'
  flexDirection?: 'row' | 'column'
  justifyContent?: 'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around' | 'space-evenly'
  alignItems?: 'flex-start' | 'flex-end' | 'center' | 'stretch'
  alignSelf?: 'auto' | 'flex-start' | 'flex-end' | 'center' | 'stretch'
  gap?: number
  padding?: number
  paddingTop?: number
  paddingRight?: number
  paddingBottom?: number
  paddingLeft?: number
  flexGrow?: number
}

interface WOnEventObj {
  fn: (e: WEvent & {callOldWndProc: () => number}) => number
}
interface WIntrinsicProps {
  key?: string | number; type: Win32Class | keyof QuickWinClassRegistry; text?: string; ws?: number
  disabled?: boolean; visible?: boolean; hidden?: boolean; style?: WStyle
  onEvent?: ((e: WEvent) => number | void) | WOnEventObj
  children?: React.ReactNode
  ref?: React.Ref<HWND>
}
export type { WEvent, WIntrinsicProps, WStyle, Win32Class }
