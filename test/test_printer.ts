import * as ffi from 'ffi'
import * as gui from 'gui'
import * as os from 'os'
import { WCHAR } from '../lib/ffi/bind.js'
import { structArray } from '../lib/ffi/struct.js'
import { NULL, PtrArrayBuffer } from '../lib/ffi/ctype.js'
import { CloseHandle, CreateFile, DeleteFile, GetLastError, GetTempPath, GetFileSize, ReadFile } from '../lib/windows/kernel32.js'
import {
    ClosePrinter, DeviceCapabilities, EnumPrinters, EndDocPrinter, EndPagePrinter,
    GetDefaultPrinter, OpenPrinter, StartDocPrinter, StartPagePrinter, WritePrinter,
} from '../lib/windows/winspool.js'
import { PRINTER_INFO_2W } from '../lib/windows/structs.js'
import { Tester } from './test_helper.js'

// gui.PrinterEnum.LOCAL(0x2) | CONNECTIONS(0x4)：可组合 flags 组合 OR 裸传
const LOCAL_OR_CONNECTIONS = 0x6
const MAX_WCHARS = 4096

// 指针字段跟进读宽字符串 / 跨架构读指针（test_ffi.ts 同型）
function decodeWideAtPtr(ptr: number): string {
    if (!ptr) return ''
    const chars: number[] = []
    let pos = ptr
    while (chars.length < MAX_WCHARS) {
        const ch = ffi.readByte(pos) + ffi.readByte(pos + 1) * 256
        if (ch === 0) break
        chars.push(ch)
        pos += 2
    }
    return String.fromCharCode(...chars)
}
function readPtr(dv: DataView, offset: number): number {
    if (os.arch === 'ia32') return dv.getUint32(offset, true)
    return dv.getUint32(offset, true) + dv.getUint32(offset + 4, true) * 4294967296
}

export const suite = {
    name: 'printer',
    run: (t: Tester) => {
        t.section('EnumPrinters: two-pass LOCAL|CONNECTIONS')
        const neededB = new PtrArrayBuffer(4)
        const returnedB = new PtrArrayBuffer(4)
        const neededU = new Uint32Array(neededB)
        const returnedU = new Uint32Array(returnedB)
        EnumPrinters(LOCAL_OR_CONNECTIONS, NULL, 2, NULL, 0, neededB, returnedB)
        if (neededU[0]! === 0) {
            // 无打印机环境（XP VM）：整段优雅跳过——属环境差异非缺陷（test_ffi 先例）
            t.skipCase('printer suite (no printers on this VM)')
            return
        }
        t.checkTrue(`pcbNeeded > 0 (${neededU[0]!})`, neededU[0]! > 0)
        const buf = new PtrArrayBuffer(neededU[0]!)
        t.checkTrue('EnumPrinters full buffer',
            EnumPrinters(LOCAL_OR_CONNECTIONS, NULL, 2, buf, neededU[0]!, neededB, returnedB) !== 0)
        const count = returnedU[0]!
        t.checkTrue(`found printers (${count})`, count > 0)

        // 出参数组读回：结构数组区 = 前 count*size 字节，尾部是字符串数据
        // （byteLength 非 size 整数倍）→ 必须显式 count；指针字段跟进读字符串
        const infos = structArray(PRINTER_INFO_2W).decode(buf, count)
        t.check('decode count == pcReturned', count, infos.length)
        // 单值 decode 与数组 decode 首元素一致（布局单一来源互证，无硬编码 offset）
        t.checkTrue('array/single decode agree',
            PRINTER_INFO_2W.decode(buf).pPrinterName === infos[0]!.pPrinterName)
        const names: string[] = []
        const ports: Record<string, string> = {}
        for (const inf of infos) {
            const name = decodeWideAtPtr(inf.pPrinterName)
            names.push(name)
            ports[name] = decodeWideAtPtr(inf.pPortName)
        }

        t.section('GetDefaultPrinter')
        const defW = WCHAR.alloc(260)
        const lenB = new PtrArrayBuffer(4)
        new Uint32Array(lenB)[0] = 260
        t.checkTrue('GetDefaultPrinter ok', GetDefaultPrinter(defW, lenB) !== 0)
        const defName = WCHAR.decode(defW)
        t.checkTrue(`default in enum list (${defName})`, names.includes(defName))

        t.section('DeviceCapabilities: numeric caps on default printer')
        const defPort = ports[defName] ?? NULL
        const horz = DeviceCapabilities(defName, defPort, gui.DeviceCap.HORZRES, NULL, NULL)
        t.checkTrue(`HORZRES sane (${horz})`, horz > 0)
        const vert = DeviceCapabilities(defName, defPort, gui.DeviceCap.VERTRES, NULL, NULL)
        t.checkTrue(`VERTRES sane (${vert})`, vert > 0)

        t.section('raw job chain on default printer (FILE: port -> .prn file, no UI)')
        // 输出文件放系统 temp（GetTempPath 尾带反斜杠）——FILE: 端口把作业写到 pOutputFile
        const tmpW = WCHAR.alloc(260)
        GetTempPath(260, tmpW)
        const outPrn = `${WCHAR.decode(tmpW)}qw_job.prn`
        const slot = new PtrArrayBuffer(8)
        t.checkTrue('OpenPrinter ok', OpenPrinter(defName, slot, NULL) !== 0)
        const hPrinter = readPtr(new DataView(slot), 0)
        t.checkTrue(`hPrinter valid (${hPrinter})`, hPrinter !== 0)
        // pDatatype 省略（NULL）→ spooler 用打印机默认 datatype；显式传 RAW/XPS_PASS 反而
        // 可能被驱动拒——1804 = ERROR_INVALID_DATATYPE（官方错误码表；注意 StartDocPrinter
        // 不设置 last error，GetLastError 读到的常是残留值）
        const jobId = StartDocPrinter(hPrinter, 1, {
            pDocName: WCHAR.encode('QuickWin Raw Job').ptr,   // <>ptr 字段收裸地址（number 子类型）
            pOutputFile: WCHAR.encode(outPrn).ptr,
        })
        if (jobId === 0) {
            // 失败即暴露（1804 = ERROR_INVALID_DATATYPE——datatype 显式 RAW/XPS_PASS 会被
            // XPS 驱动拒，NULL 让 spooler 用默认即通；StartDocPrinter 不设置 last error，
            // 下方诊断值常是残留）
            t.checkTrue(`StartDocPrinter job id > 0 (lastError=${GetLastError()})`, false)
            ClosePrinter(hPrinter)
            return
        }
        t.checkTrue(`StartDocPrinter job id > 0`, jobId > 0)
        const sp = StartPagePrinter(hPrinter)
        t.checkTrue(`StartPagePrinter (lastError=${GetLastError()})`, sp !== 0)
        const job = 'hello printer'
        const jBuf = new PtrArrayBuffer(job.length)
        const jDv = new DataView(jBuf)
        for (let i = 0; i < job.length; i++) jDv.setUint8(i, job.charCodeAt(i))
        const pWr = new PtrArrayBuffer(4)
        const wr = WritePrinter(hPrinter, jBuf, job.length, pWr)
        t.checkTrue(`WritePrinter ok (lastError=${GetLastError()})`, wr !== 0)
        t.check('bytes written', job.length, new Uint32Array(pWr)[0])
        const ep = EndPagePrinter(hPrinter)
        t.checkTrue(`EndPagePrinter (lastError=${GetLastError()})`, ep !== 0)
        const ed = EndDocPrinter(hPrinter)
        t.checkTrue(`EndDocPrinter (lastError=${GetLastError()})`, ed !== 0)
        t.checkTrue('ClosePrinter', ClosePrinter(hPrinter) !== 0)

        // 作业落盘断言：FILE: 端口把 RAW 数据写到 pOutputFile
        const hOut = CreateFile(outPrn, 0x80000000 /* GENERIC_READ */, 0, NULL,
            gui.FileCreation.OPEN_EXISTING, 0, NULL)
        t.checkTrue(`job file exists (${outPrn})`, hOut !== -1)
        if (hOut !== -1) {
            const fSize = GetFileSize(hOut, NULL)
            t.checkTrue(`job file size > 0 (${fSize})`, fSize > 0)
            const fBuf = new PtrArrayBuffer(Math.max(fSize, 1))
            const pRd = new PtrArrayBuffer(4)
            ReadFile(hOut, fBuf, fSize, pRd, NULL)
            // RAW 通道（winprint + RAW）应原样落盘——若 XPS 驱动重渲染则 FAIL 揭示实际内容头
            let back = ''
            const fDv = new DataView(fBuf)
            for (let i = 0; i < Math.min(fSize, job.length); i++) back += String.fromCharCode(fDv.getUint8(i))
            t.check('job data roundtrip (RAW passthrough)', job, back)
            CloseHandle(hOut)
        }
        DeleteFile(outPrn)
    },
}
