// bcrypt.dll 绑定（CNG 加解密 / 哈希子集，Windows Vista+；CNG 全家族最小支持 Vista）。
// 句柄槽（phAlgorithm / phKey / phHash 出参）用 PtrArrayBuffer(8) 接收，DataView 读回
// u64；算法名（pszAlgId 'SHA512' 等）与属性名（pszProperty）传 JS string（<WCHAR>ptr!
// 编码）；secret/key/IV/data 均 <BYTE>ptr 字节缓冲（传 .ptr 或 string）。
// NTSTATUS 返回：0 = 成功（STATUS_SUCCESS），非 0 = 失败（本模块调用方按 !== 0 判失败）。
import { bind, type CodecMap } from '../ffi/bind.js'

const b = <const S extends string, const LE extends CodecMap = {}>(name: string, sig: S, encoders?: LE) =>
    bind('bcrypt.dll', name, sig, encoders)

/** CNG 算法提供者（phAlgorithm 出参槽 = PtrArrayBuffer(8)，DataView.getBigUint64 读回）
 *  @returns 0 = 成功（NTSTATUS），非 0 = 失败
 *  @param args_0 [out] phAlgorithm：算法句柄出参槽，须 `const h = PtrArrayBuffer(8)`
 *    保存引用后传 `h.ptr`（勿内联 .alloc().ptr——临时 buffer 无引用会被提前 GC）
 *  @param args_1 pszAlgId 算法名（'AES' / 'SHA512' / 'SHA1' 等，传 string）
 *  @param args_2 pszImplementation 实现名，传 NULL（默认实现）
 *  @param args_3 dwFlags 标志（BcryptAlgFlag：NONE=0 / HMAC=0x8，gen_const 生成） */
export const BCryptOpenAlgorithmProvider = /*@__PURE__*/ b('BCryptOpenAlgorithmProvider',
    '<>ptr <WCHAR>ptr <>ptr u32@BcryptAlgFlag -> i32')
/** 设算法/密钥属性（如 BCRYPT_CHAIN_MODE_CBC）
 *  @returns 0 = 成功，非 0 = 失败
 *  @param args_0 hObject 算法/密钥句柄
 *  @param args_1 pszProperty 属性名（传 string）
 *  @param args_2 pbInput 属性值缓冲
 *  @param args_3 cbInput 属性值字节数
 *  @param args_4 dwFlags 保留，传 0 */
export const BCryptSetProperty = /*@__PURE__*/ b('BCryptSetProperty',
    '<>ptr <WCHAR>ptr <BYTE>ptr u32 u32 -> i32')
/** 生成对称密钥（AES-CBC 等；phKey 出参槽 = PtrArrayBuffer(8)）
 *  @returns 0 = 成功，非 0 = 失败
 *  @param args_0 hAlgorithm 算法句柄
 *  @param args_1 [out] phKey：密钥句柄出参槽，须 `const k = PtrArrayBuffer(8)` 保存引用后传 `k.ptr`
 *  @param args_2 pbKeyObject 密钥对象缓冲，传 NULL（本库不预分配）
 *  @param args_3 cbKeyObject 密钥对象缓冲字节数，传 0
 *  @param args_4 pbSecret 密钥材料
 *  @param args_5 cbSecret 密钥材料字节数
 *  @param args_6 dwFlags 保留，传 0 */
export const BCryptGenerateSymmetricKey = /*@__PURE__*/ b('BCryptGenerateSymmetricKey',
    '<>ptr <>ptr <>ptr u32 <BYTE>ptr u32 u32 -> i32')
/** 解密（对称；pbInput 原地可复用为输出）
 *  @returns 0 = 成功，非 0 = 失败
 *  @param args_0 hKey 密钥句柄
 *  @param args_1 pbInput 密文输入
 *  @param args_2 cbInput 密文字节数
 *  @param args_3 pPaddingInfo 填充信息，传 NULL
 *  @param args_4 pbIV 初始向量
 *  @param args_5 cbIV IV 字节数
 *  @param args_6 pbOutput 明文输出
 *  @param args_7 cbOutput 输出缓冲字节数
 *  @param args_8 [out] pcbResult：实际写出字节数槽（PtrArrayBuffer(4)，须保存引用后传 .ptr）
 *  @param args_9 dwFlags 保留，传 0 */
export const BCryptDecrypt = /*@__PURE__*/ b('BCryptDecrypt',
    '<>ptr <BYTE>ptr u32 <>ptr <BYTE>ptr u32 <BYTE>ptr u32 <>ptr u32 -> i32')
/** 销毁密钥句柄
 *  @returns 0 = 成功，非 0 = 失败
 *  @param args_0 hKey 密钥句柄 */
export const BCryptDestroyKey = /*@__PURE__*/ b('BCryptDestroyKey', '<>ptr -> i32')
/** 关闭算法提供者
 *  @returns 0 = 成功，非 0 = 失败
 *  @param args_0 hAlgorithm 算法句柄
 *  @param args_1 dwFlags 保留，传 0 */
export const BCryptCloseAlgorithmProvider = /*@__PURE__*/ b('BCryptCloseAlgorithmProvider',
    '<>ptr u32 -> i32')
/** 创建哈希（HMAC 用 BCRYPT_ALG_HANDLE_HMAC_FLAG 打开的算法；phHash 出参槽 = PtrArrayBuffer(8)）
 *  @returns 0 = 成功，非 0 = 失败
 *  @param args_0 hAlgorithm 算法句柄
 *  @param args_1 [out] phHash：哈希句柄出参槽，须 `const h = PtrArrayBuffer(8)` 保存引用后传 `h.ptr`
 *  @param args_2 pbHashObject 哈希对象缓冲，传 NULL
 *  @param args_3 cbHashObject 哈希对象缓冲字节数，传 0
 *  @param args_4 pbSecret HMAC 密钥材料（纯哈希传 NULL）
 *  @param args_5 cbSecret 密钥材料字节数
 *  @param args_6 dwFlags 保留，传 0 */
export const BCryptCreateHash = /*@__PURE__*/ b('BCryptCreateHash',
    '<>ptr <>ptr <>ptr u32 <BYTE>ptr u32 u32 -> i32')
/** 喂哈希数据
 *  @returns 0 = 成功，非 0 = 失败
 *  @param args_0 hHash 哈希句柄
 *  @param args_1 pbInput 输入数据
 *  @param args_2 cbInput 输入字节数
 *  @param args_3 dwFlags 保留，传 0 */
export const BCryptHashData = /*@__PURE__*/ b('BCryptHashData',
    '<>ptr <BYTE>ptr u32 u32 -> i32')
/** 结束哈希并取结果
 *  @returns 0 = 成功，非 0 = 失败
 *  @param args_0 hHash 哈希句柄
 *  @param args_1 pbOutput 结果缓冲（SHA512 = 64B）
 *  @param args_2 cbOutput 结果缓冲字节数
 *  @param args_3 dwFlags 保留，传 0 */
export const BCryptFinishHash = /*@__PURE__*/ b('BCryptFinishHash',
    '<>ptr <BYTE>ptr u32 u32 -> i32')
/** 销毁哈希句柄
 *  @returns 0 = 成功，非 0 = 失败
 *  @param args_0 hHash 哈希句柄 */
export const BCryptDestroyHash = /*@__PURE__*/ b('BCryptDestroyHash', '<>ptr -> i32')

// BCryptOpenAlgorithmProvider 的 dwFlags 值域：BcryptAlgFlag（NONE=0 无标志 / HMAC=0x8，
// 以 HMAC 模式打开哈希算法如 'SHA512' → HMAC-SHA512）——由 tools/gen_const.c 生成到
// constants.ts，消费方 `import { BcryptAlgFlag } from 'quickwin/constants'`。
// MSDN：dwFlags 唯一宏定义值即 BCRYPT_ALG_HANDLE_HMAC_FLAG，0 = 无标志（合法默认）。
