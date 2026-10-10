import { WCHAR } from '../lib/ffi/bind.js'
import { NULL, PtrArrayBuffer, type Ptr } from '../lib/ffi/ctype.js'
import {
    CloseHandle, CreateProcess, CreateToolhelp32Snapshot, GetCurrentProcessId,
    GetExitCodeProcess, GetLastError, GetModuleFileName, GetSystemDirectory,
    Module32First, Module32Next, OpenProcess, Process32First, Process32Next, Sleep,
    TerminateProcess, WaitForSingleObject,
} from '../lib/windows/kernel32.js'
import { EnumProcesses, GetModuleFileNameEx, GetProcessMemoryInfo } from '../lib/windows/psapi.js'
import {
    MODULEENTRY32W, PROCESSENTRY32W, PROCESS_INFORMATION,
    PROCESS_MEMORY_COUNTERS, STARTUPINFOW,
} from '../lib/windows/structs.js'
import { Tester } from './test_helper.js'

// STILL_ACTIVE：GetExitCodeProcess 对存活进程的保留返回值（杀进程退出码避开 259）
const STILL_ACTIVE = 259

export const suite = {
    name: 'proc',
    run: (t: Tester) => {
        const selfPid = GetCurrentProcessId()
        t.checkTrue(`GetCurrentProcessId > 0 (${selfPid})`, selfPid > 0)

        // PID 数组扫描（每次刷新：EnumProcesses 出参 needed 字节 /4 = PID 数）
        const pidBuf = new PtrArrayBuffer(4096)              // 1024 个 PID 槽
        const needed = new PtrArrayBuffer(4)
        const listPids = (): Set<number> => {
            const out = new Set<number>()
            if (!EnumProcesses(pidBuf, 4096, needed)) return out
            const n = new Uint32Array(needed)[0]! >>> 2      // 字节 /4 = 条数
            const arr = new Uint32Array(pidBuf)
            for (let i = 0; i < n; i++) out.add(arr[i]!)
            return out
        }

        t.section('EnumProcesses: pid array contains self')
        t.checkTrue('EnumProcesses', EnumProcesses(pidBuf, 4096, needed) !== 0)
        const nPid = new Uint32Array(needed)[0]! >>> 2
        t.checkTrue(`pid count sane (${nPid})`, nPid > 0)
        t.checkTrue('self pid present', listPids().has(selfPid))

        t.section('toolhelp Process32 walk: self entry + exe name')
        const snapP = CreateToolhelp32Snapshot(0x2 /* TH32CS_SNAPPROCESS */, 0)
        t.checkTrue(`snapshot handle (${snapP})`, snapP > 0)
        const pe = PROCESSENTRY32W.alloc()
        new Uint32Array(pe)[0] = PROCESSENTRY32W.size        // 预写 dwSize（MSDN 要求）
        let nProc = 0
        let selfName = ''
        let parentOfSelf = -1
        let selfThreads = -1
        if (Process32First(snapP, pe.ptr)) {
            do {
                const e = PROCESSENTRY32W.decode(pe)
                nProc++
                if (e.th32ProcessID === selfPid) {
                    selfName = e.szExeFile
                    parentOfSelf = e.th32ParentProcessID
                    selfThreads = e.cntThreads
                }
            } while (Process32Next(snapP, pe.ptr))
        }
        const firstRd = PROCESSENTRY32W.decode(pe)
        CloseHandle(snapP)
        t.checkTrue(`process entries (${nProc}) >= 3`, nProc >= 3)
        t.checkTrue('self found in walk', selfName.length > 0)
        t.check('dwSize readback stays size', PROCESSENTRY32W.size, firstRd.dwSize)
        t.checkTrue(`parent pid sane (${parentOfSelf})`, parentOfSelf > 0)
        t.checkTrue(`cntThreads sane (${selfThreads})`, selfThreads >= 1)
        // exe 名与 GetModuleFileName(NULL) 的 basename 互证（批 8 同源锚点）
        const exeW = WCHAR.alloc(520)
        GetModuleFileName(NULL, exeW, 520)
        const exePath = WCHAR.decode(exeW)
        const exeBase = exePath.slice(exePath.lastIndexOf('\\') + 1).toLowerCase()
        t.check('szExeFile === basename(GetModuleFileName)', exeBase, selfName.toLowerCase())

        t.section('OpenProcess + GetProcessMemoryInfo')
        const hSelf = OpenProcess(0x400 /* QUERY_INFORMATION */ | 0x10 /* VM_READ */, 0, selfPid)
        t.checkTrue(`OpenProcess(self) (${hSelf})`, hSelf !== NULL)
        // 上行已判定非 NULL；断言进 ! 消费位（真 NULL → bind 运行时 throw 兜底）
        const hQ = hSelf as Ptr<'HPROCESS'>
        const pmc = PROCESS_MEMORY_COUNTERS.alloc()
        new Uint32Array(pmc)[0] = PROCESS_MEMORY_COUNTERS.size // 预写 cb
        t.checkTrue('GetProcessMemoryInfo',
            GetProcessMemoryInfo(hQ, pmc.ptr, PROCESS_MEMORY_COUNTERS.size) !== 0)
        const mem = PROCESS_MEMORY_COUNTERS.decode(pmc)
        t.check('cb readback stays size', PROCESS_MEMORY_COUNTERS.size, mem.cb)
        t.checkTrue(`WorkingSetSize > 0 (${mem.WorkingSetSize})`, mem.WorkingSetSize > 0)
        t.checkTrue(`PeakWorkingSet >= WorkingSet (${mem.PeakWorkingSetSize})`,
            mem.PeakWorkingSetSize >= mem.WorkingSetSize)
        t.checkTrue(`PagefileUsage > 0 (${mem.PagefileUsage})`, mem.PagefileUsage > 0)
        t.checkTrue(`PageFaultCount >= 0 (${mem.PageFaultCount})`, mem.PageFaultCount >= 0)
        const codeB = new PtrArrayBuffer(4)
        t.checkTrue('GetExitCodeProcess(self)', GetExitCodeProcess(hQ, codeB) !== 0)
        t.check('self is STILL_ACTIVE', STILL_ACTIVE, new Int32Array(codeB)[0])
        CloseHandle(hSelf)
        t.checkTrue('OpenProcess(nonexistent pid) -> NULL',
            OpenProcess(0x400, 0, 0xfffffffe) === NULL)

        t.section('toolhelp Module32 walk + GetModuleFileNameEx')
        const snapM = CreateToolhelp32Snapshot(0x8 /* TH32CS_SNAPMODULE */, selfPid)
        t.checkTrue(`module snapshot (${snapM})`, snapM > 0)
        const me = MODULEENTRY32W.alloc()
        new Uint32Array(me)[0] = MODULEENTRY32W.size          // 预写 dwSize
        let modCount = 0
        let k32Base = 0
        let hasK32 = false
        if (Module32First(snapM, me.ptr)) {
            do {
                const m = MODULEENTRY32W.decode(me)
                modCount++
                if (m.szModule.toLowerCase() === 'kernel32.dll') {
                    hasK32 = true
                    k32Base = m.modBaseAddr
                }
            } while (Module32Next(snapM, me.ptr))
        }
        CloseHandle(snapM)
        t.checkTrue(`module count (${modCount}) > 0`, modCount > 0)
        t.checkTrue('kernel32.dll in module walk + base sane', hasK32 && k32Base > 0x10000)
        // psapi 主模块路径 === kernel32 GetModuleFileName(NULL)（同进程同源互证）
        const hSelf2 = OpenProcess(0x400 | 0x10, 0, selfPid)
        t.checkTrue(`OpenProcess(self) second (${hSelf2})`, hSelf2 !== NULL)
        const exW = WCHAR.alloc(520)
        const exLen = GetModuleFileNameEx(hSelf2 as Ptr<'HPROCESS'>, NULL, exW, 520)
        CloseHandle(hSelf2)
        t.checkTrue(`GetModuleFileNameEx len (${exLen})`, exLen > 0)
        t.check('exe path psapi === kernel32',
            exePath.toLowerCase(), WCHAR.decode(exW).toLowerCase())

        t.section('CreateProcess -> pid visible -> TerminateProcess')
        const sysW = WCHAR.alloc(300)
        GetSystemDirectory(sysW, 300)                          // 尾不带反斜杠
        // 首 token 全路径（worker 探针：裸名 PATH 解析在本环境失败 err 267/123）
        const cmdline = `${WCHAR.decode(sysW)}\\ping.exe -n 60 127.0.0.1`
        const pi = PROCESS_INFORMATION.alloc()
        const created = CreateProcess(NULL, cmdline, NULL, NULL, 0,
            0x08000000 /* CREATE_NO_WINDOW */, NULL, NULL,
            { cb: STARTUPINFOW.size }, pi.ptr)
        t.checkTrue(`CreateProcess(ping) ${created ? '' : `err=${GetLastError()}`}`, created !== 0)
        if (created) {
            const { hProcess, hThread, dwProcessId, dwThreadId } = PROCESS_INFORMATION.decode(pi)
            t.checkTrue(`child pid (${dwProcessId}) valid`,
                dwProcessId > 0 && dwProcessId !== selfPid)
            t.checkTrue(`child tid sane (${dwThreadId})`, dwThreadId > 0)
            t.checkTrue('child pid in EnumProcesses', listPids().has(dwProcessId))
            const codeB2 = new PtrArrayBuffer(4)
            GetExitCodeProcess(hProcess, codeB2)
            t.check('child alive (STILL_ACTIVE)', STILL_ACTIVE, new Int32Array(codeB2)[0])
            // XP 怪癖：进程初始化未完成时 TerminateProcess，exit code 不保留读回 0
            // （win7 立即杀读 42 正常；探针实测 XP 立即杀=0、等 3s 后杀=42）——先等初始化
            Sleep(1000)
            t.checkTrue('TerminateProcess', TerminateProcess(hProcess, 42) !== 0)
            const waited = WaitForSingleObject(hProcess, 5000)
            t.checkTrue(`child exited (wait=${waited})`, waited === 0 /* WAIT_OBJECT_0 */)
            GetExitCodeProcess(hProcess, codeB2)
            t.check('child exit code 42', 42, new Int32Array(codeB2)[0])
            t.checkTrue('child pid gone', !listPids().has(dwProcessId))
            CloseHandle(hProcess)
            CloseHandle(hThread)
        }
    },
}
