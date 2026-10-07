import { struct } from '../ffi/struct.js'

// NMHDR = hwndFrom(ptr) + idFrom(ptr) + code(i32)。
// 用 ffi-struct 定义以复现 MSVC/嵌套结构的“尾 padding 传染”（内嵌 NMHDR 占满 24/12 字节）。
// 各通知结构把它作为首字段嵌套（NMHDR.__struct），字段偏移由 struct 按进程位宽推出。
export const NMHDR = struct({
  hwndFrom: '<>ptr',
  idFrom: '<>ptr',
  code: 'i32',
})

// 读 NMHDR.code（WM_NOTIFY 通知码）：lParam 是通知结构的原生指针，decode 直接从该地址读
export function nmCode(lParam: number): number {
  return NMHDR.decode(lParam).code
}
