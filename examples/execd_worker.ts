import * as os from 'os'
import * as std from 'std'
import { WCHAR } from '../lib/ffi/bind.js'
import { NULL, PtrArrayBuffer } from '../lib/ffi/ctype.js'
import { struct } from '../lib/ffi/struct.js'
import {
    CloseHandle, CreatePipe, CreateProcess, GetExitCodeProcess, GetLastError, GetSystemDirectory,
    ReadFile, SetHandleInformation, WaitForSingleObject,
} from '../lib/windows/kernel32.js'
import { PROCESS_INFORMATION, STARTUPINFOW } from '../lib/windows/structs.js'

// worker 没有可观测的输出通道：绑定失败会静默中断 worker 脚本，主线程永远等不到消息。
// 失败原因落盘 diag.log 以便定位（典型：DLL 位数与进程不匹配 -> ERROR_BAD_EXE_FORMAT 193）。
const diagFile = (stage: string): void => {
    try {
        const f = std.open('diag.log', 'a')
        if (f) { f.puts(`${Date.now()} ${stage}\n`); f.close() }
    } catch (ex) { /* best effort */ }
}

const HANDLE_FLAG_INHERIT = 0x1
const STARTF_USESTDHANDLES = 0x100
const WAIT_INFINITE = 0xffffffff
// STARTUPINFOW / PROCESS_INFORMATION 的布局随进程位宽（x86 68B / x64 104B），由 struct 按 os.arch 推。
// os.arch 是编译期的进程指针宽度（src/quickjs-libc.c OS_ARCH），WOW64 下的 32 位进程得 ia32 布局——
// 本地 win7 VM 上的 execd 就是 32 位进程跑在 64 位系统上。

const parent = os.Worker.parent

// GetSystemDirectoryW 拼 cmd.exe 全路径。
// 探针实测（XP/Win7 均如此）：CreateProcessW 的 lpCommandLine 第一个 token 若是
// 裸 "cmd.exe"，PATH 解析在本环境失败（err 267 ERROR_DIRECTORY / 123 ERROR_INVALID_NAME），
// 用全路径即正常。cmd 内部再解析 ping/dir 等用自己的 PATH，无此问题。
let sysDir = 'C:\\Windows\\System32'
try {
    const out = WCHAR.alloc(256)
    const n = GetSystemDirectory(out, 256)
    const s = n > 0 ? WCHAR.decode(out) : ''
    if (s) sysDir = s
} catch (ex) {
    diagFile('SYS-DIR-FAIL: ' + String(ex))
}

// 用 CreateProcessW + CreatePipe 直接捕获子进程 stdout（替代 winpty）。
// 纯捕获场景（/exec 从不交互），管道方案比 winpty 少一层 agent 中转：
//   - 流式粒度更好：探针实测 XP 上逐行实时到达（winpty 攒批 ~4s）
//   - 无 winpty.dll / winpty-agent.exe 依赖，纯 kernel32
// 编码：无统一代码页转换——cmd 内置经 /u 恒为 UTF-16LE，外部程序各自原生
// （qwin= UTF-8、中文系统工具= GBK），客户端按来源分别解码。
// 同步阻塞读循环（worker 线程自转），主线程事件循环不受影响。
// CreatePipe 的两个 HANDLE 出参槽：一个结构两个指针字段，读回走 decode
// CreatePipe 成功后两端句柄必非零（失败已在下方 throw）——字段标 '!'，decode 直出 Ptr
const PIPE_HANDLES = /* @__PURE__ */ struct('PIPE_HANDLES', { hRead: '<HFILE>ptr!', hWrite: '<HFILE>ptr!' })

function runCmd(id: number, cmd: string): number {
    // —— 管道 + 继承设置（读端不可继承，否则 EOF 永不触发）——
    const pipe = PIPE_HANDLES.alloc()
    if (!CreatePipe(pipe.ptr, pipe.ptr + PIPE_HANDLES.offsetOf('hWrite'), NULL, 0)) {
        throw new Error('CreatePipe err=' + GetLastError())
    }
    const { hRead, hWrite } = PIPE_HANDLES.decode(pipe)
    SetHandleInformation(hWrite, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)
    SetHandleInformation(hRead, HANDLE_FLAG_INHERIT, 0)

    // —— STARTUPINFO（写端作为子进程 stdout/stderr）——
    const pi = PROCESS_INFORMATION.alloc()
    // 恒加 /u：cmd 内置输出（echo/dir/type 与 cmd 自身报错）直接写 UTF-16LE，绕开「按代码页
    // 编码成字节」这一步（Tiny11 缺 NLS 时中文变 ?；win7/XP 的 GBK 无损只是 ACP=936 的 locale 巧合）。
    // /u 在所有 Win 版本行为一致，故不分版本——早期用 RtlGetVersion 判 NT>=10 只对 win11 加 /u，已删。
    // 外部程序（qwin/ping 等）输出仍为各自原生编码，/u 不参与（实测 ping 仍透传 GBK）。见 .agents/CMD_ENCODING_ACP_NLS.md §8。
    const cmdline = `${sysDir}\\cmd.exe /u /c ${cmd}`
    if (!CreateProcess(NULL, cmdline, NULL, NULL, 1, 0, NULL, NULL,
        { cb: STARTUPINFOW.size, dwFlags: STARTF_USESTDHANDLES, hStdOutput: hWrite, hStdError: hWrite }, pi.ptr)) {
        CloseHandle(hRead)
        CloseHandle(hWrite)
        throw new Error('CreateProcessW err=' + GetLastError() + ' cmd=' + cmdline)
    }
    const { hProcess, hThread, dwProcessId } = PROCESS_INFORMATION.decode(pi)
    CloseHandle(hThread)
    CloseHandle(hWrite)
    parent.postMessage({ type: 'info', id, pid: dwProcessId })

    // —— 同步阻塞读循环（子进程树全退出、写端全关 -> EOF -> 收尾）——
    const bufB = new PtrArrayBuffer(4096)
    const buf = new Uint8Array(bufB)
    const nReadB = new PtrArrayBuffer(4)
    const nRead = new Uint32Array(nReadB)
    for (;;) {
        nRead[0] = 0
        if (!ReadFile(hRead, bufB, 4096, nReadB, NULL)) break
        const n = nRead[0]!
        if (n === 0) break
        parent.postMessage({ type: 'data', id, chunk: buf.slice(0, n) })
    }

    WaitForSingleObject(hProcess, WAIT_INFINITE)
    const ecB = new PtrArrayBuffer(4)
    const ec = new Int32Array(ecB)
    GetExitCodeProcess(hProcess, ecB)
    const code = ec[0]!
    CloseHandle(hRead)
    CloseHandle(hProcess)
    return code
}

parent.onmessage = (e) => {
    // worker 只剩 /exec 一个租客：外部命令不可控，必须与主进程隔离（长阻塞无上界）。
    // 内置端点（截屏/窗口列表/改分辨率）全部在主进程同步跑——bug 当场 throw → 500，
    // 而不是在 worker 里静默挂掉等 timer 兜底成 504。
    const msg = e.data as { type: string; id: number; cmd?: string }
    if (msg.type === 'run' && typeof msg.cmd === 'string') {
        let code = -1
        let error: string | null = null
        try {
            code = runCmd(msg.id, msg.cmd)
        } catch (ex) {
            error = String(ex)
        }
        parent.postMessage({ type: 'result', id: msg.id, code, error })
    }
    // 父侧每个请求起一个新 worker，一次只处理一个请求，处理完立刻释放自己的 port：
    // port_list 清空后 js_os_poll 返回 -1（src/quickjs-libc.c:2506）→ 本线程退出，
    // JSRuntime 随之释放。不设 null 的话线程常驻（实测 win7 30 次请求线程 4→35）。
    // 注意父侧 `worker.onmessage = null` 只释放父侧 port，对本线程无效——必须在这里设。
    // 消息已在 js_post_message_pipe 进队列，父侧读的是同一份 refcount 共享管道，线程退出不影响。
    parent.onmessage = null
}
