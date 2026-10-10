// psapi.dll 绑定（进程内存统计 / 模块路径；品牌约定见 lib/windows/user32.ts 头注释）：
//   - 句柄位与 kernel32 同型互认：进程 <HPROCESS>ptr（OpenProcess 产物，CloseHandle 收宽
//     直通）、模块 <HMODULE>ptr（NULL = 主执行模块）
//   - PID 数组 / DWORD 出参槽用 <BYTE>ptr 直收 PtrArrayBuffer（TypedArray 原地读回）；
//     结构出参位收 alloc().ptr、预写首字段后 decode 读回（PROCESSENTRY32W 同法，
//     见 ./structs.ts JSDoc）
//   - XP 起系统自带 psapi.dll（官方 min XP 桌面应用），XP/Win7 双机直连
import { bind } from '../ffi/bind.js'

// dll 名部分应用（工厂转调保泛型 infer，见 lib/windows/user32.ts 头注释）
const b = <const S extends string>(name: string, sig: S) => bind('psapi.dll', name, sig)

/** 把系统进程 PID 填进数组缓冲
 *  @returns 成功 → 非 0
 *  @param args_0 lpidProcess PID 数组缓冲（PtrArrayBuffer(count * 4)，Uint32Array 读回）
 *  @param args_1 cb 缓冲字节数（= count * 4）
 *  @param args_2 lpcbNeeded 出参槽（实际写字节数 → PID 数 = /4），PtrArrayBuffer(4) */
export const EnumProcesses = /*@__PURE__*/ b('EnumProcesses',
    '<BYTE>ptr u32 <BYTE>ptr -> i32')
/** 取进程内存统计
 *  @returns 成功 → 非 0
 *  @param args_0 hProcess 进程句柄（须 PROCESS_QUERY_INFORMATION | PROCESS_VM_READ）
 *  @param args_1 ppmc 出参缓冲：alloc() 后预写 offset0 cb = size（new Uint32Array(buf)[0]
 *                = PROCESS_MEMORY_COUNTERS.size），decode(buf) 读回
 *  @param args_2 cb 结构字节数（= PROCESS_MEMORY_COUNTERS.size） */
export const GetProcessMemoryInfo = /*@__PURE__*/ b('GetProcessMemoryInfo',
    '<HPROCESS>ptr! <PROCESS_MEMORY_COUNTERS>ptr! u32 -> i32')
/** 取进程模块完整路径（hModule = NULL → 主执行文件）
 *  @returns 写入字符数（0 失败；
 *  缓冲不足 = 截断返回 nSize 不含 NUL）
 *  @param args_0 hProcess 进程句柄（PROCESS_QUERY_INFORMATION | PROCESS_VM_READ）
 *  @param args_1 hModule 模块句柄（NULL = exe 主模块；toolhelp MODULEENTRY32W.hModule 是
 *                目标进程上下文的值，跨进程须同权限下重开句柄才可用——本族先例：NULL 用法）
 *  @param args_2 lpFilename 文本出参缓冲（WCHAR.alloc(n) + WCHAR.decode 读回）
 *  @param args_3 nSize 缓冲字符数（含 NUL 空间） */
export const GetModuleFileNameEx = /*@__PURE__*/ b('GetModuleFileNameExW',
    '<HPROCESS>ptr! <HMODULE>ptr <BYTE>ptr u32 -> u32')
