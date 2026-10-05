import { Tester } from './test_helper.js'
import { computeStructLayout, computeArray } from '../lib/ffi/struct.js'
import type { Fields } from '../lib/ffi/struct.js'
import { bit } from '../lib/ffi/ctype.js'
import type { C_Struct, C_Union, C_String, C_Array } from '../lib/ffi/ctype.js'

export const suite = {
    name: 'ffi-struct-layout',
    run: (t: Tester) => {
        // === 基础布局 ===

        t.section('Basic struct')
        {
            const s: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'a', type: 'u32' },
                    { name: 'b', type: 'u32' },
                    { name: 'c', type: 'u32' },
                ]
            }
            const r = computeStructLayout(s)
            t.check('size', 12, r.size)
            t.check('align', 4, r.maxEffectiveAlign)
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset b', 4, r.fields[1]!.offset)
            t.check('offset c', 8, r.fields[2]!.offset)
        }

        t.section('Padding')
        {
            const s: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'a', type: 'u8' },
                    { name: 'b', type: 'u32' },
                    { name: 'c', type: 'u8' },
                ]
            }
            const r = computeStructLayout(s)
            t.check('size', 12, r.size)  // 1 + 3pad + 4 + 1 + 3pad
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset b', 4, r.fields[1]!.offset)  // aligned to 4
            t.check('offset c', 8, r.fields[2]!.offset)
        }

        // === 嵌套 struct ===

        t.section('Nested struct')
        {
            const inner: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'x', type: 'u32' },
                    { name: 'y', type: 'u32' },
                ]
            }
            const s: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'a', type: 'u8' },
                    { name: 'b', type: inner },
                ]
            }
            const r = computeStructLayout(s)
            t.check('size', 12, r.size)  // 1 + 3pad + 8
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset b', 4, r.fields[1]!.offset)  // b 自身偏移
            const b = r.fields[1]!
            t.checkTrue('b 是 struct 成员', b.type.tag === 'struct')
            if (b.type.tag === 'struct') {
                t.check('b.x (相对子起点)', 0, b.type.fields[0]!.offset)
                t.check('b.y (相对子起点)', 4, b.type.fields[1]!.offset)
            }
        }

        // === Union ===

        t.section('Union')
        {
            const u: C_Union = {
                tag: 'union',
                member: [
                    { name: 'a', type: 'u8' },
                    { name: 'b', type: 'u32' },
                    { name: 'c', type: 'u64' },
                ]
            }
            const r = computeStructLayout(u)
            t.check('size', 8, r.size)  // max member size
            t.check('align', 8, r.maxEffectiveAlign)  // max member align
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset b', 0, r.fields[1]!.offset)
            t.check('offset c', 0, r.fields[2]!.offset)
        }

        t.section('Union in struct')
        {
            const u: C_Union = {
                tag: 'union',
                member: [
                    { name: 'a', type: 'u8' },
                    { name: 'b', type: 'u32' },
                ]
            }
            const s: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'a', type: 'u8' },
                    { name: 'u', type: u },
                    { name: 'c', type: 'u8' },
                ]
            }
            const r = computeStructLayout(s)
            t.check('size', 12, r.size)  // 1 + 3pad + 4 + 1 + 3pad
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset u', 4, r.fields[1]!.offset)
            const uf = r.fields[1]!
            t.checkTrue('u 是 union 成员', uf.type.tag === 'union')
            if (uf.type.tag === 'union') {
                t.check('u.a', 0, uf.type.fields[0]!.offset)   // union member 同偏移
                t.check('u.b', 0, uf.type.fields[1]!.offset)
            }
            t.check('offset c', 8, r.fields[2]!.offset)
        }

        // === 匿名成员提升 ===

        t.section('Anonymous struct promotion')
        {
            const inner: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'x', type: 'u32' },
                    { name: 'y', type: 'u32' },
                ]
            }
            const s: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'a', type: 'u8' },
                    { type: inner },   // 匿名：字段被提升
                ]
            }
            const r = computeStructLayout(s)
            t.check('size', 12, r.size)  // 1 + 3pad + 8
            t.check('提升后字段数', 3, r.fields.length)
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset x (提升)', 4, r.fields[1]!.offset)
            t.check('offset y (提升)', 8, r.fields[2]!.offset)
        }

        // === Array ===

        t.section('Array of basic')
        {
            const arr: C_Array = { tag: 'array', ctype: 'u32', length: 4 }
            const r = computeArray(arr)
            t.check('size', 16, r.size)
            t.check('align', 4, r.align)
        }

        t.section('Array of struct')
        {
            const inner: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'x', type: 'u32' },
                    { name: 'y', type: 'u32' },
                ]
            }
            const arr: C_Array = { tag: 'array', ctype: inner, length: 3 }
            const r = computeArray(arr)
            t.check('size', 24, r.size)  // 3 * 8
            t.check('align', 4, r.align)
        }

        t.section('Array in struct')
        {
            const s: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'a', type: 'u8' },
                    { name: 'arr', type: { tag: 'array', ctype: 'u32', length: 4 } },
                ]
            }
            const r = computeStructLayout(s)
            t.check('size', 20, r.size)  // 1 + 3pad + 16
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset arr', 4, r.fields[1]!.offset)
        }

        // === String ===

        t.section('CString')
        {
            const s: C_String = { tag: 'string', unit: 'u16', length: 10, encoding: 'utf-16le' }
            const r = computeStructLayout({ tag: 'struct', member: [{ name: 'name', type: s }] })
            t.check('size', 20, r.size)  // 2 * 10
            t.check('align', 2, r.maxEffectiveAlign)
            t.check('offset', 0, r.fields[0]!.offset)
        }

        // === Pack ===

        t.section('Pack(1)')
        {
            const s: C_Struct = {
                tag: 'struct', pack: 1,
                member: [
                    { name: 'a', type: 'u8' },
                    { name: 'b', type: 'u32' },
                    { name: 'c', type: 'u8' },
                ]
            }
            const r = computeStructLayout(s)
            t.check('size', 6, r.size)  // 1 + 4 + 1, no padding
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset b', 1, r.fields[1]!.offset)  // no alignment
            t.check('offset c', 5, r.fields[2]!.offset)
        }

        t.section('Pack(4)')
        {
            const s: C_Struct = {
                tag: 'struct', pack: 4,
                member: [
                    { name: 'a', type: 'u8' },
                    { name: 'b', type: 'u64' },  // natural align 8, capped to 4
                ]
            }
            const r = computeStructLayout(s)
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset b', 4, r.fields[1]!.offset)  // aligned to 4, not 8
        }

        // === Alignas ===

        t.section('Alignas')
        {
            const s: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'a', type: 'u8' },
                    { name: 'b', type: 'u32', alignas: 8 },
                ]
            }
            const r = computeStructLayout(s)
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset b', 8, r.fields[1]!.offset)  // aligned to 8
        }

        t.section('Alignas(2) < natural(4)')
        {
            const s: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'a', type: 'u8' },
                    { name: 'b', type: 'u32', alignas: 2 },  // natural is 4, alignas is 2
                ]
            }
            const r = computeStructLayout(s)
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset b', 4, r.fields[1]!.offset)  // natural align wins (4 > 2)
        }

        // === Pack + Alignas interaction ===

        t.section('Pack(1) + Alignas(8)')
        {
            const s: C_Struct = {
                tag: 'struct', pack: 1,
                member: [
                    { name: 'a', type: 'u8' },
                    { name: 'b', type: 'u32', alignas: 8 },  // alignas wins over pack
                ]
            }
            const r = computeStructLayout(s)
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset b', 8, r.fields[1]!.offset)  // alignas(8) > pack(1)
        }

        t.section('Pack(4) + Alignas(2)')
        {
            const s: C_Struct = {
                tag: 'struct', pack: 4,
                member: [
                    { name: 'a', type: 'u8' },
                    { name: 'b', type: 'u64', alignas: 2 },  // natural 8, pack 4, alignas 2
                ]
            }
            const r = computeStructLayout(s)
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset b', 4, r.fields[1]!.offset)  // min(pack=4, natural=8)=4, max(4, alignas=2)=4
        }

        t.section('Pack(4) + Alignas(16)')
        {
            const s: C_Struct = {
                tag: 'struct', pack: 4,
                member: [
                    { name: 'a', type: 'u8' },
                    { name: 'b', type: 'u32', alignas: 16 },  // alignas(16) > pack(4)
                ]
            }
            const r = computeStructLayout(s)
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset b', 16, r.fields[1]!.offset)  // alignas wins
        }

        // === 位域 ===
        // ground truth: mingw x86_64 交叉编译 sizeof/offsetof（含 windows.h 自带的
        // DCB/COMSTAT）。i686 同结果（DCB/COMSTAT 无指针字段，32/64 位布局一致）。

        const bitOf = (fields: Fields, n: string): { offset: number, bit: number } => {
            const f = fields.find(x => x.name === n)!
            t.checkTrue(`${n} is bitfield`, f.type.tag === 'bitfield')
            return { offset: f.offset, bit: (f.type as { bit: number }).bit }
        }
        const offOf = (fields: Fields, n: string): number => fields.find(x => x.name === n)!.offset

        t.section('Bitfield: 同单元打包 + 溢出开新单元（MS 文档例子）')
        {
            // 9+7=16 塞满第一单元，30 放不下开第二，18 开第三。sizeof 应为 12。
            const s: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'first', type: bit('u32', 9) },
                    { name: 'second', type: bit('u32', 7) },
                    { name: 'may_straddle', type: bit('u32', 30) },
                    { name: 'last', type: bit('u32', 18) },
                ]
            }
            const r = computeStructLayout(s)
            t.check('sizeof == 12', 12, r.size)
            t.check('first.offset == 0', 0, bitOf(r.fields, 'first').offset)
            t.check('second.offset == 0 (共单元)', 0, bitOf(r.fields, 'second').offset)
            t.check('second.bit == 9', 9, bitOf(r.fields, 'second').bit)
            t.check('may_straddle.offset == 4 (新单元)', 4, bitOf(r.fields, 'may_straddle').offset)
            t.check('may_straddle.bit == 0', 0, bitOf(r.fields, 'may_straddle').bit)
            t.check('last.offset == 8 (再新单元)', 8, bitOf(r.fields, 'last').offset)
        }

        t.section('Bitfield: 精确填充算放得下')
        {
            // 15+17=32 恰好塞满一个 32 位单元 → 不开新单元（mingw 实测 sizeof=8, w@4）
            const s: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'a', type: bit('u32', 15) },
                    { name: 'b', type: bit('u32', 17) },
                    { name: 'w', type: 'u16' },
                ]
            }
            const r = computeStructLayout(s)
            t.check('sizeof == 8 (单元 0-3 + w@4, pad 到 8)', 8, r.size)
            t.check('b.offset == 0 (共单元)', 0, bitOf(r.fields, 'b').offset)
            t.check('b.bit == 15', 15, bitOf(r.fields, 'b').bit)
            t.check('w.offset == 4 (紧跟单元)', 4, offOf(r.fields, 'w'))
        }

        t.section('Bitfield: 非位域成员打断组 → 游标跳完整单元边界')
        {
            // u32 单元用 12 位 = 2 字节，但 char 落在单元边界 4（不是按字节截断的 2）
            const s: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'a', type: bit('u32', 12) },
                    { name: 'z', type: 'u8' },
                ]
            }
            const r = computeStructLayout(s)
            t.check('sizeof == 8 (char@4, pad 到 8)', 8, r.size)
            t.check('z.offset == 4 (单元边界)', 4, offOf(r.fields, 'z'))

            // u16 单元用 12 位 = 2 字节 = 完整单元，char 紧随其后
            const s2: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'a', type: bit('u16', 12) },
                    { name: 'z', type: 'u8' },
                ]
            }
            const r2 = computeStructLayout(s2)
            t.check('u16 单元 sizeof == 4', 4, r2.size)
            t.check('z.offset == 2 (u16 单元边界)', 2, offOf(r2.fields, 'z'))
        }

        t.section('Bitfield: 同宽不分签别，共单元')
        {
            const s: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'a', type: bit('u32', 8) },
                    { name: 'b', type: bit('i32', 8) },
                ]
            }
            const r = computeStructLayout(s)
            t.check('sizeof == 4 (有/无符号共单元)', 4, r.size)
            t.check('b.bit == 8', 8, bitOf(r.fields, 'b').bit)
        }

        t.section('Bitfield: DCB（mingw windows.h sizeof=28）')
        {
            const s: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'DCBlength', type: 'u32' },
                    { name: 'BaudRate', type: 'u32' },
                    { name: 'fBinary', type: bit('u32', 1) },
                    { name: 'fParity', type: bit('u32', 1) },
                    { name: 'fOutxCtsFlow', type: bit('u32', 1) },
                    { name: 'fOutxDsrFlow', type: bit('u32', 1) },
                    { name: 'fDtrControl', type: bit('u32', 2) },
                    { name: 'fDsrSensitivity', type: bit('u32', 1) },
                    { name: 'fTXContinueOnXoff', type: bit('u32', 1) },
                    { name: 'fOutX', type: bit('u32', 1) },
                    { name: 'fInX', type: bit('u32', 1) },
                    { name: 'fErrorChar', type: bit('u32', 1) },
                    { name: 'fNull', type: bit('u32', 1) },
                    { name: 'fRtsControl', type: bit('u32', 2) },
                    { name: 'fAbortOnError', type: bit('u32', 1) },
                    { name: 'fDummy2', type: bit('u32', 17) },
                    { name: 'wReserved', type: 'u16' },
                    { name: 'XonLim', type: 'u16' },
                    { name: 'XoffLim', type: 'u16' },
                    { name: 'ByteSize', type: 'u8' },
                    { name: 'Parity', type: 'u8' },
                    { name: 'StopBits', type: 'u8' },
                    { name: 'XonChar', type: 'i8' },
                    { name: 'XoffChar', type: 'i8' },
                    { name: 'ErrorChar', type: 'i8' },
                    { name: 'EofChar', type: 'i8' },
                    { name: 'EvtChar', type: 'i8' },
                    { name: 'wReserved1', type: 'u16' },
                ]
            }
            const r = computeStructLayout(s)
            t.check('DCB.size == 28', 28, r.size)
            t.check('fBinary.offset == 8 (单元基址)', 8, bitOf(r.fields, 'fBinary').offset)
            // 前 13 个位域 15 位 + fDummy2:17 = 32 位，恰好塞满一个 4 字节单元
            t.check('fDummy2.offset == 8 (共单元，未溢出)', 8, bitOf(r.fields, 'fDummy2').offset)
            t.check('fDummy2.bit == 15', 15, bitOf(r.fields, 'fDummy2').bit)
            t.check('wReserved.offset == 12', 12, offOf(r.fields, 'wReserved'))
            t.check('XonLim.offset == 14', 14, offOf(r.fields, 'XonLim'))
            t.check('ByteSize.offset == 18', 18, offOf(r.fields, 'ByteSize'))
            t.check('EofChar.offset == 24', 24, offOf(r.fields, 'EofChar'))
            t.check('wReserved1.offset == 26', 26, offOf(r.fields, 'wReserved1'))
        }

        t.section('Bitfield: COMSTAT（mingw windows.h sizeof=12）')
        {
            const s: C_Struct = {
                tag: 'struct',
                member: [
                    { name: 'fCtsHold', type: bit('u32', 1) },
                    { name: 'fDsrHold', type: bit('u32', 1) },
                    { name: 'fRlsdHold', type: bit('u32', 1) },
                    { name: 'fXoffHold', type: bit('u32', 1) },
                    { name: 'fXoffSent', type: bit('u32', 1) },
                    { name: 'fEof', type: bit('u32', 1) },
                    { name: 'fTxim', type: bit('u32', 1) },
                    { name: 'fReserved', type: bit('u32', 25) },
                    { name: 'cbInQue', type: 'u32' },
                    { name: 'cbOutQue', type: 'u32' },
                ]
            }
            const r = computeStructLayout(s)
            t.check('COMSTAT.size == 12', 12, r.size)
            t.check('fReserved.bit == 7', 7, bitOf(r.fields, 'fReserved').bit)
            t.check('cbInQue.offset == 4', 4, offOf(r.fields, 'cbInQue'))
            t.check('cbOutQue.offset == 8', 8, offOf(r.fields, 'cbOutQue'))
        }

        t.section('Bitfield: union 位域按 struct 打包（不别名）')
        {
            const u: C_Union = {
                tag: 'union',
                member: [
                    { name: 'a', type: bit('u32', 1) },
                    { name: 'b', type: bit('u32', 1) },
                ]
            }
            const r = computeStructLayout(u)
            t.check('sizeof == 4', 4, r.size)
            t.check('a.offset == 0', 0, bitOf(r.fields, 'a').offset)
            t.check('b.offset == 0 (同单元)', 0, bitOf(r.fields, 'b').offset)
            t.check('b.bit == 1 (不同位)', 1, bitOf(r.fields, 'b').bit)
        }

        t.section('Bitfield validation')
        {
            const rejected = (s: C_Struct): boolean => {
                try { computeStructLayout(s); return false } catch { return true }
            }
            t.check('width 0 rejected (v1 不支持 :0 填充)', true,
                rejected({ tag: 'struct', member: [{ name: 'x', type: bit('u32', 0) }] }))
            t.check('width > unit bits rejected', true,
                rejected({ tag: 'struct', member: [{ name: 'x', type: bit('u32', 33) }] }))
            t.check('width > u8 bits rejected', true,
                rejected({ tag: 'struct', member: [{ name: 'x', type: bit('u8', 9) }] }))
            t.check('negative width rejected', true,
                rejected({ tag: 'struct', member: [{ name: 'x', type: bit('u32', -1) }] }))
            t.check('non-integer width rejected', true,
                rejected({ tag: 'struct', member: [{ name: 'x', type: bit('u32', 2.5) }] }))
            t.check('array of bitfields rejected', true,
                rejected({ tag: 'struct', member: [{ name: 'x', type: { tag: 'array', ctype: bit('u32', 1) as any, length: 2 } }] }))
            t.check('anonymous bitfield rejected', true,
                rejected({ tag: 'struct', member: [{ type: bit('u32', 1) } as any] }))
        }
    }
}
