import { struct } from './ffi-struct.js'

// 跨组件/示例共享的 Windows 结构体（ffi-struct 按本机架构 MSVC 对齐布局）。
// OPENFILENAMEW（GetOpenFileNameW）。Win2000+ 定义含尾部 pvReserved/dwReserved/FlagsEx（即 XP 系统上的真实 sizeof=152/88）：
export const OPENFILENAMEW = struct({
  lStructSize: 'u32',
  hwndOwner: 'ptr',
  hInstance: 'ptr',
  lpstrFilter: 'ptr',
  lpstrCustomFilter: 'ptr',
  nMaxCustFilter: 'u32',
  nFilterIndex: 'u32',
  lpstrFile: 'ptr',
  nMaxFile: 'u32',
  lpstrFileTitle: 'ptr',
  nMaxFileTitle: 'u32',
  lpstrInitialDir: 'ptr',
  lpstrTitle: 'ptr',
  Flags: 'u32',
  nFileOffset: 'u16',
  nFileExtension: 'u16',
  lpstrDefExt: 'ptr',
  lCustData: 'ptr',
  lpfnHook: 'ptr',
  lpTemplateName: 'ptr',
  pvReserved: 'ptr',
  dwReserved: 'u32',
  FlagsEx: 'u32',
})

// BROWSEINFOW（SHBrowseForFolderW）：
export const BROWSEINFOW = struct({
  hwndOwner: 'ptr',
  pidlRoot: 'ptr',
  pszDisplayName: 'ptr',
  lpszTitle: 'ptr',
  ulFlags: 'u32',
  lpfn: 'ptr',
  lParam: 'ptr',
  iImage: 'i32',
})