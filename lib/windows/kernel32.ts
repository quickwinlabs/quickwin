// kernel32.dll 绑定（进程 / 管道 / 系统信息子集；品牌约定见 lib/windows/user32.ts 头注释）：
//   - HANDLE（管道 / 进程 / 线程等内核对象句柄）保持 <>ptr：与 gdi32 的 HGDIOBJ 同理，
//     异种对象互传由运行时句柄有效性判定，类型层不设品牌
//   - 结构位按方向分流（结构定义见 ./structs.ts，布局随进程位宽，struct 按 os.arch 推）：
//       STARTUPINFOW 纯入参位注册 encoder → DeepPartial 对象直传；
//       PROCESS_INFORMATION 出参位不注册 → 只收 def 分配的 .ptr，读回走 decode
//   - 缓冲区 / DWORD 出参位用 <BYTE>ptr 直接收 ArrayBuffer（Uint32Array(1).buffer 读回）
//   - 空指针位（lpApplicationName / lpProcessAttributes 等）传 NULL（来自 ../ffi/ctype.js）；
//     传 JS null/undefined 会在参数槽 fail-loud
//   - 返回值 0 保真（C→JS 不做 0→null）；BOOL 型返回 i32，成功 → 非 0，失败 → 0（原因见 GetLastError）
import { bind, type CodecMap } from '../ffi/bind.js'
import { STARTUPINFOW } from './structs.js'

// dll 名部分应用（工厂转调保泛型 infer，见 lib/windows/user32.ts 头注释）
const b = <const S extends string, const LE extends CodecMap = {}>(name: string, sig: S, encoders?: LE) =>
    bind('kernel32.dll', name, sig, encoders)

// ============ 管道 / 进程 ============

/** 建匿名管道；hReadPipe / hWritePipe 为两个 HANDLE 出参槽（各占一个指针宽度），
 *  lpPipeAttributes 传 NULL；nSize 传 0 用默认缓冲；成功 → 非 0 */
export const CreatePipe = /*@__PURE__*/ b('CreatePipe', '<>ptr <>ptr <>ptr u32 -> i32')
/** 设句柄标志（dwMask / dwFlags 如 HANDLE_FLAG_INHERIT = 1）；成功 → 非 0 */
export const SetHandleInformation = /*@__PURE__*/ b('SetHandleInformation', '<>ptr u32 u32 -> i32')
/** 建进程（lpApplicationName / lpCommandLine 为 string 或 NULL；lpStartupInfo 传对象
 *  { cb: STARTUPINFOW.size, dwFlags, hStd* … }（cb 必填），lpProcessInformation 传
 *  PROCESS_INFORMATION.encode().ptr、读回 PROCESS_INFORMATION.decode；
 *  bInheritHandles 非 0 继承句柄）；成功 → 非 0 */
export const CreateProcess = /*@__PURE__*/ b('CreateProcessW',
    '<WCHAR>ptr <WCHAR>ptr <>ptr <>ptr i32 u32 <>ptr <WCHAR>ptr <STARTUPINFOW>ptr <PROCESS_INFORMATION>ptr -> i32',
    { STARTUPINFOW })
/** 等内核对象就绪（dwMilliseconds = 0xffffffff 无限等）；返回 WAIT_* 码 */
export const WaitForSingleObject = /*@__PURE__*/ b('WaitForSingleObject', '<>ptr u32 -> u32')
/** 取进程退出码到 lpExitCode（DWORD 出参：传 Int32Array(1).buffer 读回带符号码）；成功 → 非 0 */
export const GetExitCodeProcess = /*@__PURE__*/ b('GetExitCodeProcess', '<>ptr <BYTE>ptr -> i32')
/** 关闭内核对象句柄；成功 → 非 0 */
export const CloseHandle = /*@__PURE__*/ b('CloseHandle', '<>ptr -> i32')

// ============ 文件 I/O ============

/** 同步读文件 / 管道到 lpBuffer（lpNumberOfBytesRead 传 Uint32Array(1).buffer 读回，
 *  lpOverlapped 传 NULL）；成功 → 非 0，管道写端全部关闭后读返回 0（EOF） */
export const ReadFile = /*@__PURE__*/ b('ReadFile', '<>ptr <BYTE>ptr u32 <BYTE>ptr <>ptr -> i32')

// ============ 系统 / 错误 ============

/** 取调用线程最近一次 Win32 错误码 */
export const GetLastError = /*@__PURE__*/ b('GetLastError', ' -> u32')
/** 取 System32 目录路径（宽字符）到 lpBuffer，uSize 为缓冲 WCHAR 数；
 *  out 传 WCHAR.alloc(n).buf，读回 WCHAR.decode(buf)；返回写入的字符数（不含 NUL，0 失败） */
export const GetSystemDirectory = /*@__PURE__*/ b('GetSystemDirectoryW', '<BYTE>ptr u32 -> u32')
