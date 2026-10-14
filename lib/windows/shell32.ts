// shell32 绑定（shell 对话框 / PIDL→路径 / 托盘图标定位）
import { bind, type CodecMap } from '../ffi/bind.js'
import { NOTIFYICONIDENTIFIER } from './structs.js'

// dll 名部分应用（工厂转调保泛型 infer，见 lib/windows/user32.ts 头注释）；第三参透传
// encoders（结构入参位注册，方向约定见 lib/windows/user32.ts 头注释）
const b = <const S extends string, const LE extends CodecMap = {}>(name: string, sig: S, encoders?: LE) =>
    bind('shell32.dll', name, sig, encoders)

/** 文件夹浏览对话框；PIDL 用 ole32.CoTaskMemFree 释放
 *  @returns PIDL，取消 → 0
 *  @param args_0 pbi BROWSEINFOW.encode(...).ptr（见 structs.ts） */
export const SHBrowseForFolder = /*@__PURE__*/ b('SHBrowseForFolderW', '<BROWSEINFOW>ptr -> <>ptr')

/** PIDL → 文件系统全路径
 *  @returns PIDL 在文件系统中 → 非 0，否则 0（缓冲内容未定义）
 *  @param args_0 pidl SHBrowseForFolder 等返回的 PIDL
 *  @param args_1 pszPath 出参缓冲，WCHAR.alloc(260)（MAX_PATH=260）、WCHAR.decode 读回 */
export const SHGetPathFromIDList = /*@__PURE__*/ b('SHGetPathFromIDListW', '<>ptr <BYTE>ptr -> u32')

/** 取托盘通知图标的屏幕矩形（Shell_NotifyIconGetRect；**Win7+**——XP 无此导出，
 *  故为**可选绑定**：老系统上本常量为 null（bind() 是模块顶层立即解析，缺符号 throw
 *  会拖垮整个脚本启动），调用方必须判空）
 *  @returns HRESULT，实测语义：0 = 图标在通知区内，iconLocation = 其容器（可见区 /
 *    溢出面板）内位置——**溢出面板未展开时该 rect 不是屏幕可点位**；1 = 按文档为
 *    不可见态（隐藏/溢出；本机未复现——实测 Win7 溢出图标亦返 0）；0x80004005 E_FAIL
 *    = 图标不存在，或该图标未按 {hWnd,uID} 注册（系统 GUID 图标实测 not_found）
 *  @param args_0 identifier NOTIFYICONIDENTIFIER 对象直传（encoder 已注册；cbSize 填
 *    NOTIFYICONIDENTIFIER.size，guidItem 缺省 = GUID_NULL 走 hWnd+uID）
 *  @param args_1 iconLocation 出参槽，RECT.alloc().ptr（出参位不注册，方向约定同
 *    user32），RECT.decode 读回 */
export const Shell_NotifyIconGetRect = (() => {
    try {
        return b('Shell_NotifyIconGetRect',
            '<NOTIFYICONIDENTIFIER>ptr <RECT>ptr -> i32', { NOTIFYICONIDENTIFIER })
    } catch {
        return null    // XP 等老系统无此导出（可选 API）；探测走 examples/execd/tray.ts
    }
})()
