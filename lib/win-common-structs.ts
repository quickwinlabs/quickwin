import { struct } from './ffi/struct.js'

// 跨组件/示例共享的 Windows 结构体（CType IR，ffi-struct 按本机架构 MSVC 对齐布局）。
// OPENFILENAMEW（GetOpenFileNameW）。Win2000+ 定义含尾部 pvReserved/dwReserved/FlagsEx（即 XP 系统上的真实 sizeof=152/88）：
export const OPENFILENAMEW = struct({
  tag: 'struct',
  member: [
    { name: 'lStructSize', type: 'u32' },
    { name: 'hwndOwner', type: 'ptr' },
    { name: 'hInstance', type: 'ptr' },
    { name: 'lpstrFilter', type: 'ptr' },
    { name: 'lpstrCustomFilter', type: 'ptr' },
    { name: 'nMaxCustFilter', type: 'u32' },
    { name: 'nFilterIndex', type: 'u32' },
    { name: 'lpstrFile', type: 'ptr' },
    { name: 'nMaxFile', type: 'u32' },
    { name: 'lpstrFileTitle', type: 'ptr' },
    { name: 'nMaxFileTitle', type: 'u32' },
    { name: 'lpstrInitialDir', type: 'ptr' },
    { name: 'lpstrTitle', type: 'ptr' },
    { name: 'Flags', type: 'u32' },
    { name: 'nFileOffset', type: 'u16' },
    { name: 'nFileExtension', type: 'u16' },
    { name: 'lpstrDefExt', type: 'ptr' },
    { name: 'lCustData', type: 'ptr' },
    { name: 'lpfnHook', type: 'ptr' },
    { name: 'lpTemplateName', type: 'ptr' },
    { name: 'pvReserved', type: 'ptr' },
    { name: 'dwReserved', type: 'u32' },
    { name: 'FlagsEx', type: 'u32' },
  ],
})

// BROWSEINFOW（SHBrowseForFolderW）：
export const BROWSEINFOW = struct({
  tag: 'struct',
  member: [
    { name: 'hwndOwner', type: 'ptr' },
    { name: 'pidlRoot', type: 'ptr' },
    { name: 'pszDisplayName', type: 'ptr' },
    { name: 'lpszTitle', type: 'ptr' },
    { name: 'ulFlags', type: 'u32' },
    { name: 'lpfn', type: 'ptr' },
    { name: 'lParam', type: 'ptr' },
    { name: 'iImage', type: 'i32' },
  ],
})
