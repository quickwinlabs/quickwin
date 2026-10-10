// version.dll 绑定（文件版本资源——exe/dll「属性 → 详细信息」的数据；品牌约定见
// lib/windows/user32.ts 头注释）：
//   - 读取三段式：Size 拿缓冲大小与句柄 → Info 读进缓冲 → VerQueryValue 在缓冲内
//     查询子块（lplpBuffer 回写的指针指向缓冲内部，跟进读用 ffi.readByte 拼值）
//   - 位宽无关：句柄/指针出参槽一律 <BYTE>ptr 收 PAB(4/8) + DataView / os.arch 分支读回
import { bind, type CodecMap } from '../ffi/bind.js'

// dll 名部分应用（工厂转调保泛型 infer，见 lib/windows/user32.ts 头注释）
const b = <const S extends string, const LE extends CodecMap = {}>(name: string, sig: S, encoders?: LE) =>
    bind('version.dll', name, sig, encoders)

/** 取文件版本资源大小
 *  @returns 字节数（0 = 文件无版本资源）
 *  @param args_0 lptstrFilename 文件路径（禁空）
 *  @param args_1 lpdwHandle 出参槽（Info 步的入参句柄，MSDN 恒 0 但仍须传），
 *                PtrArrayBuffer(4) + Uint32Array 读回 */
export const GetFileVersionInfoSize = /*@__PURE__*/ b('GetFileVersionInfoSizeW',
    '<WCHAR>ptr! <BYTE>ptr -> u32')
/** 读版本资源进缓冲
 *  @returns 成功 → 非 0
 *  @param args_0 lptstrFilename 文件路径（禁空）
 *  @param args_1 dwHandle Size 步读回的句柄（恒 0）
 *  @param args_2 dwLen 缓冲字节数（= Size 返回值）
 *  @param args_3 lpData 接收缓冲（PtrArrayBuffer(dwLen)） */
export const GetFileVersionInfo = /*@__PURE__*/ b('GetFileVersionInfoW',
    '<WCHAR>ptr! u32 u32 <BYTE>ptr -> i32')
/** 在版本资源缓冲内查询子块
 *  @returns 成功 → 非 0
 *  @param args_0 pBlock Info 步的资源缓冲（PtrArrayBuffer 直传）
 *  @param args_1 lpszSubBlock 子块路径（禁空）：'\\' = 根块 VS_FIXEDFILEINFO、
 *                '\\StringFileInfo\\040904B0\\FileVersion' 等字符串表项
 *  @param args_2 lplpBuffer 出参槽（块内偏移指针写回），PtrArrayBuffer(8)
 *  @param args_3 puLen 出参槽（块字节数，VS_FIXEDFILEINFO = 52），PtrArrayBuffer(4) */
export const VerQueryValue = /*@__PURE__*/ b('VerQueryValueW',
    '<BYTE>ptr <WCHAR>ptr! <BYTE>ptr <BYTE>ptr -> i32')
