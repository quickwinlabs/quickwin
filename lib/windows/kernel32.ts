// kernel32.dll 绑定（进程 / 管道 / 系统信息子集；品牌约定见 lib/windows/user32.ts 头注释）：
//   - 内核对象句柄按用途分品牌：管道/文件 <HFILE>ptr、进程 <HPROCESS>ptr、线程
//     <HTHREAD>ptr、toolhelp 快照 <HSNAPSHOT>ptr（CloseHandle 收宽位直通，与 Process32/
//     Module32 专用消费位自产自收，对齐 <HFIND>ptr/FindClose 先例；CreatePipe 的 HANDLE*
//     出参槽是缓冲地址非句柄值，仍 <>ptr）；
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

/** 建匿名管道
 *  @returns 成功 → 非 0
 *  @param args_0 hReadPipe 出参槽（读端句柄写回，<>ptr 缓冲地址）
 *  @param args_1 hWritePipe 出参槽（写端句柄写回，<>ptr 缓冲地址）
 *  @param args_2 lpPipeAttributes 安全属性，传 NULL
 *  @param args_3 nSize 管道缓冲字节数，0 = 系统默认 */
export const CreatePipe = /*@__PURE__*/ b('CreatePipe', '<>ptr <>ptr <>ptr u32 -> i32')
/** 设句柄标志
 *  @returns 成功 → 非 0
 *  @param args_0 hHandle 文件/管道句柄
 *  @param args_1 dwMask 要改的标志位掩码（HANDLE_FLAG_*）
 *  @param args_2 dwFlags 标志新值（继承 = 1，不继承 = 0） */
export const SetHandleInformation = /*@__PURE__*/ b('SetHandleInformation', '<HFILE>ptr! u32 u32 -> i32')
/** 建进程
 *  @returns 成功 → 非 0
 *  @param args_0 lpApplicationName 可执行文件路径 string 或 NULL
 *  @param args_1 lpCommandLine 命令行 string（含参数）或 NULL
 *  @param args_2 lpProcessAttributes 进程安全属性，传 NULL
 *  @param args_3 lpThreadAttributes 线程安全属性，传 NULL
 *  @param args_4 bInheritHandles 非 0 继承父进程句柄
 *  @param args_5 dwCreationFlags 创建标志（CREATE_NO_WINDOW = 0x08000000 等）
 *  @param args_6 lpEnvironment 环境块，传 NULL 继承当前环境
 *  @param args_7 lpCurrentDirectory 工作目录 string 或 NULL
 *  @param args_8 lpStartupInfo STARTUPINFOW 对象（cb 必填）
 *  @param args_9 lpProcessInformation 出参槽，传 PROCESS_INFORMATION.alloc().ptr */
export const CreateProcess = /*@__PURE__*/ b('CreateProcessW',
    '<WCHAR>ptr <WCHAR>ptr <>ptr <>ptr i32 u32 <>ptr <WCHAR>ptr <STARTUPINFOW>ptr <PROCESS_INFORMATION>ptr -> i32',
    { STARTUPINFOW })
/** 等内核对象就绪
 *  @returns WAIT_* 码
 *  @param args_0 hHandle 内核对象句柄
 *  @param args_1 dwMilliseconds 超时毫秒，0xffffffff = 无限等 */
export const WaitForSingleObject = /*@__PURE__*/ b('WaitForSingleObject', '<>ptr u32 -> u32')
/** 取进程退出码（带符号读）
 *  @returns 成功 → 非 0
 *  @param args_0 hProcess 进程句柄
 *  @param args_1 lpExitCode 出参槽，传 Int32Array(1).buffer 读回退出码 */
export const GetExitCodeProcess = /*@__PURE__*/ b('GetExitCodeProcess', '<HPROCESS>ptr! <BYTE>ptr -> i32')
/** 关闭内核对象句柄
 *  @returns 成功 → 非 0
 *  @param args_0 hObject 任意内核对象 */
export const CloseHandle = /*@__PURE__*/ b('CloseHandle', '<>ptr -> i32')

// ============ 进程快照（toolhelp）============

/** 建系统快照；用完 CloseHandle（收宽位直通）
 *  @returns 成功 → 快照句柄，失败 → -1（INVALID_HANDLE_VALUE——truthy，判 < 0 非判 0，
 *  同 CreateFile）
 *  @param args_0 dwFlags 快照范围掩码：TH32CS_SNAPPROCESS(0x2) 全系统进程、
 *                TH32CS_SNAPMODULE(0x8) 指定进程的模块（跨位宽目标另加 SNAPMODULE32(0x10)；
 *                可组合不标枚举）
 *  @param args_1 th32ProcessID 目标进程 PID（SNAPPROCESS 传 0 = 忽略） */
export const CreateToolhelp32Snapshot = /*@__PURE__*/ b('CreateToolhelp32Snapshot',
    'u32 u32 -> <HSNAPSHOT>ptr!')

/** 取快照第一个进程
 *  @returns 成功 → 非 0，0 = 迭代尽/失败（ERROR_NO_MORE_FILES=18 等，见 GetLastError）
 *  @param args_0 hSnapshot 快照句柄（CreateToolhelp32Snapshot 产物，0 拦截）
 *  @param args_1 lppe 迭代缓冲：alloc() 后预写 offset0 dwSize = size（见结构 JSDoc），
 *                每轮 PROCESSENTRY32W.decode(buf) 读回，Next 复用同一 buf */
export const Process32First = /*@__PURE__*/ b('Process32FirstW',
    '<HSNAPSHOT>ptr! <PROCESSENTRY32W>ptr! -> i32')
/** 取快照下一进程（First 后循环调用）；参数同 First
 *  @returns 成功 → 非 0，0 = 迭代完毕 */
export const Process32Next = /*@__PURE__*/ b('Process32NextW',
    '<HSNAPSHOT>ptr! <PROCESSENTRY32W>ptr! -> i32')
/** 取指定进程的第一个模块（可执行 + 已加载 DLL）
 *  @returns 成功 → 非 0，0 = 迭代尽/失败
 *  @param args_0 hSnapshot 快照句柄（TH32CS_SNAPMODULE 建）
 *  @param args_1 lpme 迭代缓冲：alloc() 后预写 offset0 dwSize = size，MODULEENTRY32W.decode 读回 */
export const Module32First = /*@__PURE__*/ b('Module32FirstW',
    '<HSNAPSHOT>ptr! <MODULEENTRY32W>ptr! -> i32')
/** 取下一模块；参数同 First
 *  @returns 成功 → 非 0，0 = 迭代完毕 */
export const Module32Next = /*@__PURE__*/ b('Module32NextW',
    '<HSNAPSHOT>ptr! <MODULEENTRY32W>ptr! -> i32')

// ============ 进程控制 ============

/** 按 PID 开进程；配对 CloseHandle
 *  @returns 成功 → 句柄，失败 → NULL（0 保真）
 *  @param args_0 dwDesiredAccess 访问掩码组合：PROCESS_QUERY_INFORMATION(0x400) /
 *                PROCESS_VM_READ(0x10) 读内存与模块路径、PROCESS_TERMINATE(0x1) 杀进程
 *                （可组合不标枚举）
 *  @param args_1 bInheritHandle 句柄继承，传 0
 *  @param args_2 dwProcessId 目标 PID（不存在 → NULL） */
export const OpenProcess = /*@__PURE__*/ b('OpenProcess', 'u32 i32 u32 -> <HPROCESS>ptr')
/** 结束进程
 *  @returns 成功 → 非 0（自身/无 PROCESS_TERMINATE 权限失败）
 *  @param args_0 hProcess 进程句柄（须 PROCESS_TERMINATE 权限）
 *  @param args_1 uExitCode 退出码（GetExitCodeProcess 读回；STILL_ACTIVE=259 是系统保留值，
 *                杀进程时避开） */
export const TerminateProcess = /*@__PURE__*/ b('TerminateProcess', '<HPROCESS>ptr! u32 -> i32')
/** 取当前进程 PID（互证锚点）
 *  @returns 当前进程 PID */
export const GetCurrentProcessId = /*@__PURE__*/ b('GetCurrentProcessId', ' -> u32')

// ============ 文件 I/O ============

/** 同步读文件 / 管道
 *  @returns 成功 → 非 0，管道写端全部关闭后读返回 0（EOF）
 *  @param args_0 hFile 文件/管道句柄
 *  @param args_1 lpBuffer 接收缓冲（<BYTE>ptr，PtrArrayBuffer 原地读回）
 *  @param args_2 nNumberOfBytesToRead 请求读取的字节数
 *  @param args_3 lpNumberOfBytesRead 出参槽，传 Uint32Array(1).buffer 读实际字节数
 *  @param args_4 lpOverlapped 重叠结构，传 NULL（同步读） */
export const ReadFile = /*@__PURE__*/ b('ReadFile', '<HFILE>ptr! <BYTE>ptr u32 <BYTE>ptr <>ptr -> i32')

/** 创建/打开文件
 *  @returns 成功 → 句柄，失败 → INVALID_HANDLE_VALUE（-1——truthy，须 === -1 判失败，
 *  0 由返回位 ! 运行时检查兜底）
 *  @param args_0 lpFileName 路径 string（禁空）
 *  @param args_1 dwDesiredAccess 访问掩码：GENERIC_READ(0x80000000)|GENERIC_WRITE(0x40000000)
 *                组合（flags 位不标枚举）
 *  @param args_2 dwShareMode 共享掩码：FILE_SHARE_READ(0x1)|FILE_SHARE_WRITE(0x2)，独占传 0
 *  @param args_3 lpSecurityAttributes 安全属性，传 NULL
 *  @param args_4 dwCreationDisposition 创建处置 gui.FileCreation.*（互斥单选）
 *  @param args_5 dwFlagsAndAttributes 属性：FILE_ATTRIBUTE_NORMAL(0x80) 等（可组合不标）
 *  @param args_6 hTemplateFile 模板文件句柄，传 NULL */
export const CreateFile = /*@__PURE__*/ b('CreateFileW',
    '<WCHAR>ptr! u32 u32 <>ptr u32@FileCreation u32 <>ptr -> <HFILE>ptr!')
/** 同步写文件 / 管道
 *  @returns 成功 → 非 0（失败原因见 GetLastError）
 *  @param args_0 hFile 文件/管道句柄
 *  @param args_1 lpBuffer 数据缓冲（<BYTE>ptr，PtrArrayBuffer）
 *  @param args_2 nNumberOfBytesToWrite 写入字节数
 *  @param args_3 lpNumberOfBytesWritten 出参槽，传 PtrArrayBuffer(4) 读实际写入字节数
 *  @param args_4 lpOverlapped 重叠结构，传 NULL（同步写） */
export const WriteFile = /*@__PURE__*/ b('WriteFile', '<HFILE>ptr! <BYTE>ptr u32 <BYTE>ptr <>ptr -> i32')
/** 删除文件
 *  @returns 成功 → 非 0 */
export const DeleteFile = /*@__PURE__*/ b('DeleteFileW', '<WCHAR>ptr! -> i32')
/** 读文件属性掩码
 *  @returns 属性掩码（FILE_ATTRIBUTE_DIRECTORY=0x10 / NORMAL=0x80 / READONLY=0x1 等，
 *  可组合不标枚举）；失败 → 0xFFFFFFFF（INVALID_FILE_ATTRIBUTES） */
export const GetFileAttributes = /*@__PURE__*/ b('GetFileAttributesW', '<WCHAR>ptr! -> u32')
/** 建目录（不含中间层级——多级须逐级建）
 *  @returns 成功 → 非 0 */
export const CreateDirectory = /*@__PURE__*/ b('CreateDirectoryW', '<WCHAR>ptr! <>ptr -> i32')
/** 删空目录
 *  @returns 成功 → 非 0 */
export const RemoveDirectory = /*@__PURE__*/ b('RemoveDirectoryW', '<WCHAR>ptr! -> i32')
/** 复制文件
 *  @returns 成功 → 非 0
 *  @param args_2 bFailIfExists 非 0：目标已存在则失败 */
export const CopyFile = /*@__PURE__*/ b('CopyFileW', '<WCHAR>ptr! <WCHAR>ptr! i32 -> i32')
/** 移动/改名（可跨卷）
 *  @returns 成功 → 非 0
 *  @param args_2 dwFlags 标志组合：MOVEFILE_REPLACE_EXISTING(0x1) 覆盖目标、
 *                MOVEFILE_COPY_ALLOWED(0x2) 跨卷时允许复制删除（flags 位不标枚举） */
export const MoveFileEx = /*@__PURE__*/ b('MoveFileExW', '<WCHAR>ptr! <WCHAR>ptr! u32 -> i32')
/** 移动文件指针
 *  @returns 新偏移（32 位），0xFFFFFFFF = 失败（须 GetLastError 区分
 *  与合法的 0xFFFFFFFF 偏移）
 *  @param args_1 lDistanceToMove 偏移（LONG，可负）
 *  @param args_2 lpDistanceToMoveHigh 64 位偏移高半（出参双向），32 位够用传 NULL
 *  @param args_3 dwMoveMethod 起点 gui.FileSeekFrom.BEGIN / CURRENT / END */
export const SetFilePointer = /*@__PURE__*/ b('SetFilePointer', '<HFILE>ptr! i32 <BYTE>ptr u32@FileSeekFrom -> u32')
/** 读文件大小
 *  @returns 文件大小（低 32 位）；0xFFFFFFFF = 失败（INVALID_FILE_SIZE，须 GetLastError 区分）
 *  @param args_1 lpFileSizeHigh 高 32 位出参槽（>4GB 文件），不需要传 NULL */
export const GetFileSize = /*@__PURE__*/ b('GetFileSize', '<HFILE>ptr! <BYTE>ptr -> u32')
/** 按通配模式枚举首个匹配（'dir\\*.txt'）；配对 FindClose
 *  @returns 成功 → 查找句柄，失败 → INVALID_HANDLE_VALUE（-1）
 *  @param args_0 lpFileName 路径/通配模式 string（禁空）
 *  @param args_1 lpFindFileData 出参槽，传 WIN32_FIND_DATAW.alloc().ptr、decode 读回 */
export const FindFirstFile = /*@__PURE__*/ b('FindFirstFileW',
    '<WCHAR>ptr! <WIN32_FIND_DATAW>ptr! -> <HFIND>ptr!')
/** 枚举下一匹配
 *  @returns 成功 → 非 0，0 = ERROR_NO_MORE_FILES（枚举完毕） */
export const FindNextFile = /*@__PURE__*/ b('FindNextFileW', '<HFIND>ptr! <WIN32_FIND_DATAW>ptr! -> i32')
/** 关闭查找句柄（Find 族专用，不用 CloseHandle）
 *  @returns 成功 → 非 0 */
export const FindClose = /*@__PURE__*/ b('FindClose', '<HFIND>ptr! -> i32')
/** 取临时目录路径（尾带反斜杠）
 *  @returns 写入字符数（不含 NUL，0 失败）
 *  @param args_0 nBufferLength 缓冲容量（WCHAR 个数，含 NUL 余量）
 *  @param args_1 lpBuffer 接收缓冲，传 WCHAR.alloc(n)、WCHAR.decode 读回 */
export const GetTempPath = /*@__PURE__*/ b('GetTempPathW', 'u32 <BYTE>ptr -> u32')

// ============ 系统 / 错误 ============

/** 取调用线程最近一次 Win32 错误码
 *  @returns 最近一次失败的线程局部错误码 */
export const GetLastError = /*@__PURE__*/ b('GetLastError', ' -> u32')
/** 取 System32 目录路径（宽字符）
 *  @returns 写入的字符数（不含 NUL，0 失败）
 *  @param args_0 lpBuffer 接收缓冲，传 WCHAR.alloc(n)
 *  @param args_1 uSize 缓冲容量（WCHAR 个数，含 NUL 余量） */
export const GetSystemDirectory = /*@__PURE__*/ b('GetSystemDirectoryW', '<BYTE>ptr u32 -> u32')
/** 错误码 → 可读文字（GetLastError 的搭档）
 *  @returns 写入字符数（0 失败）
 *  @param args_0 dwFlags 组合标志：FROM_SYSTEM(0x1000) 系统错误表 | IGNORE_INSERTS(0x200)
 *                吞掉 %1 插值符（裸 u32 组合传 0x1200，可组合 flags 不标枚举）
 *  @param args_1 lpSource 消息表源（FROM_SYSTEM 时传 NULL）
 *  @param args_2 dwMessageId 错误码（如 GetLastError() 的返回）
 *  @param args_3 dwLanguageId 语言 0 = 中性（按系统 UI）
 *  @param args_4 lpBuffer 接收缓冲，传 WCHAR.alloc(n)
 *  @param args_5 nSize 缓冲容量（WCHAR 个数）
 *  @param args_6 Arguments 插值参数表，IGNORE_INSERTS 时传 NULL */
export const FormatMessage = /*@__PURE__*/ b('FormatMessageW',
    'u32 <>ptr u32 u32 <BYTE>ptr u32 <>ptr -> u32')

// ============ 计时 / 系统信息 ============

/** 高精度计数器读数（LARGE_INTEGER，8 字节）
 *  @returns 成功 → 非 0
 *  @param args_0 lpPerformanceCount 出参缓冲，PtrArrayBuffer(8) + DataView getBigInt64 读回 */
export const QueryPerformanceCounter = /*@__PURE__*/ b('QueryPerformanceCounter', '<BYTE>ptr -> i32')
/** 高精度计数器频率（每秒计数，LARGE_INTEGER 8 字节）
 *  @returns 成功 → 非 0
 *  @param args_0 lpFrequency 出参缓冲，PtrArrayBuffer(8) + DataView getBigInt64 读回 */
export const QueryPerformanceFrequency = /*@__PURE__*/ b('QueryPerformanceFrequency', '<BYTE>ptr -> i32')
/** 挂起当前线程毫秒数（0 = 让出剩余时间片）；无返回值 */
export const Sleep = /*@__PURE__*/ b('Sleep', 'u32 -> void')
/** 当前系统时间（UTC FILETIME，8 字节 = 1601 起的 100ns 单元）；无返回值
 *  @param args_0 lpSystemTimeAsFileTime 出参缓冲，PtrArrayBuffer(8) + DataView getBigUint64 读回 */
export const GetSystemTimeAsFileTime = /*@__PURE__*/ b('GetSystemTimeAsFileTime', '<BYTE>ptr -> void')
/** 本地时间（SYSTEMTIME 出参位不注册 encoder：SYSTEMTIME.alloc().ptr 进、decode 读回）；
 *  无返回值
 *  @param args_0 lpSystemTime 出参结构缓冲 */
export const GetLocalTime = /*@__PURE__*/ b('GetLocalTime', '<SYSTEMTIME>ptr -> void')
/** 取环境变量值
 *  @returns 读取字符数（不含 NUL，0 = 不存在或缓冲不足）
 *  @param args_0 lpName 变量名（禁空，如 'PATH'）
 *  @param args_1 lpBuffer 接收缓冲，传 WCHAR.alloc(n)
 *  @param args_2 nSize 缓冲容量（WCHAR 个数，含 NUL 余量） */
export const GetEnvironmentVariable = /*@__PURE__*/ b('GetEnvironmentVariableW',
    '<WCHAR>ptr! <BYTE>ptr u32 -> u32')
/** 计算机名（*lpnSize 入 = 缓冲 WCHAR 容量，出 = 实际长度不含 NUL）
 *  @returns 成功 → 非 0
 *  @param args_0 lpBuffer 接收缓冲，传 WCHAR.alloc(n)
 *  @param args_1 lpnSize 长度槽（PtrArrayBuffer(4)，Uint32Array 写入容量） */
export const GetComputerName = /*@__PURE__*/ b('GetComputerNameW', '<BYTE>ptr <BYTE>ptr -> i32')
/** 模块文件路径（全路径含扩展名）
 *  @returns 写入字符数（不含 NUL，0 失败/缓冲不足）
 *  @param args_0 hModule 模块句柄（<HMODULE>ptr 与 win 模块同型），NULL = 当前进程 exe
 *  @param args_1 lpFilename 接收缓冲，传 WCHAR.alloc(n)
 *  @param args_2 nSize 缓冲容量（WCHAR 个数） */
export const GetModuleFileName = /*@__PURE__*/ b('GetModuleFileNameW', '<HMODULE>ptr <BYTE>ptr u32 -> u32')
/** 进程命令行（含程序名；进程启动即有值，永不返回 NULL）
 *  @returns 命令行整串（返回位 `<WCHAR>ptr!`：内建 WCHAR codec 自动解码为 string，
 *    `!` 担保非 NULL 由返回位 0 检查兜底，无需接收缓冲） */
export const GetCommandLineW = /*@__PURE__*/ b('GetCommandLineW', ' -> <WCHAR>ptr!')

// ============ 全局内存（剪贴板数据载体）============

/** 分配全局内存块
 *  @returns 成功 → 句柄（0 失败）
 *  @param args_0 uFlags GMEM_MOVEABLE(0x2) 可移动（剪贴板要求）等 GMEM_* 组合
 *  @param args_1 dwBytes 字节数（SIZE_T 随位宽 = <>ptr 的 ptr 宽，非指针语义） */
export const GlobalAlloc = /*@__PURE__*/ b('GlobalAlloc', 'u32 <>ptr -> <HGLOBAL>ptr')
/** 句柄 → 内存地址（配 GlobalAlloc 使用，与 SetClipboardData 的自产自收配对）
 *  @returns 内存地址（0 失败/已锁定）——地址非句柄，返回位保持裸 <>ptr */
export const GlobalLock = /*@__PURE__*/ b('GlobalLock', '<HGLOBAL>ptr -> <>ptr')
/** 解锁（GlobalLock 每次获取须配对一次）
 *  @returns 锁定计数归 0 → 非 0 */
export const GlobalUnlock = /*@__PURE__*/ b('GlobalUnlock', '<HGLOBAL>ptr -> i32')
/** 释放全局内存（SetClipboardData 成功后所有权转系统，勿再释放）
 *  @returns 成功 → NULL */
export const GlobalFree = /*@__PURE__*/ b('GlobalFree', '<HGLOBAL>ptr -> <>ptr')
/** 拷贝内存块（dst = 目标进程地址，src = 数据缓冲）；无返回值。ffi 只有 readByte，
 *  写远程内存的唯一通道（GlobalLock 后灌数据、自定义窗口类 WNDCLASSEX 的 lpszClassName
 *  等场景同用）
 *  @param args_0 dst 目标地址（GlobalLock 返回值等裸地址）
 *  @param args_1 src 源数据缓冲（<BYTE>ptr 收 PAB 本体）
 *  @param args_2 n 字节数（src.byteLength） */
export const RtlMoveMemory = /*@__PURE__*/ b('RtlMoveMemory', '<>ptr <BYTE>ptr u32 -> void')
