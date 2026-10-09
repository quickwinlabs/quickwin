// comdlg32 绑定（通用文件对话框；GetOpenFileName 无 A/W 混用——一律 W 版）
import { bind } from '../ffi/bind.js'

// dll 名部分应用（工厂转调保泛型 infer，见 lib/windows/user32.ts 头注释）
const b = <const S extends string>(name: string, sig: S) => bind('comdlg32.dll', name, sig)

/** 打开/保存文件对话框（lpOpenfn 传 OPENFILENAMEW.encode(...).ptr，见 structs.ts）；
 *  用户确认 → 非 0（lpstrFile 缓冲即选中路径），取消/出错 → 0
 *  @param args_0 pOpenfn OPENFILENAMEW 结构指针（lStructSize 必须 = OPENFILENAMEW.size） */
export const GetOpenFileName = /*@__PURE__*/ b('GetOpenFileNameW', '<BYTE>ptr -> u32')
