import type { Ptr } from '../ffi/ctype.js'
import { NMHDR } from '../windows/structs.js'

// 读 NMHDR.code（WM_NOTIFY 通知码）：lParam 是通知结构的原生指针，decode 直接从该地址读
export function nmCode(lParam: number): number {
  return NMHDR.decode(lParam as Ptr<'NMHDR'>).code
}
