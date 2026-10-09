// ntdll 绑定（仅 RtlGetVersion——绕过 GetVersionEx 的兼容性谎言取真实版本）
import { bind } from '../ffi/bind.js'

// dll 名部分应用（工厂转调保泛型 infer，见 lib/windows/user32.ts 头注释）
const b = <const S extends string>(name: string, sig: S) => bind('ntdll.dll', name, sig)

/** 取真实 OS 版本（成功 → 0）；缓冲必须用 OSVERSIONINFO_148（148B 特制布局，
 *  标准 OSVERSIONINFOW 会越界写坏调用方堆，见 structs.ts）
 *  @param args_0 lpVersionInformation OSVERSIONINFO_148.encode(...).ptr 出参缓冲 */
export const RtlGetVersion = /*@__PURE__*/ b('RtlGetVersion', '<BYTE>ptr -> i32')
