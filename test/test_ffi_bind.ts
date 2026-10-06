import * as std from 'std'
import * as gui from 'gui'
import * as ffi from 'ffi'
import * as os from 'os'
import { Tester } from './test_helper.js'
import { bind, bindLib, closure, WCHAR, BYTE, type CodecMap } from '../lib/ffi/bind.js'
import { struct } from '../lib/ffi/struct.js'
import { NULL, type MaybePtr, Ptr, readScalar, writeScalar, PTR_SIZE } from '../lib/ffi/ctype.js'

// 编译期断言工具（仅类型层，运行时无开销）
type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false
function expectType<T extends true>(_value?: T): void {}
// 从签名串推导参数元组 / 返回类型（纯类型层，不执行 bind）
type ParamsOf<S extends string> = Parameters<ReturnType<typeof bind<S, {}>>>
type RetOf<S extends string> = ReturnType<ReturnType<typeof bind<S, {}>>>

// 与 callPacked 相同的槽宽布局，供「ffiCall 直驱 closure」打包
function packArgs(kinds: string[], vals: (number | bigint)[]): ArrayBuffer {
    const is64 = os.arch === 'x64'
    const SZ: Record<string, number> = is64
        ? { u8: 8, i8: 8, u16: 8, i16: 8, u32: 8, i32: 8, u64: 8, i64: 8, f32: 8, f64: 8, ptr: 8 }
        : { u8: 4, i8: 4, u16: 4, i16: 4, u32: 4, i32: 4, u64: 8, i64: 8, f32: 4, f64: 8, ptr: 4 }
    const size = kinds.reduce((s, k) => s + SZ[k]!, 0)
    const b = new ArrayBuffer(size)
    const dv = new DataView(b)
    let off = 0
    for (let i = 0; i < kinds.length; i++) {
        const k = kinds[i]!
        const v = vals[i]!
        switch (k) {
            case 'f64': dv.setFloat64(off, Number(v), true); break
            case 'f32': dv.setFloat32(off, Number(v), true); break
            case 'u64': dv.setBigUint64(off, v as bigint, true); break
            case 'i64': dv.setBigInt64(off, v as bigint, true); break
            case 'ptr':
                if (is64) dv.setBigUint64(off, BigInt(Number(v)), true)
                else dv.setUint32(off, Number(v) >>> 0, true)
                break
            default: dv.setUint32(off, Number(v) >>> 0, true); break
        }
        off += SZ[k]!
    }
    return b
}

// ASCII 字符串 ↔ ArrayBuffer（供 msvcrt _strtoui64/_i64toa 类函数用）
function strToBuf(s: string): ArrayBuffer {
    const b = new ArrayBuffer(s.length + 1)
    const u8 = new Uint8Array(b)
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i)
    return b
}

function bufToString(buf: ArrayBuffer): string {
    const u8 = new Uint8Array(buf)
    let s = ''
    for (let i = 0; i < u8.length && u8[i] !== 0; i++) s += String.fromCharCode(u8[i]!)
    return s
}

// 读取 native 指针指向的 C 字符串（\0 结尾）；空指针（0）→ 空串
function readCStr(p: number): string {
    if (!p) return ''
    let s = ''
    for (let i = 0; ; i++) {
        const b = ffi.readByte(p + i)
        if (b === 0) break
        s += String.fromCharCode(b)
    }
    return s
}

export const suite = {
    name: 'ffi-bind',
    run: (t: Tester) => {
        t.section('bind single proc')
        const getDC = bind('user32.dll', 'GetDC', '<>ptr -> <>ptr')
        const dc = getDC(0)
        t.checkTrue('bind GetDC(NULL) returns screen DC', !!dc)

        t.section('bindLib batch with <WCHAR>ptr auto-encode')
        const user32 = bindLib('user32.dll', {
            DrawTextW: '<>ptr <WCHAR>ptr i32 <BYTE>ptr i32 -> i32',
            ReleaseDC: '<>ptr <>ptr -> i32',
        })
        const rect = new ArrayBuffer(16)
        const dv = new DataView(rect)
        dv.setInt32(8, 500, true)
        const lines = user32.DrawTextW(dc, 'hello ffi-bind', -1, rect, gui.DrawTextFlag.CALCRECT)
        t.checkTrue('DrawTextW returns line count > 0', lines > 0)
        t.checkTrue('measured width > 0', dv.getInt32(8, true) > 0)
        t.checkTrue('measured height > 0', dv.getInt32(12, true) > 0)
        if (dc) user32.ReleaseDC(0, dc)

        t.section('signedness read-back: i32 vs u32')
        const lstrcmpI = bind('kernel32.dll', 'lstrcmpW', '<WCHAR>ptr <WCHAR>ptr -> i32')
        const lstrcmpU = bind('kernel32.dll', 'lstrcmpW', '<WCHAR>ptr <WCHAR>ptr -> u32')
        const setLastError = bind('kernel32.dll', 'SetLastError', 'u32 -> void')
        const getErrU = bind('kernel32.dll', 'GetLastError', ' -> u32')
        const getErrI = bind('kernel32.dll', 'GetLastError', ' -> i32')
        const ri = lstrcmpI('a', 'b')
        const ru = lstrcmpU('a', 'b')
        std.printf('  lstrcmpW("a","b"): i32=%s u32=%s\n', String(ri), String(ru))
        t.checkTrue('i32 read-back keeps negative sign', ri < 0)
        t.check('u32 read-back is 0xFFFFFFFF', 4294967295, ru)
        setLastError(0x80000000)
        const glU = getErrU()
        const glI = getErrI()
        std.printf('  GetLastError after SetLastError(0x80000000): u32=%s i32=%s\n', String(glU), String(glI))
        t.check('GetLastError u32 keeps big value', 2147483648, glU)
        t.check('GetLastError i32 reads as negative', -2147483648, glI)

        t.section('f32/f64 floating args (ffi_types[] table regression)')
        // ffi_types[] 曾把 FLOAT/DOUBLE 槽各错位一位（DOUBLE 槽指向 ffi_type_float），
        // float/double 被按 4 字节处理。f64 用 msvcrt!sqrt/atan2（三平台必有）。
        const sqrtF64 = bind('msvcrt.dll', 'sqrt', 'f64 -> f64')
        const atan2F64 = bind('msvcrt.dll', 'atan2', 'f64 f64 -> f64')
        const sq2 = sqrtF64(2.0)
        std.printf('  sqrt(2.0) = %s (expect 1.4142135623730951)\n', String(sq2))
        t.checkTrue('sqrt(2.0) close to 1.4142135623730951', Math.abs(sq2 - 1.4142135623730951) < 1e-12)
        const pa = atan2F64(1.0, 1.0)
        std.printf('  atan2(1,1) = %s (expect ~0.7853981634)\n', String(pa))
        t.checkTrue('atan2(1,1) close to PI/4', Math.abs(pa - Math.PI / 4) < 1e-12)
        // f32: gdi32!AngleArc 的 eStartAngle/eSweepAngle 是 REAL(float32)。
        // 若 FLOAT 槽仍为 NULL，ffi_prep_cif 会返回 FFI_BAD_ARGTYPE → 抛 TypeError。
        const getDCF = bind('user32.dll', 'GetDC', '<>ptr -> <>ptr')
        const angleArc = bind('gdi32.dll', 'AngleArc', '<>ptr i32 i32 u32 f32 f32 -> i32')
        const releaseDCF = bind('user32.dll', 'ReleaseDC', '<>ptr <>ptr -> i32')
        const hdcF = getDCF(0)
        // ptr 读回 0 保真（number）：hdcF 为 0 表示无 DC，跳过——
        // AngleArc(NULL,…) 必然返回 FALSE，不值得断言。
        if (hdcF) {
            const ok = angleArc(hdcF, 20, 20, 5, 0.0, 90.0)
            std.printf('  AngleArc(0~90) on screen DC = %s (expect 1)\n', String(ok))
            t.checkTrue('AngleArc with f32 angles succeeds', ok === 1)
            releaseDCF(0, hdcF)
        }

        t.section('kind strictness: <>ptr / <BYTE>ptr / <WCHAR>ptr')
        const setRectB = bind('user32.dll', 'SetRect', '<BYTE>ptr i32 i32 i32 i32 -> i32')
        const rb = new ArrayBuffer(16)
        const okR = setRectB(rb, 1, 2, 3, 4)
        t.checkTrue('<BYTE>ptr accepts ArrayBuffer', okR !== 0)
        const rbv = new DataView(rb)
        t.check('<BYTE>ptr writes through (left)', 1, rbv.getInt32(0, true))
        t.check('<BYTE>ptr writes through (bottom)', 4, rbv.getInt32(12, true))

        let errPtr = ''
        try {
            (getDC as unknown as (v: unknown) => number)(rb)
        } catch (e) {
            errPtr = String(e)
        }
        t.checkTrue('<>ptr rejects ArrayBuffer, hint mentions <BYTE>ptr', errPtr.includes('<BYTE>ptr'))

        // 编译期：token → 参数/返回类型。锁住「裸 ptr / 拼错 token 静默漏成 number」的回归。
        // 根因：`never extends X` 恒真，故 ArgToken/RetToken 必须在原始 token 上把关、
        // 且裸 'ptr' 需要显式 never 分支（删掉那行 'ptr' 就会漏成 number）。
        expectType<Equal<ParamsOf<'ptr <BYTE>ptr -> i32'>[0], never>>()
        expectType<Equal<ParamsOf<'i3z <BYTE>ptr -> i32'>[0], never>>()
        expectType<Equal<ParamsOf<'void <BYTE>ptr -> i32'>[0], never>>()
        // '<>ptr' 空品牌 → MaybePtr<''>（= NULL|number）：与 number 双向可赋值（identity 不作要求）。
        expectType<Equal<ParamsOf<'<>ptr -> i32'>[0], MaybePtr<''>>>()
        expectType<[ParamsOf<'<>ptr -> i32'>[0]] extends [number] ? true : false>()
        expectType<[number] extends [ParamsOf<'<>ptr -> i32'>[0]] ? true : false>()
        expectType<Equal<ParamsOf<'int -> i32'>[0], number>>()
        expectType<Equal<ParamsOf<'DWORD -> i32'>[0], number>>()
        expectType<Equal<ParamsOf<'u64 -> i32'>[0], bigint>>()
        expectType<Equal<ParamsOf<'<BYTE>ptr -> i32'>[0], ArrayBuffer | MaybePtr<"BYTE">>>()
        expectType<Equal<ParamsOf<'LPCWSTR -> i32'>[0], string | MaybePtr<"WCHAR">>>()
        expectType<Equal<RetOf<'<>ptr -> ptr'>, never>>()
        expectType<Equal<RetOf<'<>ptr -> i3z'>, never>>()
        expectType<Equal<RetOf<'<>ptr -> <BYTE>ptr'>, MaybePtr<"BYTE">>>()
        expectType<Equal<RetOf<'<>ptr -> void'>, void>>()
        expectType<Equal<RetOf<'<>ptr -> i32'>, number>>()
        expectType<Equal<RetOf<'<>ptr -> <RECT>ptr'>, MaybePtr<'RECT'>>>()

        t.section('bigint 64-bit kinds: u64 / i64')
        // 用 msvcrt 的 64 位字符串转换：win11(x64) kernel32 不导出 Interlocked*64
        //（编译器 intrinsic），msvcrt.dll 三平台必有。
        const strtoui64 = bind('msvcrt.dll', '_strtoui64', '<BYTE>ptr <BYTE>ptr i32 -> u64')
        const u64Max = strtoui64(strToBuf('18446744073709551615'), NULL, 10)
        t.check('u64 return 2^64-1', 18446744073709551615n, u64Max)
        const u64Prec = strtoui64(strToBuf('9007199254740993'), NULL, 10)
        t.check('u64 return 2^53+1', 9007199254740993n, u64Prec)

        const i64toa = bind('msvcrt.dll', '_i64toa', 'i64 <BYTE>ptr i32 -> <>ptr')
        const outI = new ArrayBuffer(64)
        i64toa(-9223372036854775808n, outI, 10)
        t.check('i64 arg -2^63 toa', '-9223372036854775808', bufToString(outI))
        i64toa(9007199254740993n, outI, 10)
        t.check('i64 arg 2^53+1 toa', '9007199254740993', bufToString(outI))

        const ui64toa = bind('msvcrt.dll', '_ui64toa', 'u64 <BYTE>ptr i32 -> <>ptr')
        const outU = new ArrayBuffer(64)
        ui64toa(18446744073709551615n, outU, 10)
        t.check('u64 arg 2^64-1 toa', '18446744073709551615', bufToString(outU))

        let errBig = ''
        try {
            (i64toa as unknown as (v: unknown, b: unknown, rad: unknown) => unknown)(123, outI, 10)
        } catch (e) {
            errBig = String(e)
        }
        t.checkTrue('i64 rejects number', errBig.includes('bigint'))

        t.section('struct layout <NAME>ptr (explicit layouts; param encode + branded ptr return)')
        // 内建 <BYTE>ptr/<WCHAR>ptr 无需 layouts；用户 struct 由 ffi-struct 的
        // struct() 定义、显式传入（import 谁传谁，未用布局可被 tree-shake）。
        const LOGBRUSH = struct({
            lbStyle: 'u32',
            lbColor: 'u32',
            lbHatch: '<>ptr',
        })
        const deleteObject = bind('gdi32.dll', 'DeleteObject', '<>ptr -> i32')
        const createBrushIndirect = bind('gdi32.dll', 'CreateBrushIndirect', '<LOGBRUSH>ptr -> <>ptr', { LOGBRUSH })
        const brush = createBrushIndirect({ lbStyle: 0, lbColor: 0x00ff0000, lbHatch: 0 })
        t.checkTrue('CreateBrushIndirect(<LOGBRUSH>ptr) returns HBRUSH', !!brush)
        if (brush) t.checkTrue('DeleteObject(HBRUSH) succeeds', deleteObject(brush) !== 0)

        // bindLib 用户布局 encoder 直传 struct 对象（bindLib 的 L 泛型曾未接线：
        // encoders?: EncoderMap 使 L 恒为 {}，<LOGBRUSH>ptr 实参被类型层收窄成裸 number（丢失布局形））
        const gdi32Lib = bindLib('gdi32.dll', {
            CreateBrushIndirect: '<LOGBRUSH>ptr -> <>ptr',
            DeleteObject: '<>ptr -> i32',
        }, { LOGBRUSH })
        const brushL = gdi32Lib.CreateBrushIndirect({ lbStyle: 0, lbColor: 0x0000ff00, lbHatch: 0 })
        t.checkTrue('bindLib(<LOGBRUSH>ptr w/ encoder) returns HBRUSH', !!brushL)
        if (brushL) t.checkTrue('bindLib DeleteObject succeeds', gdi32Lib.DeleteObject(brushL) !== 0)

        // 嵌套 struct（LOGPEN 内含 POINT）验证 ShapeOf 递归 + 子结构写入
        const POINT = struct({
            x: 'i32',
            y: 'i32',
        })
        const LOGPEN = struct({
            lopnStyle: 'u32',
            lopnWidth: POINT.__struct,
            lopnColor: 'u32',
        })
        const createPenIndirect = bind('gdi32.dll', 'CreatePenIndirect', '<LOGPEN>ptr -> <>ptr', { LOGPEN })
        const pen = createPenIndirect({ lopnStyle: 0, lopnWidth: { x: 1, y: 1 }, lopnColor: 0x000000ff })
        t.checkTrue('CreatePenIndirect(<LOGPEN>ptr nested) returns HPEN', !!pen)
        if (pen) t.checkTrue('DeleteObject(HPEN) succeeds', deleteObject(pen) !== 0)

        // C typedef LPCWSTR 归一化到 '<WCHAR>ptr'
        const lstrcmpAlias = bind('kernel32.dll', 'lstrcmpW', 'LPCWSTR LPCWSTR -> i32')
        const rAlias = lstrcmpAlias('a', 'b')
        t.checkTrue('LPCWSTR alias normalizes to <WCHAR>ptr', rAlias < 0)

        // 未知布局：延迟解析 —— bind 期不再抛；仅当真的收到「结构形」实参时才报错，
        // 并列出内建 + 已传入的可选项。纯 number（NULL / 地址）透传不需要布局。
        const deleteObjectLazy = bind('gdi32.dll', 'DeleteObject', '<NOPE>ptr -> i32')
        t.checkTrue('unknown layout <NOPE>ptr bound lazily (no bind-time throw)', typeof deleteObjectLazy === 'function')
        t.checkTrue('<NOPE>ptr accepts NULL without layout (passthrough)', deleteObjectLazy(NULL) === 0)
        let errLayout = ''
        const nopeBrush = bind('gdi32.dll', 'CreateBrushIndirect', '<NOPE>ptr -> <>ptr') as unknown as (v: unknown) => number
        try {
            nopeBrush({})
        } catch (e) {
            errLayout = String(e)
        }
        t.checkTrue('unknown layout <NOPE>ptr rejected on struct-shape call', errLayout.includes('unknown layout') && errLayout.includes('BYTE'))

        // out 参数：命名 struct 的 encode() 新建零 buffer 返回 PtrArrayBuffer，.ptr 即 Ptr<'RECT'> 直接喂
        // <RECT>ptr；读回走 RECT.decode(buf)（双态入参的 ArrayBuffer 分支）。
        const RECT = struct('RECT', {
            left: 'i32',
            top: 'i32',
            right: 'i32',
            bottom: 'i32',
        })
        const getWindowRect = bind('user32.dll', 'GetWindowRect', '<>ptr <RECT>ptr -> i32', { RECT })
        const getDesktopWindow = bind('user32.dll', 'GetDesktopWindow', ' -> <>ptr')
        const desktop = getDesktopWindow()
        const rectOut = RECT.encode()
        t.checkTrue('GetWindowRect(hwnd, RECT.encode().ptr) succeeds', getWindowRect(desktop, rectOut.ptr) !== 0)
        const rectV = RECT.decode(rectOut)
        t.checkTrue('RECT.decode(encode()) decodes out-param', rectV.right > rectV.left && rectV.bottom > rectV.top)

        // 成员 '<RECT>ptr'：decode 得到 Ptr<'RECT'>，可直接喂 <RECT>ptr 形参（品牌在类型层流动）。
        const RECTPTR = struct({r: '<RECT>ptr'})
        const box = RECTPTR.decode(RECTPTR.encode({ r: rectOut.ptr }))
        t.checkTrue('GetWindowRect(hwnd, member RECT*) succeeds', box.r !== 0 && getWindowRect(desktop, box.r) !== 0)
        const rectThroughMember = RECT.decode(rectOut)
        t.checkTrue('writes through the member pointer', rectThroughMember.right > rectThroughMember.left && rectThroughMember.bottom > rectThroughMember.top)

        t.section('struct ptr return + branded passthrough')
        // 返回位 <NAME>ptr → MaybePtr<NAME>（NULL|Ptr，0 保真，只读指针，品牌在类型层）。
        // 该品牌指针可直接喂给另一函数的 <NAME>ptr 形参（裸地址透传，不重编码）。
        // 链条：localtime(&t) 返回 struct tm* → asctime(tm*) 消费之。
        const TM = struct({
            tm_sec: 'i32',
            tm_min: 'i32',
            tm_hour: 'i32',
            tm_mday: 'i32',
            tm_mon: 'i32',
            tm_year: 'i32',
            tm_wday: 'i32',
            tm_yday: 'i32',
            tm_isdst: 'i32',
        })
        const localtime = bind('msvcrt.dll', 'localtime', '<BYTE>ptr -> <TM>ptr')
        const asctime = bind('msvcrt.dll', 'asctime', '<TM>ptr -> <>ptr', { TM })
        const tbuf = new ArrayBuffer(8)   // time_t=0（32/64 位 time_t 都读起始字节）
        const tm = localtime(tbuf)
        t.checkTrue('localtime -> <TM>ptr returns branded pointer', tm !== 0)
        const asc = tm !== 0 ? readCStr(asctime(tm)) : ''
        std.printf('  asctime(localtime(0)) = %s', asc.replace(/\n$/, ''))
        t.checkTrue('asctime(<TM>ptr) accepts branded pointer (passthrough)', asc.includes(':') && asc.length >= 20)

        // 手动解 native 拥有的 <TM>ptr：def.decode 双态入参的指针分支（0 守卫在调用方）
        const tmDecoded = tm !== 0 ? TM.decode(tm) : null
        t.checkTrue('TM.decode(<TM>ptr) decodes native-owned struct', tmDecoded !== null && tmDecoded.tm_sec === 0)

        // 编译期：裸 number 不是 Ptr<'TM'>，被类型层拒绝（此处永不执行）
        if (false) {
            // @ts-expect-error plain number is not assignable to Ptr<'TM'>
            asctime(123)
        }

        // Codec：decoders 显式传表 → 返回位自动解码为结构对象（替代 Ptr，空指针 0 保真）
        const localtimeDec = bind('msvcrt.dll', 'localtime', '<BYTE>ptr -> <TM>ptr', undefined, { TM })
        const tmObj = localtimeDec(tbuf)
        t.checkTrue('localtime + decoders auto-decodes to struct object',
            tmObj !== 0 && typeof tmObj.tm_sec === 'number')
        // 类型层证明：解码结果非 0 分支上 tm_sec 字段可访问且为 number
        // （返回若含 Ptr<'TM'> 分支——无 decode 的旧行为——此访问编译不过）
        if (tmObj !== 0) expectType<Equal<typeof tmObj.tm_sec, number>>(true)

        // Codec：返回位类型断言（decoders 显式 / 缺省回退 encoders）
        // 断言「替换语义」两半：解码结果 = 结构对象 | 0（Ptr 品牌被替换掉）；
        // 无 decode 保留 0 | Ptr 品牌形态。
        type RetOfDec<S extends string, D extends CodecMap> = ReturnType<ReturnType<typeof bind<S, {}, D>>>
        type RetDecTM = RetOfDec<' -> <TM>ptr', { TM: typeof TM }>
        type RetEncTM = ReturnType<ReturnType<typeof bind<' -> <TM>ptr', { TM: typeof TM }>>>
        expectType<Equal<Extract<RetDecTM, Ptr<'TM'>>, never>>(true)
        expectType<Equal<Extract<RetDecTM, { tm_sec: number }> extends never ? false : true, true>>(true)
        expectType<Equal<Extract<RetEncTM, Ptr<'TM'>>, never>>(true)
        expectType<Equal<Extract<RetEncTM, { tm_sec: number }> extends never ? false : true, true>>(true)

        // 内建 WCHAR codec：无条件进两张表 → <WCHAR>ptr 返回直接 string（空 0 保真）
        type RetW = ReturnType<ReturnType<typeof bind<' -> <WCHAR>ptr'>>>
        expectType<Equal<RetW, string | NULL>>(true)
        const getCommandLineW = bind('kernel32.dll', 'GetCommandLineW', ' -> <WCHAR>ptr')
        const cl = getCommandLineW()
        t.checkTrue('GetCommandLineW auto-decodes builtin <WCHAR>ptr to string',
            typeof cl === 'string' && cl.length > 0)

        // WCHAR alloc/decode 往返：{ buf, ptr } 预分配 + 手填 UTF-16LE + 双态读回
        const walloc = WCHAR.alloc(8)
        const wdv = new DataView(walloc.buf)
        wdv.setUint16(0, 'h'.charCodeAt(0), true)
        wdv.setUint16(2, 'i'.charCodeAt(0), true)
        wdv.setUint16(4, 0, true)
        t.check('WCHAR.alloc(8).buf = 16 bytes', 16, walloc.buf.byteLength)
        t.check('WCHAR.decode(ptr) roundtrip', 'hi', WCHAR.decode(walloc.ptr))
        t.check('WCHAR.decode(ArrayBuffer) roundtrip', 'hi', WCHAR.decode(walloc.buf))
        t.check('BYTE.alloc(12).buf = 12 bytes', 12, BYTE.alloc(12).buf.byteLength)

        // out-only codec（只声明 decode）走入参位 → 编码期 fail-fast（不触 native 调用）
        const asctimeOutOnly = bind('msvcrt.dll', 'asctime', '<TM>ptr -> <>ptr',
            { TM: { decode: (p: number) => p } })
        let outOnlyErr = ''
        try {
            asctimeOutOnly({} as never)   // 类型层 Ptr|null；运行时喂对象进 encoder 分支
        } catch (e) {
            outOnlyErr = String(e)
        }
        t.checkTrue('out-only codec rejected at encode time', outOnlyErr.includes('no encoder'))

        t.section('closures: direct ABI drive via ffiCall')
        const addClos = closure('i32 i32 -> i32', (a, b) => a + b)
        const r1 = new ArrayBuffer(8)
        ffi.ffiCall(addClos.ptr, packArgs(['i32', 'i32'], [5, 7]), r1, 0)
        t.check('closure i32+i32 = 12', 12, new DataView(r1).getInt32(0, true))
        addClos.dispose()

        const ptrClos = closure('<>ptr i32 -> i32', (p, n) => p + n)
        const r2 = new ArrayBuffer(8)
        ffi.ffiCall(ptrClos.ptr, packArgs(['ptr', 'i32'], [0x1234, 100]), r2, 0)
        t.check('closure ptr+i32 decode', 0x1234 + 100, new DataView(r2).getInt32(0, true))
        ptrClos.dispose()

        const f64Clos = closure('f64 f64 -> f64', (a, b) => a * b)
        const r3 = new ArrayBuffer(8)
        ffi.ffiCall(f64Clos.ptr, packArgs(['f64', 'f64'], [2.5, 4]), r3, 1)
        t.check('closure f64 mul = 10', 10, new DataView(r3).getFloat64(0, true))
        f64Clos.dispose()

        const bigClos = closure('i64 u64 -> i32', (a, b) =>
            (a === 9007199254740993n && b === 18446744073709551615n) ? 1 : 0)
        const r4 = new ArrayBuffer(8)
        ffi.ffiCall(bigClos.ptr, packArgs(['i64', 'u64'], [9007199254740993n, 18446744073709551615n]), r4, 0)
        t.check('closure bigint args exact (2^53+1 / 2^64-1)', 1, new DataView(r4).getInt32(0, true))
        bigClos.dispose()

        // 64 位整数返回：ia32 走 EDX:EAX、x64 走 RAX。低/高 32 位都能被断言到，
        // 因为 ffiCall 的整数路径（quickjs-ffi-call-ia32.S .Lint_ret）把两半都写进 out。
        const u64Clos = closure('i32 -> u64', (n) => (n === 42) ? 0x0000000700000001n : 0n)
        const r5 = new ArrayBuffer(8)
        ffi.ffiCall(u64Clos.ptr, packArgs(['i32'], [42]), r5, 0)
        t.check('closure u64 return exact (hi=7 lo=1)', 0x0000000700000001n,
            new DataView(r5).getBigUint64(0, true))
        u64Clos.dispose()

        const i64Clos = closure('i32 -> i64', (n) => (n === 1) ? -0x7FFFFFFFFFFFFFFFn : 0n)
        const r6 = new ArrayBuffer(8)
        ffi.ffiCall(i64Clos.ptr, packArgs(['i32'], [1]), r6, 0)
        t.check('closure i64 return exact (-2^63+1)', -0x7FFFFFFFFFFFFFFFn,
            new DataView(r6).getBigInt64(0, true))
        i64Clos.dispose()

        t.section('closure arg capture limit（C 捕获窗 fail-fast + 边界 roundtrip）')
        {
            // 边界内：16 参（x64=4 寄存器+12 栈槽；ia32=16×4B=64B 恰好）创建并往返
            const sig16 = Array(16).fill('u32').join(' ') + ' -> void'
            let got: unknown[] = []
            let c16: { ptr: number; dispose(): void } | null = null
            try {
                c16 = closure(sig16 as any, ((...a: unknown[]) => { got = a }) as any)
            } catch { /* 失败落到下面的 check */ }
            t.checkTrue('16×u32 创建成功', c16 !== null)
            if (c16) {
                const vals = Array.from({ length: 16 }, (_, i) => i + 1)
                ffi.ffiCall(c16.ptr, packArgs(Array(16).fill('u32'), vals), new ArrayBuffer(8), 0)
                t.check('16 参完整送达', 16, got.length)
                t.check('第 16 参（栈尾槽）值正确', 16, got[15])
                c16.dispose()
            }

            // 超限：17×u32 → x64 17>16、ia32 68>64，双架构创建期同抛
            const sig17 = Array(17).fill('u32').join(' ') + ' -> void'
            let err17 = ''
            try {
                closure(sig17 as any, (() => { }) as any)
            } catch (e) { err17 = String(e) }
            t.checkTrue('17×u32 创建期抛错（fail-fast 而非静默垃圾）', err17.includes('capture window'))
        }

        t.section('closures: EnumWindows (stdcall, end-to-end)')
        const enumWindows = bind('user32.dll', 'EnumWindows', '<>ptr <>ptr -> i32')
        let wcount = 0
        let wLp: number | null = null
        const enumClos = closure('<>ptr <>ptr -> i32', (_hwnd, lParam) => { wcount++; wLp = lParam; return 1 })
        const eok = enumWindows(enumClos.ptr, 0x5A5A)
        t.checkTrue('EnumWindows succeeds', eok !== 0)
        t.checkTrue('EnumWindows callback fired', wcount > 0)
        t.check('EnumWindows lParam passthrough', 0x5A5A, wLp)
        enumClos.dispose()

        t.section('closures: qsort (cdecl, msvcrt)')
        const qsort = bind('msvcrt.dll', 'qsort', '<BYTE>ptr <>ptr <>ptr <>ptr -> void')
        const arr = new Uint32Array([5, 3, 8, 1])
        const readI32 = (p: number): number =>
            (ffi.readByte(p) | (ffi.readByte(p + 1) << 8) | (ffi.readByte(p + 2) << 16) | (ffi.readByte(p + 3) << 24))
        const cmp = closure('<>ptr <>ptr -> i32', (a, b) => readI32(a as number) - readI32(b as number), { stdcall: false })
        qsort(arr.buffer, 4, 4, cmp.ptr)
        t.check('qsort [0]', 1, arr[0])
        t.check('qsort [1]', 3, arr[1])
        t.check('qsort [2]', 5, arr[2])
        t.check('qsort [3]', 8, arr[3])
        cmp.dispose()

        t.section('ptr 位有符号读写（对齐 C 版 JS_NewInt64）')
        const pdv = new DataView(new ArrayBuffer(8))
        writeScalar(pdv, 0, { k: 'ptr', v: -1 })
        if (PTR_SIZE === 8) t.check('-1 写入位模式（x64 二补位）', 18446744073709551615n, pdv.getBigUint64(0, true))
        else t.check('-1 写入位模式（ia32 二补位）', 0xFFFFFFFF, pdv.getUint32(0, true))
        t.check('负值往返 write(-1) → read = -1', -1, readScalar(pdv, 0, 'ptr'))
        writeScalar(pdv, 0, { k: 'ptr', v: 0 })
        t.check('0 保真（原 0 归一为 null）', 0, readScalar(pdv, 0, 'ptr'))
        writeScalar(pdv, 0, { k: 'ptr', v: 0x7FFFFFFF })
        t.check('正哨兵往返', 0x7FFFFFFF, readScalar(pdv, 0, 'ptr'))
    },
}
