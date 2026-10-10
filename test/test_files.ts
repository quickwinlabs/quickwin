import * as gui from 'gui'
import { WCHAR } from '../lib/ffi/bind.js'
import { NULL, PtrArrayBuffer } from '../lib/ffi/ctype.js'
import {
    CloseHandle, CopyFile, CreateDirectory, CreateFile, DeleteFile,
    FindClose, FindFirstFile, FindNextFile, GetFileAttributes, GetFileSize,
    GetTempPath, MoveFileEx, ReadFile, RemoveDirectory, SetFilePointer, WriteFile,
} from '../lib/windows/kernel32.js'
import { WIN32_FIND_DATAW } from '../lib/windows/structs.js'
import { Tester } from './test_helper.js'

const GENERIC_READ = 0x80000000
const GENERIC_WRITE = 0x40000000
const FILE_ATTRIBUTE_DIRECTORY = 0x10
const INVALID32 = 0xffffffff

// ASCII payload ↔ UTF-16LE 缓冲互转（REG_SZ 同型，测试内联）
function toWide(s: string): PtrArrayBuffer<string> {
    const p = new PtrArrayBuffer(s.length * 2)
    const dv = new DataView(p)
    for (let i = 0; i < s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), true)
    return p
}
function fromWide(p: PtrArrayBuffer<string>, chars: number): string {
    const dv = new DataView(p)
    let out = ''
    for (let i = 0; i < chars; i++) out += String.fromCharCode(dv.getUint16(i * 2, true))
    return out
}

export const suite = {
    name: 'files',
    run: (t: Tester) => {
        t.section('GetTempPath + CreateDirectory')
        const tmpW = WCHAR.alloc(260)
        const tmpLen = GetTempPath(260, tmpW)
        t.checkTrue(`temp path non-empty (${tmpLen})`, tmpLen > 0)
        const dir = `${WCHAR.decode(tmpW)}QuickWinTest`    // GetTempPath 尾带反斜杠
        // 目录可能残留自上次中断的 run：已存在（且是目录）则静默复用
        if (CreateDirectory(dir, NULL) === 0 &&
            (GetFileAttributes(dir) & FILE_ATTRIBUTE_DIRECTORY) === 0) {
            t.checkTrue('CreateDirectory', false)
            return
        }
        const pathA = `${dir}\\a.txt`
        const pathB = `${dir}\\b.txt`
        const pathC = `${dir}\\c.txt`
        const pathCn = `${dir}\\中文文件.txt`

        t.section('CreateFile + WriteFile: write payload')
        const hW = CreateFile(pathA, GENERIC_WRITE, 0, NULL,
            gui.FileCreation.CREATE_ALWAYS, 0x80 /* FILE_ATTRIBUTE_NORMAL */, NULL)
        t.checkTrue(`write handle valid (${hW})`, hW !== -1) // 失败 = INVALID_HANDLE_VALUE(-1)
        const payload = 'hello files'
        const wData = toWide(payload)
        const pWr = new PtrArrayBuffer(4)
        t.checkTrue('WriteFile ok', WriteFile(hW, wData, payload.length * 2, pWr, NULL) !== 0)
        t.check('bytes written', payload.length * 2, new DataView(pWr).getUint32(0, true))
        t.checkTrue('CloseHandle (writer)', CloseHandle(hW) !== 0)

        t.section('CreateFile(READ) + GetFileSize + SetFilePointer + ReadFile')
        const hR = CreateFile(pathA, GENERIC_READ, 0, NULL,
            gui.FileCreation.OPEN_EXISTING, 0x80, NULL)
        t.checkTrue(`read handle valid (${hR})`, hR !== -1)
        t.check('GetFileSize', payload.length * 2, GetFileSize(hR, NULL))
        t.check('SetFilePointer BEGIN → 0', 0, SetFilePointer(hR, 0, NULL, gui.FileSeekFrom.BEGIN))
        const rData = new PtrArrayBuffer(payload.length * 2)
        const pRd = new PtrArrayBuffer(4)
        t.checkTrue('ReadFile ok', ReadFile(hR, rData, payload.length * 2, pRd, NULL) !== 0)
        t.check('read roundtrip', payload, fromWide(rData, payload.length))
        // seek 到 END-4 验证负偏移 + 读尾 4 字节
        t.check('SetFilePointer END-4', payload.length * 2 - 4,
            SetFilePointer(hR, -4, NULL, gui.FileSeekFrom.END))
        const rTail = new PtrArrayBuffer(8)
        ReadFile(hR, rTail, 4, pRd, NULL)
        t.check('seeked tail', payload.slice(-2), fromWide(rTail, 2))
        CloseHandle(hR)

        t.section('CopyFile + MoveFileEx + GetFileAttributes')
        const hB = CreateFile(pathB, GENERIC_WRITE, 0, NULL,
            gui.FileCreation.CREATE_ALWAYS, 0x80, NULL)
        const bData = toWide('bb')
        WriteFile(hB, bData, 4, pWr, NULL)
        CloseHandle(hB)
        t.checkTrue('CopyFile ok', CopyFile(pathB, pathC, 0) !== 0)
        const hC = CreateFile(pathC, GENERIC_READ, 0, NULL,
            gui.FileCreation.OPEN_EXISTING, 0x80, NULL)
        t.check('copied size', 4, GetFileSize(hC, NULL))
        t.checkTrue('CloseHandle (copy reader)', CloseHandle(hC) !== 0)
        t.checkTrue('MoveFileEx replace ok',
            MoveFileEx(pathB, pathC, 0x1 /* MOVEFILE_REPLACE_EXISTING */) !== 0)
        t.check('moved: source gone', INVALID32, GetFileAttributes(pathB))
        t.checkTrue('dest is file (not dir)',
            (GetFileAttributes(pathC) & FILE_ATTRIBUTE_DIRECTORY) === 0)

        t.section('FindFirstFile/FindNextFile: enumerate *.txt incl. CJK name')
        const hCn = CreateFile(pathCn, GENERIC_WRITE, 0, NULL,
            gui.FileCreation.CREATE_ALWAYS, 0x80, NULL)
        CloseHandle(hCn)                                      // 0 字节中文名文件
        const fd = WIN32_FIND_DATAW.alloc()
        const hFind = FindFirstFile(`${dir}\\a.txt`, fd.ptr)
        t.checkTrue(`FindFirstFile ok (${hFind})`, hFind !== -1)
        t.check('found name', 'a.txt', WIN32_FIND_DATAW.decode(fd).cFileName)
        t.checkTrue('FindNextFile exhausted = 0', FindNextFile(hFind, fd.ptr) === 0)
        t.checkTrue('FindClose', FindClose(hFind) !== 0)
        let count = 0
        const hEnum = FindFirstFile(`${dir}\\*.txt`, fd.ptr)
        if (hEnum !== -1) {
            count = 1
            while (FindNextFile(hEnum, fd.ptr) !== 0) count++
            FindClose(hEnum)
        }
        t.check('enum *.txt count (a/c/CJK)', 3, count)

        t.section('DeleteFile + RemoveDirectory: cleanup')
        t.checkTrue('DeleteFile ×3', DeleteFile(pathA) !== 0 && DeleteFile(pathC) !== 0
            && DeleteFile(pathCn) !== 0)
        t.checkTrue('RemoveDirectory', RemoveDirectory(dir) !== 0)
        t.check('dir gone', INVALID32, GetFileAttributes(dir))
    },
}
