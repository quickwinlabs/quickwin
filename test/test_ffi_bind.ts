import * as std from 'std'
import * as gui from 'gui'
import * as ffi from 'ffi'
import * as os from 'os'
import { Tester } from './test_helper.js'
import { bind, bindLib, closure, WCHAR, BYTE, type CodecMap } from '../lib/ffi/bind.js'
import { struct } from '../lib/ffi/struct.js'
import { NULL, type MaybePtr, Ptr, PtrArrayBuffer, readScalar, writeScalar, PTR_SIZE, normToken } from '../lib/ffi/ctype.js'

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
function strToBuf(s: string): PtrArrayBuffer<string> {
    const b = new PtrArrayBuffer(s.length + 1)
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
        const rect = new PtrArrayBuffer(16)
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
        const rb = new PtrArrayBuffer(16)
        const okR = setRectB(rb, 1, 2, 3, 4)
        t.checkTrue('<BYTE>ptr accepts PtrArrayBuffer', okR !== 0)
        const rbv = new DataView(rb)
        t.check('<BYTE>ptr writes through (left)', 1, rbv.getInt32(0, true))
        t.check('<BYTE>ptr writes through (bottom)', 4, rbv.getInt32(12, true))
        // 类型层已挡住裸 ArrayBuffer；动态路径同样 fail-loud（BYTE.encode 的 instanceof 检查）
        let plainErr: unknown = null
        try { setRectB(new ArrayBuffer(16) as never, 1, 2, 3, 4) } catch (e) { plainErr = e }
        t.checkTrue('<BYTE>ptr rejects plain ArrayBuffer (fail-loud)', String(plainErr).includes('PtrArrayBuffer'))

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
        expectType<Equal<ParamsOf<'i32 -> i32'>[0], number>>()
        // 别名机制已移除：typedef 名塌 never（与 'i3z' 同路径，见上）
        expectType<Equal<ParamsOf<'DWORD -> i32'>[0], never>>()
        expectType<Equal<ParamsOf<'u64 -> i32'>[0], bigint>>()
        expectType<Equal<ParamsOf<'<BYTE>ptr -> i32'>[0], PtrArrayBuffer<any> | MaybePtr<"BYTE">>>()
        expectType<Equal<ParamsOf<'<WCHAR>ptr -> i32'>[0], string | MaybePtr<"WCHAR">>>()
        // 别名机制已移除：'LPCWSTR' 塌 never（字符串 codec 只挂在 <WCHAR>ptr 品牌位上）
        expectType<Equal<ParamsOf<'LPCWSTR -> i32'>[0], never>>()
        // 返回位非法 token 塌 unknown（never 是 bottom 在返回位被全放行，unknown 逼收窄；
        // 与参数位塌 never 拦调用的不对称是设计）
        expectType<Equal<RetOf<'<>ptr -> ptr'>, unknown>>()
        expectType<Equal<RetOf<'<>ptr -> i3z'>, unknown>>()
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
        const outI = new PtrArrayBuffer(64)
        i64toa(-9223372036854775808n, outI, 10)
        t.check('i64 arg -2^63 toa', '-9223372036854775808', bufToString(outI))
        i64toa(9007199254740993n, outI, 10)
        t.check('i64 arg 2^53+1 toa', '9007199254740993', bufToString(outI))

        const ui64toa = bind('msvcrt.dll', '_ui64toa', 'u64 <BYTE>ptr i32 -> <>ptr')
        const outU = new PtrArrayBuffer(64)
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
        const LOGBRUSH = struct('LOGBRUSH', {
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
        const POINT = struct('POINT', {
            x: 'i32',
            y: 'i32',
        })
        const LOGPEN = struct('LOGPEN', {
            lopnStyle: 'u32',
            lopnWidth: POINT.__struct,
            lopnColor: 'u32',
        })
        const createPenIndirect = bind('gdi32.dll', 'CreatePenIndirect', '<LOGPEN>ptr -> <>ptr', { LOGPEN })
        const pen = createPenIndirect({ lopnStyle: 0, lopnWidth: { x: 1, y: 1 }, lopnColor: 0x000000ff })
        t.checkTrue('CreatePenIndirect(<LOGPEN>ptr nested) returns HPEN', !!pen)
        if (pen) t.checkTrue('DeleteObject(HPEN) succeeds', deleteObject(pen) !== 0)

        // 别名机制已移除：normToken 对 typedef 名 fail-loud（动态签名串的运行时防线）
        try { normToken('LPCWSTR'); t.checkTrue('normToken 拒别名 LPCWSTR', false) }
        catch (e) { t.checkTrue('normToken 拒别名 LPCWSTR', String(e).includes('LPCWSTR')) }

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
        const rectOut = RECT.alloc()
        t.checkTrue('GetWindowRect(hwnd, RECT.alloc().ptr) succeeds', getWindowRect(desktop, rectOut.ptr) !== 0)
        const rectV = RECT.decode(rectOut)
        t.checkTrue('RECT.decode(encode()) decodes out-param', rectV.right > rectV.left && rectV.bottom > rectV.top)

        t.section('by-value struct <N>: lexicon / type layer / bind-time fail-loud')
        // '<N>' 裸品牌 = 按值传参位（<N>ptr 传地址）。无修饰可剥：带 ! / 尾缀 / 空名 /
        // 数字开头的形正则不匹配，落绑定期通用 Unknown token（与 '<X+>ptr' 同策略）。
        t.checkTrue("normToken('<POINT>') 原样归一", normToken('<POINT>') === '<POINT>')
        for (const bad of ['<POINT>!', '<POINT>x', '<>', '<1abc>']) {
            try { normToken(bad); t.checkTrue(`normToken 拒 '${bad}'`, false) }
            catch (e) { t.checkTrue(`normToken 拒 '${bad}'`, String(e).includes('Unknown token')) }
        }

        // 类型层：未注册布局的按值位塌 never（LE={} → L['POINT'] = never，同拼错 token 策略）
        expectType<Equal<ParamsOf<'<POINT> -> i32'>[0], never>>()
        // 注册布局：值域 = encode 入参形（对象），无 number 地址直通；ptr 位对照有
        const typeOnly: unknown = () => {
            const byVal = bind('user32.dll', 'PtInRect', '<RECT>ptr <POINT> -> i32', { RECT, POINT })
            expectType<Equal<Extract<Parameters<typeof byVal>[1], number>, never>>()
            const byPtr = bind('user32.dll', 'PtInRect', '<RECT>ptr <POINT>ptr -> i32', { RECT, POINT })
            expectType<Extract<Parameters<typeof byPtr>[1], number> extends never ? false : true>()
            // @ts-expect-error 按值位不收 number（地址词汇属 <N>ptr 位）
            byVal(NULL, 42)
            // @ts-expect-error 按值位收对象、不收数组
            byVal(NULL, [1, 2])
            return 0
        }
        t.checkTrue('type-only block wired', typeof typeOnly === 'function')

        // 绑定期 fail-loud：模块加载即炸，不留到首个调用
        try {
            bind('gdi32.dll', 'DeleteObject', '<PTMISS> -> i32')
            t.checkTrue('by-value 未注册布局 fail-loud', false)
        } catch (e) {
            t.checkTrue('by-value 未注册布局 fail-loud', String(e).includes('<PTMISS>'))
        }
        try {
            bind('gdi32.dll', 'DeleteObject', '<WCHAR> -> i32', { WCHAR })
            t.checkTrue('by-value 非结构 codec (无 size) fail-loud', false)
        } catch (e) {
            t.checkTrue('by-value 非结构 codec (无 size) fail-loud', String(e).includes('size'))
        }
        try {
            bind('gdi32.dll', 'DeleteObject', 'i32 -> <POINT>', { POINT })
            t.checkTrue('by-value 返回位 fail-loud', false)
        } catch (e) {
            t.checkTrue('by-value 返回位 fail-loud', String(e).includes('return position'))
        }
        try {
            closure('<POINT> -> i32', () => 0)
            t.checkTrue('by-value 位 closure fail-loud', false)
        } catch (e) {
            t.checkTrue('by-value 位 closure fail-loud', String(e).includes('closure'))
        }


        // 成员 '<RECT>ptr'：decode 得到 Ptr<'RECT'>，可直接喂 <RECT>ptr 形参（品牌在类型层流动）。
        const RECTPTR = struct('RECTPTR', {r: '<RECT>ptr'})
        const box = RECTPTR.decode(RECTPTR.encode({ r: rectOut.ptr }))
        t.checkTrue('GetWindowRect(hwnd, member RECT*) succeeds', box.r !== 0 && getWindowRect(desktop, box.r) !== 0)
        const rectThroughMember = RECT.decode(rectOut)
        t.checkTrue('writes through the member pointer', rectThroughMember.right > rectThroughMember.left && rectThroughMember.bottom > rectThroughMember.top)

        t.section('struct ptr return + branded passthrough')
        // 返回位 <NAME>ptr → MaybePtr<NAME>（NULL|Ptr，0 保真，只读指针，品牌在类型层）。
        // 该品牌指针可直接喂给另一函数的 <NAME>ptr 形参（裸地址透传，不重编码）。
        // 链条：localtime(&t) 返回 struct tm* → asctime(tm*) 消费之。
        const TM = struct('TM', {
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
        const tbuf = new PtrArrayBuffer(8)   // time_t=0（32/64 位 time_t 都读起始字节）
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

        // gmtime 同构第二例：UTC 锚点确定（time_t=0 → 1970-01-01，不依赖 TZ 环境）
        const gmtimeDec = bind('msvcrt.dll', 'gmtime', '<BYTE>ptr -> <TM>ptr', undefined, { TM })
        const gmObj = gmtimeDec(tbuf)
        t.checkTrue('gmtime + decoders auto-decodes (UTC anchor tm_year=70, tm_mday=1)',
            gmObj !== 0 && gmObj.tm_year === 70 && gmObj.tm_mday === 1)

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

        // WCHAR alloc/decode 往返：PtrArrayBuffer 预分配 + 手填 UTF-16LE + 双态读回
        const walloc = WCHAR.alloc(8)
        const wdv = new DataView(walloc)
        wdv.setUint16(0, 'h'.charCodeAt(0), true)
        wdv.setUint16(2, 'i'.charCodeAt(0), true)
        wdv.setUint16(4, 0, true)
        t.check('WCHAR.alloc(8) = 16 bytes', 16, walloc.byteLength)
        t.check('WCHAR.decode(ptr) roundtrip', 'hi', WCHAR.decode(walloc.ptr))
        t.check('WCHAR.decode(ArrayBuffer) roundtrip', 'hi', WCHAR.decode(walloc))
        t.check('BYTE.alloc(12) = 12 bytes', 12, BYTE.alloc(12).byteLength)

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

        // native readBytes：批量 memcpy 往返 + fail-loud 守卫（decode 指针分支的新底层）
        const rbB = new PtrArrayBuffer(8)
        new Uint8Array(rbB).set([1, 2, 3, 4, 250, 251, 252, 253])
        const rbCopy = ffi.readBytes(rbB.ptr, 8)
        t.check('readBytes(ptr, 8) memcpy roundtrip',
            '1,2,3,4,250,251,252,253', new Uint8Array(rbCopy).join(','))
        let rbNullErr = ''
        try { ffi.readBytes(0, 4) } catch (e) { rbNullErr = String(e) }
        t.checkTrue('readBytes(0, n) fails loud (null pointer)', rbNullErr.includes('null pointer'))
        let rbNegErr = ''
        try { ffi.readBytes(rbB.ptr, -1) } catch (e) { rbNegErr = String(e) }
        t.checkTrue('readBytes(p, -1) fails loud (RangeError)', rbNegErr.includes('RangeError'))

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

        t.section('closures: ! token 0 检查（dispatch 侧，与 callPacked 同语义）')
        {
            // 参数位：签名承诺 C 传非空，喂 0 → 跳过回调（fn 不被调用）+ 结果槽 0
            let argCalled = false
            const nnArg = closure('<>ptr! -> i32', (_p) => { argCalled = true; return 7 })
            const rr1 = new ArrayBuffer(8)
            ffi.ffiCall(nnArg.ptr, packArgs(['ptr'], [0]), rr1, 0)
            t.checkTrue('closure <>ptr! 喂 0：回调被跳过（fn 未执行）', !argCalled)
            t.check('closure <>ptr! 喂 0：结果槽保持 0', 0, new DataView(rr1).getInt32(0, true))
            const rr2 = new ArrayBuffer(8)
            ffi.ffiCall(nnArg.ptr, packArgs(['ptr'], [0x2000]), rr2, 0)
            t.checkTrue('closure <>ptr! 非空：回调执行', argCalled)
            t.check('closure <>ptr! 非空：返回值送达', 7, new DataView(rr2).getInt32(0, true))
            nnArg.dispose()

            // 返回位正例：fn 返回非零 → 检查通过、正常写槽
            const nnRet = closure('i32 -> <>ptr!', (_n) => 0x3000)
            const rr3 = new ArrayBuffer(8)
            ffi.ffiCall(nnRet.ptr, packArgs(['i32'], [1]), rr3, 0)
            t.check('closure 返回 ! 非零：正常写槽', 0x3000, readScalar(new DataView(rr3), 0, 'ptr'))
            nnRet.dispose()
            // 返回位负例：fn 返回 0 → printf 诊断 + 不写槽；C 侧 retbuf 初值恒零
            // （quickjs-ffi-closure.c zero8 拷贝），终值 0 与「写了 0」不可分——
            // 值层面只验分发不炸、槽保持 0（诊断走 stdout，见上方 printf）。
            const nnRet0 = closure('i32 -> <>ptr!', (_n) => 0)
            const rr4 = new ArrayBuffer(8)
            ffi.ffiCall(nnRet0.ptr, packArgs(['i32'], [1]), rr4, 0)
            t.check('closure 返回 ! 违约：分发不炸、槽 0', 0, readScalar(new DataView(rr4), 0, 'ptr'))
            nnRet0.dispose()
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
        const arrB = new PtrArrayBuffer(16)
        const arr = new Uint32Array(arrB)
        arr.set([5, 3, 8, 1])
        const readI32 = (p: number): number =>
            (ffi.readByte(p) | (ffi.readByte(p + 1) << 8) | (ffi.readByte(p + 2) << 16) | (ffi.readByte(p + 3) << 24))
        const cmp = closure('<>ptr <>ptr -> i32', (a, b) => readI32(a as number) - readI32(b as number), { stdcall: false })
        qsort(arrB, 4, 4, cmp.ptr)
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

        t.section('ptr! non-null token: 运行时 0 检查（写槽前 / 返回后）')
        const dcScreen = bind('user32.dll', 'GetDC', '<>ptr -> <>ptr')(0)
        // 参数位：禁 NULL 且传 0 → 写槽前当场 throw，错误带签名上下文与位号
        try {
            bind('user32.dll', 'GetDC', '<>ptr! -> <>ptr')(0)
            t.checkTrue('GetDC(0) 参数位标 ! 后应 throw', false)
        } catch (e) {
            t.checkTrue('! 参数位 throw 带签名上下文', String(e).includes('<>ptr!'))
            t.checkTrue('! 参数位 throw 带位号', String(e).includes('arg#1'))
        }
        // 正例：非零值照传、ABI 不受修饰影响
        const drawText = bind('user32.dll', 'DrawTextW', '<>ptr! <WCHAR>ptr i32 <BYTE>ptr i32 -> i32')
        const dtRect = new PtrArrayBuffer(16)
        if (dcScreen) {
            t.checkTrue('DrawTextW 非空 DC 通过 ! 参数位',
                drawText(dcScreen, 'hi !', -1, dtRect, gui.DrawTextFlag.CALCRECT) > 0)
            try {
                drawText(0, 'hi !', -1, dtRect, gui.DrawTextFlag.CALCRECT)
                t.checkTrue('DrawTextW NULL DC 标 ! 后应 throw', false)
            } catch (e) { t.checkTrue('! 参数位（第 1 位）throw 指明 arg#1', String(e).includes('arg#1')) }
        }
        // 返回位：找不到必返 NULL → 标 ! 返回位当场 throw
        try {
            bind('user32.dll', 'FindWindowW', '<WCHAR>ptr <WCHAR>ptr -> <>ptr!')('No.Such.Class', 'No.Such.Title')
            t.checkTrue('FindWindowW 返回 0 标 ! 后应 throw', false)
        } catch (e) {
            t.checkTrue('! 返回位 throw 带返回 token', String(e).includes('return <>ptr! got 0'))
        }

        t.section('token @Enum: 运行时归一（槽宽/ABI 只看底档）')
        const glPlain = bind('kernel32.dll', 'GetLastError', ' -> u32')()
        const glEnum = bind('kernel32.dll', 'GetLastError', ' -> u32@ErrorCode')()
        const glUnknown = bind('kernel32.dll', 'GetLastError', ' -> u32@NopeEnum')()
        t.check('返回位 @Enum 标注归一后取值一致', glPlain as number, glEnum as unknown)
        t.check('返回位未知枚举名同样归一（不炸）', glPlain as number, glUnknown as unknown)

        // 编译期：修饰对精确类型的影响（Equal 不成立即 tsc 报错）
        expectType<Equal<ParamsOf<'<X>ptr i32 -> i32'>[0], MaybePtr<'X'>>>()
        expectType<Equal<ParamsOf<'<X>ptr! i32 -> i32'>[0], Ptr<'X'>>>()
        expectType<Equal<RetOf<'<>ptr -> <X>ptr'>, MaybePtr<'X'>>>()
        expectType<Equal<RetOf<'<>ptr -> <X>ptr!'>, Ptr<'X'>>>()
        expectType<Equal<RetOf<'i32 -> i32'>, number>>()
        // @Enum 未知枚举名：参数位塌 never（fail-loud），返回位塌 unknown（never 会全放行）
        expectType<Equal<ParamsOf<'i32@NopeEnum -> i32'>[0], never>>()
        expectType<Equal<RetOf<'i32 -> i32@NopeEnum'>, unknown>>()
        // 返回位已知枚举名：钉住 pattern 命中后 = EnumMap 值域（分支失配落 unknown 时此条转红）
        expectType<Equal<RetOf<'i32 -> u32@ErrorCode'>, EnumMap['ErrorCode']>>()

        // struct 字段 '!'：EncodeIn 必填（省略 = 编译错）+ decode 0 断言（后置兜底）
        t.section("struct 字段 '!': encode 必填 + decode 0 断言")
        const S2 = struct('S2', { p: '<X>ptr', q: '<X>ptr!' })
        S2.alloc()                                          // 出参槽分配的无参语义在 alloc，不在 encode
        try {
            S2.decode(new PtrArrayBuffer(16))               // 全 0 槽（alloc 等价）→ '!' 字段读出 0 → throw
            t.checkTrue('decode 对 ! 字段 0 断言 throw', false)
        } catch (e) {
            t.checkTrue('decode ! 字段 0 断言指明字段名', String(e).includes('"q"'))
        }
        const s2buf = new PtrArrayBuffer(16)
        new DataView(s2buf).setUint32(S2.offsetOf('q'), 0x1234, true)   // 填非零 q（偏移动态，双架构）
        const d2 = S2.decode(s2buf)
        expectType<Equal<typeof d2.p, MaybePtr<'X'>>>()
        expectType<Equal<typeof d2.q, Ptr<'X'>>>()
        S2.encode(d2)
        // @ts-expect-error EncodeIn：'!' 字段 q 必填 —— 省略即编译错，不静默写 0
        S2.encode({ p: NULL })

        // 编译期：@Enum 值域 —— 枚举成员与域内字面量放行，宽 number / 异种枚举拒绝
        if (false) {
            const sw = bind('user32.dll', 'ShowWindow', '<X>ptr i32@ShowWindowCmd -> i32')
            const sp = bind('user32.dll', 'SetWindowPos', '<X>ptr <>ptr@SetWindowPosHwnd i32 i32 i32 i32 u32 -> i32')
            sw(NULL, gui.ShowWindowCmd.SHOW)  // 枚举成员
            sw(NULL, 5)                       // 域内字面量（5 = SW_SHOW）
            sp(NULL, gui.SetWindowPosHwnd.TOP, 0, 0, 0, 0, gui.SetWindowPosFlag.SWP_NOSIZE)
            // @ts-expect-error 域外字面量被拦（11152 不是任何 ShowWindow 命令）
            sw(NULL, 0x2B90)
            // @ts-expect-error 跨枚举误用：HWND_TOP/TOPMOST 不是 ShowWindow 命令
            sw(NULL, gui.SetWindowPosHwnd.TOP)
        }
    },
}
