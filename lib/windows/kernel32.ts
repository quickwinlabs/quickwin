// kernel32.dll 绑定（进程 / 管道 / 系统信息子集；品牌约定见 lib/windows/user32.ts 头注释）：
//   - 内核对象句柄按用途分品牌：管道/文件 <HFILE>ptr、进程 <HPROCESS>ptr、线程
//     <HTHREAD>ptr（CreatePipe 的 HANDLE* 出参槽是缓冲地址非句柄值，仍 <>ptr）；
//     CloseHandle/WaitForSingleObject 全家族位保持 <>ptr 收宽（品牌 number 子类型可
//     直传），异种对象深层互传由运行时句柄有效性判定兜底
//   - 结构位按方向分流（结构定义见 ./structs.ts，布局随进程位宽，struct 按 os.arch 推）：
//       STARTUPINFOW 纯入参位注册 encoder → DeepPartial 对象直传；
//       PROCESS_INFORMATION 出参位不注册 → 只收 def 分配的 .ptr，读回走 decode
//   - 缓冲区 / DWORD 出参位用 <BYTE>ptr 直接收 PtrArrayBuffer（DataView / TypedArray 原地读回）
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
 *  lpPipeAttributes 传 NULL；nSize 传 0 用默认缓冲；成功 → 非 0
 *  @param args_0 hReadPipe 出参槽（读端句柄写回，<>ptr 缓冲地址）
 *  @param args_1 hWritePipe 出参槽（写端句柄写回，<>ptr 缓冲地址）
 *  @param args_2 lpPipeAttributes 安全属性，传 NULL
 *  @param args_3 nSize 管道缓冲字节数，0 = 系统默认 */
export const CreatePipe = /*@__PURE__*/ b('CreatePipe', '<>ptr <>ptr <>ptr u32 -> i32')
/** 设句柄标志（dwMask / dwFlags 如 HANDLE_FLAG_INHERIT = 1）；成功 → 非 0
 *  @param args_0 hHandle 文件/管道句柄（HFILE 品牌）
 *  @param args_1 dwMask 要改的标志位掩码（HANDLE_FLAG_*）
 *  @param args_2 dwFlags 标志新值（继承 = 1，不继承 = 0） */
export const SetHandleInformation = /*@__PURE__*/ b('SetHandleInformation', '<HFILE>ptr u32 u32 -> i32')
/** 建进程（lpApplicationName / lpCommandLine 为 string 或 NULL；lpStartupInfo 传对象
 *  { cb: STARTUPINFOW.size, dwFlags, hStd* … }（cb 必填），lpProcessInformation 传
 *  PROCESS_INFORMATION.encode().ptr、读回 PROCESS_INFORMATION.decode；
 *  bInheritHandles 非 0 继承句柄）；成功 → 非 0
 *  @param args_0 lpApplicationName 可执行文件路径 string 或 NULL
 *  @param args_1 lpCommandLine 命令行 string（含参数）或 NULL
 *  @param args_2 lpProcessAttributes 进程安全属性，传 NULL
 *  @param args_3 lpThreadAttributes 线程安全属性，传 NULL
 *  @param args_4 bInheritHandles 非 0 继承父进程句柄
 *  @param args_5 dwCreationFlags 创建标志（CREATE_NO_WINDOW = 0x08000000 等）
 *  @param args_6 lpEnvironment 环境块，传 NULL 继承当前环境
 *  @param args_7 lpCurrentDirectory 工作目录 string 或 NULL
 *  @param args_8 lpStartupInfo STARTUPINFOW 对象（cb 必填）
 *  @param args_9 lpProcessInformation 出参槽，传 PROCESS_INFORMATION.encode().ptr */
export const CreateProcess = /*@__PURE__*/ b('CreateProcessW',
    '<WCHAR>ptr <WCHAR>ptr <>ptr <>ptr i32 u32 <>ptr <WCHAR>ptr <STARTUPINFOW>ptr <PROCESS_INFORMATION>ptr -> i32',
    { STARTUPINFOW })
/** 等内核对象就绪（dwMilliseconds = 0xffffffff 无限等）；返回 WAIT_* 码
 *  @param args_0 hHandle 要等的内核对象句柄（<>ptr 收宽）
 *  @param args_1 dwMilliseconds 超时毫秒，0xffffffff = 无限等 */
export const WaitForSingleObject = /*@__PURE__*/ b('WaitForSingleObject', '<>ptr u32 -> u32')
/** 取进程退出码到 lpExitCode（DWORD 出参：传 Int32Array(1).buffer 读回带符号码）；成功 → 非 0
 *  @param args_0 hProcess 进程句柄（HPROCESS 品牌）
 *  @param args_1 lpExitCode 出参槽，传 Int32Array(1).buffer 读回退出码 */
export const GetExitCodeProcess = /*@__PURE__*/ b('GetExitCodeProcess', '<HPROCESS>ptr <BYTE>ptr -> i32')
/** 关闭内核对象句柄；成功 → 非 0
 *  @param args_0 hObject 要关闭的句柄（任意内核对象，<>ptr 收宽） */
export const CloseHandle = /*@__PURE__*/ b('CloseHandle', '<>ptr -> i32')

// ============ 文件 I/O ============

/** 同步读文件 / 管道到 lpBuffer（lpNumberOfBytesRead 传 Uint32Array(1).buffer 读回，
 *  lpOverlapped 传 NULL）；成功 → 非 0，管道写端全部关闭后读返回 0（EOF）
 *  @param args_0 hFile 文件/管道句柄（HFILE 品牌）
 *  @param args_1 lpBuffer 接收缓冲（<BYTE>ptr，PtrArrayBuffer 原地读回）
 *  @param args_2 nNumberOfBytesToRead 请求读取的字节数
 *  @param args_3 lpNumberOfBytesRead 出参槽，传 Uint32Array(1).buffer 读实际字节数
 *  @param args_4 lpOverlapped 重叠结构，传 NULL（同步读） */
export const ReadFile = /*@__PURE__*/ b('ReadFile', '<HFILE>ptr <BYTE>ptr u32 <BYTE>ptr <>ptr -> i32')

// ============ 系统 / 错误 ============

/** 取调用线程最近一次 Win32 错误码 */
export const GetLastError = /*@__PURE__*/ b('GetLastError', ' -> u32')
/** 取 System32 目录路径（宽字符）到 lpBuffer，uSize 为缓冲 WCHAR 数；
 *  out 传 WCHAR.alloc(n)，读回 WCHAR.decode(buf)；返回写入的字符数（不含 NUL，0 失败）
 *  @param args_0 lpBuffer 接收缓冲，传 WCHAR.alloc(n)
 *  @param args_1 uSize 缓冲容量（WCHAR 个数，含 NUL 余量） */
export const GetSystemDirectory = /*@__PURE__*/ b('GetSystemDirectoryW', '<BYTE>ptr u32 -> u32')
