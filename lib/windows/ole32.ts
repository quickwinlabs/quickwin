// ole32 绑定（COM 基础面：线程初始化 / 实例创建 / CoTask 内存管理）。纯绑定，无逻辑：
// HRESULT 判定见 lib/com.ts 的 SUCCEEDED/FAILED（S_FALSE 也是成功态，别写 hr === 0）。
// GUID 类缓冲用 structs.ts 的 CLSID/IID/GUID 定义，rclsid/riid 传对象形（该位已注册
// encoder，mkPtrWriter 编码后 return 缓冲、callPlan held 到 ffiCall 之后）。别写
// CLSID.encode({...}).ptr：裸 number 走 mkPtrWriter 快路径不进 held，临时缓冲只求值期寿命。
// 代价：对象形不带品牌，rclsid/riid 互换编译期拦不住。
import { bind, type CodecMap } from '../ffi/bind.js'
import { CLSID, GUID, IID } from './structs.js'

// dll 名部分应用（工厂转调保泛型 infer，见 lib/windows/user32.ts 头注释）
const b = <const S extends string, const LE extends CodecMap = {}>(name: string, sig: S, encoders?: LE) =>
    bind('ole32.dll', name, sig, encoders)

/** 初始化当前线程的 COM（配对 CoUninitialize）
 *  @returns HRESULT。同线程同模型重复初始化 → S_FALSE（成功态，不是失败）
 *  @param args_0 pvReserved 必须 NULL
 *  @param args_1 dwCoInit CoInitFlag.* */
export const CoInitializeEx = /*@__PURE__*/ b('CoInitializeEx', '<>ptr u32 -> i32')
/** 反初始化当前线程的 COM（CoInitializeEx 的配对；未初始化 → CO_E_NOTINITIALIZED，返回 void 丢弃） */
export const CoUninitialize = /*@__PURE__*/ b('CoUninitialize', ' -> void')
/** 按 CLSID 创建 COM 对象实例。返回的对象指针指向一个存放 vtable 地址的单元。
 *  实测坑：未注册 CLSID 在 XP 上阻塞不返回（Win7 立即返 E_INVALIDARG）——别拿无效 CLSID
 *  试探，也别在交互路径上调它。
 *  @returns HRESULT
 *  @param args_0 [in] rclsid
 *  @param args_1 pUnkOuter 聚合创建（ClsCtx.AGGREGATE）时传外层对象指针，普通创建传 NULL
 *  @param args_2 dwClsContext ClsCtx.*
 *  @param args_3 [in] riid
 *  @param args_4 [out] ppv：缓冲地址，成功时写入对象指针 */
export const CoCreateInstance = /*@__PURE__*/ b('CoCreateInstance', '<CLSID>ptr! <>ptr u32 <IID>ptr! <>ptr! -> i32', { CLSID, IID })
/** 生成随机 GUID（16 字节写进出参缓冲）
 *  @returns HRESULT
 *  @param args_0 [out] pguid */
export const CoCreateGuid = /*@__PURE__*/ b('CoCreateGuid', '<GUID>ptr! -> i32', { GUID })
/** CoTask 堆分配（COM 契约要求的内存管理面；可能返 0 = 失败）
 *  @param args_0 cbSize 字节数（SIZE_T 指针宽度：x64 下可超 4GB，勿缩成 u32） */
export const CoTaskMemAlloc = /*@__PURE__*/ b('CoTaskMemAlloc', '<>ptr -> <>ptr')
/** 释放 CoTaskMemAlloc 分配的内存（0/NULL 安全）
 *  @param args_0 pv CoTaskMem 分配的指针 */
export const CoTaskMemFree = /*@__PURE__*/ b('CoTaskMemFree', '<>ptr -> void')
