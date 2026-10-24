// oleaut32.dll 绑定（BSTR / VARIANT 生命周期；COM 自动化类型的内存管理面）。
// 读取 BSTR 内容：长度在 bstr-4 的 u32（字节数，不含 NUL），数据为 UTF-16LE；
// 本模块只放释放与长度，字符串解释由调用方用 ffi.readBytes 完成。
import { bind } from '../ffi/bind.js'

// dll 名部分应用（工厂转调保泛型 infer，见 lib/windows/user32.ts 头注释）
const b = <const S extends string>(name: string, sig: S) => bind('oleaut32.dll', name, sig)

/** 释放 BSTR（NULL 安全）。COM 出参的 BSTR 归调用方，用完必须调 */
export const SysFreeString = /*@__PURE__*/ b('SysFreeString', '<>ptr -> void')

/** BSTR 字符数（不含结尾 NUL；NULL → 0）。
 *  注意：返回的是**字符数**，不是字节数——BSTR 的 4 字节前缀存字节数，本函数内部
 *  除以 2。按字节读内容时别拿它当长度（直接读 bstr-4 的 u32 更直白） */
export const SysStringLen = /*@__PURE__*/ b('SysStringLen', '<>ptr -> u32')

/** 清理 VARIANT（按 vt 释放内部指针）；遍历 IEnumVARIANT 时每个取出的元素都要调 */
export const VariantClear = /*@__PURE__*/ b('VariantClear', '<>ptr -> i32')
