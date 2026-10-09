// ole32 绑定（COM 内存管理；仅 CoTaskMemFree——shell 对话框返回的 PIDL 需它释放）
import { bind } from '../ffi/bind.js'

// dll 名部分应用（工厂转调保泛型 infer，见 lib/windows/user32.ts 头注释）
const b = <const S extends string>(name: string, sig: S) => bind('ole32.dll', name, sig)

/** 释放 CoTaskMemAlloc 分配的内存（SHBrowseForFolder 返回的 PIDL 等）；无返回值
 *  @param args_0 pv CoTaskMem 分配的指针（0/NULL 安全） */
export const CoTaskMemFree = /*@__PURE__*/ b('CoTaskMemFree', '<>ptr -> void')
