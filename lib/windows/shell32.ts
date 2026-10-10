// shell32 绑定（shell 对话框 / PIDL→路径）
import { bind } from '../ffi/bind.js'

// dll 名部分应用（工厂转调保泛型 infer，见 lib/windows/user32.ts 头注释）
const b = <const S extends string>(name: string, sig: S) => bind('shell32.dll', name, sig)

/** 文件夹浏览对话框；PIDL 用 ole32.CoTaskMemFree 释放
 *  @returns PIDL，取消 → 0
 *  @param args_0 pbi BROWSEINFOW.encode(...).ptr（见 structs.ts） */
export const SHBrowseForFolder = /*@__PURE__*/ b('SHBrowseForFolderW', '<BROWSEINFOW>ptr -> <>ptr')

/** PIDL → 文件系统全路径
 *  @returns PIDL 在文件系统中 → 非 0，否则 0（缓冲内容未定义）
 *  @param args_0 pidl SHBrowseForFolder 等返回的 PIDL
 *  @param args_1 pszPath 出参缓冲，WCHAR.alloc(260)（MAX_PATH=260）、WCHAR.decode 读回 */
export const SHGetPathFromIDList = /*@__PURE__*/ b('SHGetPathFromIDListW', '<>ptr <BYTE>ptr -> u32')
