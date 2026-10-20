import * as std from 'std'
import * as ffi from 'ffi'
import { Tester } from './test_helper.js'
import { bindAt, closure } from '../lib/ffi/bind.js'
import { NULL, PTR_SIZE, PtrArrayBuffer } from '../lib/ffi/ctype.js'
import { SUCCEEDED, guidFields } from '../lib/com.js'
import { CoCreateGuid, CoInitializeEx, CoTaskMemAlloc, CoTaskMemFree, CoUninitialize } from '../lib/windows/ole32.js'
import { GUID, IID } from '../lib/windows/structs.js'
import { CoInitFlag, Guid, HResult } from '../constants'

// 按架构位宽写一个指针（测试用；库侧读用 ffi.readPtr，写用 ffi.writeByte）
function setPtrSlot(buf: ArrayBuffer, off: number, v: number): void {
    const dv = new DataView(buf)
    if (PTR_SIZE === 8) dv.setBigUint64(off, BigInt(v), true)
    else dv.setUint32(off, v, true)
}

export const suite = {
    name: 'com',
    run: (t: Tester) => {
        t.section('GUID 布局（对照 C 的 struct _GUID）')
        t.check('GUID.size = sizeof(GUID) = 16', 16, GUID.size)
        t.check('IID.size == GUID.size（同布局不同品牌）', GUID.size, IID.size)
        t.check('GUID.offsetOf(Data4) = 8', 8, GUID.offsetOf('Data4'))
        // IID_IShellLinkW = {000214F9-0000-0000-C000-000000000046}：Data1/2/3 按主机序（小端）落内存，
        // Data4 逐字节原样。第 4 组的 C000 属于 Data4 的前两字节，不是 Data3——GUID 唯一容易搞错的点。
        // 字面量必须内联：提成 const 后 Data4 会推成 number[]，过不了 encode 的 8 元组类型。
        const sl = IID.encode({ Data1: 0x000214f9, Data2: 0x0000, Data3: 0x0000, Data4: [0xc0, 0, 0, 0, 0, 0, 0, 0x46] })
        // 字符串 → 字段形（guidFields 的契约）：解码回字段后逐字段比，覆盖全部 16 字节
        t.check('guidFields(Guid.IID_ISHELLLINKW) == 手写 C 字段',
            JSON.stringify(IID.decode(sl)), JSON.stringify(guidFields(Guid.IID_ISHELLLINKW)))
        const dv = new DataView(sl)
        t.check('Data1 little-endian in memory (byte 0)', 0xf9, dv.getUint8(0))
        t.check('Data1 byte 3', 0x00, dv.getUint8(3))
        t.check('Data4[0] = 0xC0 at offset 8（第 4 组不是 Data3）', 0xc0, dv.getUint8(8))
        t.check('Data4[7] at offset 15', 0x46, dv.getUint8(15))
        t.check('IID encode → decode round trip', 0x000214f9, IID.decode(sl).Data1)

        t.section('CoInitializeEx / CoUninitialize')
        // 前序 suite 可能已通过别的 API 隐式初始化本线程（ole32 的 STA 自动初始化），
        // 故首调只断言成功态；只在我们自己初始化时才做配对反初始化。
        const hr0 = CoInitializeEx(NULL, CoInitFlag.APARTMENTTHREADED)
        std.printf('  CoInitializeEx(APARTMENTTHREADED) = 0x%08x\n', hr0 >>> 0)
        t.check('CoInitFlag.APARTMENTTHREADED = 0x2', 2, CoInitFlag.APARTMENTTHREADED)
        t.checkTrue('first init: SUCCEEDED(hr)', SUCCEEDED(hr0))
        t.check('second init (same apartment) reports S_FALSE', HResult.S_FALSE,
            CoInitializeEx(NULL, CoInitFlag.APARTMENTTHREADED))
        if (SUCCEEDED(hr0)) {
            CoUninitialize()
            // ole32 的线程初始化计数不保证 CoUninitialize 后清零（teardown 不完整时线程仍是已初始化态），
            // 故只断言成功态，不断言具体码。
            t.checkTrue('re-init after CoUninitialize: SUCCEEDED',
                SUCCEEDED(CoInitializeEx(NULL, CoInitFlag.APARTMENTTHREADED)))
            CoUninitialize()
            CoUninitialize()
            t.checkTrue('double CoUninitialize does not crash', true)
        } else {
            t.skipCase('re-init after CoUninitialize (thread was already COM-initialized)')
        }

        t.section('CoInitFlag.MULTITHREADED')
        // MULTITHREADED = 0 不是漏值：dwCoInit 全 0 即按 MTA 初始化（MTA 是默认态）。
        // 先确保线程是 STA（已初始化则返 S_FALSE，仍为 STA），再要 MTA → 公寓类型冲突。
        t.check('CoInitFlag.MULTITHREADED = 0', 0, CoInitFlag.MULTITHREADED)
        CoInitializeEx(NULL, CoInitFlag.APARTMENTTHREADED)
        t.check('STA 线程上要 MTA → RPC_E_CHANGED_MODE', HResult.RPC_E_CHANGED_MODE,
            CoInitializeEx(NULL, CoInitFlag.MULTITHREADED))

        t.section('CoTaskMemAlloc / CoTaskMemFree')
        const p = CoTaskMemAlloc(64)
        t.checkTrue('CoTaskMemAlloc(64) is non-null', p !== NULL)
        if (p !== NULL) {
            // 不校验零初始化：CoTaskMemAlloc 不清内存（Vista+ 才有 CoTaskMemAllocAndInit），
            // 内容取决于堆块是否被复用——不是契约。
            ffi.writeByte(p, 0xab)
            t.check('byte write/read through CoTask memory', 0xab, ffi.readByte(p))
            CoTaskMemFree(p)
            CoTaskMemFree(NULL)   // 0 安全
        }

        t.section('CoCreateGuid')
        const g1 = GUID.alloc()
        const g2 = GUID.alloc()
        t.check('CoCreateGuid first', HResult.S_OK, CoCreateGuid(g1.ptr))
        t.check('CoCreateGuid second', HResult.S_OK, CoCreateGuid(g2.ptr))
        // <GUID>ptr! 位注册了 GUID encoder：对象形不必先 encode/alloc——mkPtrWriter 对非 number
        // 实参调 codec.encode() 取 .ptr。结果写进那块临时缓冲，无副作用，只为验证这条路通。
        t.check('CoCreateGuid 收 guidFields 对象形', HResult.S_OK,
            CoCreateGuid(guidFields(Guid.IID_IPERSISTFILE)))
        const d1 = GUID.decode(g1)
        const d2 = GUID.decode(g2)
        t.checkTrue('two GUIDs differ', JSON.stringify(d1) !== JSON.stringify(d2))
        t.checkTrue('GUID bytes are not all zero', d1.Data1 !== 0 || d1.Data2 !== 0 || d1.Data3 !== 0)

        t.section('bindAt + readPtr 的 vtable 派发')
        // COM 方法 = stdcall（closure 默认 stdcall）；对象指针指向存放 vtable 地址的单元，
        // 与真对象的内存形一致——槽 2 是 IUnknown::Release 的位置。
        const rel = closure('<>ptr -> u32', (_self) => 7)
        const vt = new PtrArrayBuffer(PTR_SIZE * 3)
        setPtrSlot(vt, 2 * PTR_SIZE, rel.ptr)
        const objBuf = new PtrArrayBuffer(PTR_SIZE)
        setPtrSlot(objBuf, 0, ffi.bufferPtr(vt))
        const obj = ffi.bufferPtr(objBuf)
        const call = bindAt(ffi.readPtr(ffi.readPtr(obj) + 2 * PTR_SIZE), '<>ptr -> u32')
        t.check('dispatch through the vtable slot', 7, call(obj))
        t.check('unwritten vtable slots are 0', 0, ffi.readPtr(ffi.readPtr(obj)))
        rel.dispose()
    },
}
