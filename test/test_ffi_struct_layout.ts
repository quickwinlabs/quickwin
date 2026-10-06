import { Tester } from './test_helper.js'
import { computeStructLayout, computeArray } from '../lib/ffi/struct.js'
import type { Fields } from '../lib/ffi/struct.js'
import type { C_Struct, C_Union, C_Array } from '../lib/ffi/ctype.js'

export const suite = {
    name: 'ffi-struct-layout',
    run: (t: Tester) => {
        // === 基础布局 ===

        t.section('Basic struct')
        {
            const s: C_Struct = {
                '#': 'struct',
                a: 'u32',
                b: 'u32',
                c: 'u32',
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
                '#': 'struct',
                a: 'u8',
                b: 'u32',
                c: 'u8',
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
                '#': 'struct',
                x: 'u32',
                y: 'u32',
            }
            const s: C_Struct = {
                '#': 'struct',
                a: 'u8',
                b: inner,
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
                '#': 'union',
                a: 'u8',
                b: 'u32',
                c: 'u64',
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
                '#': 'union',
                a: 'u8',
                b: 'u32',
            }
            const s: C_Struct = {
                '#': 'struct',
                a: 'u8',
                u: u,
                c: 'u8',
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
                '#': 'struct',
                x: 'u32',
                y: 'u32',
            }
            const s: C_Struct = {
                '#': 'struct',
                a: 'u8',
                $anon1: inner,   // 匿名：字段被提升
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
            const arr: C_Array = { '#': 'array', element: 'u32', length: 4 }
            const r = computeArray(arr)
            t.check('size', 16, r.size)
            t.check('align', 4, r.align)
        }

        t.section('Array of struct')
        {
            const inner: C_Struct = {
                '#': 'struct',
                x: 'u32',
                y: 'u32',
            }
            const arr: C_Array = { '#': 'array', element: inner, length: 3 }
            const r = computeArray(arr)
            t.check('size', 24, r.size)  // 3 * 8
            t.check('align', 4, r.align)
        }

        t.section('Array in struct（糖写法）')
        {
            const s: C_Struct = {
                '#': 'struct',
                a: 'u8',
                arr: 'u32[4]',   // 数组糖（元素是 token 时的简写）
            }
            const r = computeStructLayout(s)
            t.check('size', 20, r.size)  // 1 + 3pad + 16
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset arr', 4, r.fields[1]!.offset)
        }

        t.section('Array in struct（# 形式 + 聚合元素）')
        {
            const inner: C_Struct = { '#': 'struct', x: 'u16', y: 'u16' }
            const s: C_Struct = {
                '#': 'struct',
                a: 'u8',
                arr: { '#': 'array', element: inner, length: 3 },
            }
            const r = computeStructLayout(s)
            t.check('size == 14 (a@0 + 1pad + 3*4，align 取 inner 的 2)', 14, r.size)
            t.check('offset arr == 2 (inner align 2)', 2, r.fields[1]!.offset)
        }

        // === String ===

        // === String（字符串糖：布局 unit[length] + 解释 @encoding 正交） ===

        t.section('CString sugar（u16[10]@utf-16le）')
        {
            const r = computeStructLayout({ '#': 'struct', name: 'u16[10]@utf-16le' })
            t.check('size == 20 (typesize × length)', 20, r.size)
            t.check('align == 2 (u16 槽)', 2, r.maxEffectiveAlign)
            t.check('offset', 0, r.fields[0]!.offset)
        }

        t.section('CString sugar: 布局与解释正交（size 只看 unit×length）')
        {
            const r = computeStructLayout({ '#': 'struct', a: 'u8', s: 'u8[8]@utf-16le' })
            t.check('错配 u8[8]@utf-16le size == 9', 9, r.size)   // 1 + 8，encoding 不参与布局
            t.check('align == 1 (u8 槽)', 1, r.maxEffectiveAlign)
            t.check('offset s == 1 (无 padding)', 1, r.fields[1]!.offset)
            const r2 = computeStructLayout({ '#': 'struct', s: 'u16[4]@utf-8' })
            t.check('错配 u16[4]@utf-8 size == 8', 8, r2.size)    // 2 × 4
            t.check('align == 2 (u16 槽)', 2, r2.maxEffectiveAlign)
        }

        t.section('CString sugar validation')
        {
            const rejected = (s: C_Struct): boolean => {
                try { computeStructLayout(s); return false } catch { return true }
            }
            t.check('length 0 rejected', true,
                rejected({ '#': 'struct', x: 'u8[0]@utf-8' }))
            t.check('unit 非 u8/u16 rejected（落 token 分支抛）', true,
                rejected({ '#': 'struct', x: 'u32[4]@utf-8' as any }))
            t.check('unknown encoding rejected', true,
                rejected({ '#': 'struct', x: 'u16[4]@utf-16be' as any }))
            t.check('旧写法 {\'#\':\'string\'} rejected（词汇已删）', true,
                rejected({ '#': 'struct', x: { '#': 'string', unit: 'u16', length: 4, encoding: 'utf-16le' } } as any))
        }

        // === Pack ===

        t.section('Pack(1)')
        {
            const s: C_Struct = {
                '#': 'struct', '#pack': 1,
                a: 'u8',
                b: 'u32',
                c: 'u8',
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
                '#': 'struct', '#pack': 4,
                a: 'u8',
                b: 'u64',  // natural align 8, capped to 4
            }
            const r = computeStructLayout(s)
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset b', 4, r.fields[1]!.offset)  // aligned to 4, not 8
        }

        // === Alignas（键尾 @N） ===

        t.section('Alignas')
        {
            const s: C_Struct = {
                '#': 'struct',
                a: 'u8',
                'b@8': 'u32',
            }
            const r = computeStructLayout(s)
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset b', 8, r.fields[1]!.offset)  // aligned to 8
            t.check('字段名剥离 @N', 'b', r.fields[1]!.name)
        }

        t.section('Alignas(2) < natural(4)')
        {
            const s: C_Struct = {
                '#': 'struct',
                a: 'u8',
                'b@2': 'u32',  // natural is 4, alignas is 2
            }
            const r = computeStructLayout(s)
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset b', 4, r.fields[1]!.offset)  // natural align wins (4 > 2)
        }

        // === Pack + Alignas interaction ===

        t.section('Pack(1) + Alignas(8)')
        {
            const s: C_Struct = {
                '#': 'struct', '#pack': 1,
                a: 'u8',
                'b@8': 'u32',  // alignas wins over pack
            }
            const r = computeStructLayout(s)
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset b', 8, r.fields[1]!.offset)  // alignas(8) > pack(1)
        }

        t.section('Pack(4) + Alignas(2)')
        {
            const s: C_Struct = {
                '#': 'struct', '#pack': 4,
                a: 'u8',
                'b@2': 'u64',  // natural 8, pack 4, alignas 2
            }
            const r = computeStructLayout(s)
            t.check('offset a', 0, r.fields[0]!.offset)
            t.check('offset b', 4, r.fields[1]!.offset)  // min(pack=4, natural=8)=4, max(4, alignas=2)=4
        }

        t.section('Pack(4) + Alignas(16)')
        {
            const s: C_Struct = {
                '#': 'struct', '#pack': 4,
                a: 'u8',
                'b@16': 'u32',  // alignas(16) > pack(4)
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
                '#': 'struct',
                first: 'u32:9',
                second: 'u32:7',
                may_straddle: 'u32:30',
                last: 'u32:18',
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
                '#': 'struct',
                a: 'u32:15',
                b: 'u32:17',
                w: 'u16',
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
                '#': 'struct',
                a: 'u32:12',
                z: 'u8',
            }
            const r = computeStructLayout(s)
            t.check('sizeof == 8 (char@4, pad 到 8)', 8, r.size)
            t.check('z.offset == 4 (单元边界)', 4, offOf(r.fields, 'z'))

            // u16 单元用 12 位 = 2 字节 = 完整单元，char 紧随其后
            const s2: C_Struct = {
                '#': 'struct',
                a: 'u16:12',
                z: 'u8',
            }
            const r2 = computeStructLayout(s2)
            t.check('u16 单元 sizeof == 4', 4, r2.size)
            t.check('z.offset == 2 (u16 单元边界)', 2, offOf(r2.fields, 'z'))
        }

        t.section('Bitfield: 同宽不分签别，共单元')
        {
            const s: C_Struct = {
                '#': 'struct',
                a: 'u32:8',
                b: 'i32:8',
            }
            const r = computeStructLayout(s)
            t.check('sizeof == 4 (有/无符号共单元)', 4, r.size)
            t.check('b.bit == 8', 8, bitOf(r.fields, 'b').bit)
        }

        t.section('Bitfield: DCB（mingw windows.h sizeof=28）')
        {
            const s: C_Struct = {
                '#': 'struct',
                DCBlength: 'u32',
                BaudRate: 'u32',
                fBinary: 'u32:1',
                fParity: 'u32:1',
                fOutxCtsFlow: 'u32:1',
                fOutxDsrFlow: 'u32:1',
                fDtrControl: 'u32:2',
                fDsrSensitivity: 'u32:1',
                fTXContinueOnXoff: 'u32:1',
                fOutX: 'u32:1',
                fInX: 'u32:1',
                fErrorChar: 'u32:1',
                fNull: 'u32:1',
                fRtsControl: 'u32:2',
                fAbortOnError: 'u32:1',
                fDummy2: 'u32:17',
                wReserved: 'u16',
                XonLim: 'u16',
                XoffLim: 'u16',
                ByteSize: 'u8',
                Parity: 'u8',
                StopBits: 'u8',
                XonChar: 'i8',
                XoffChar: 'i8',
                ErrorChar: 'i8',
                EofChar: 'i8',
                EvtChar: 'i8',
                wReserved1: 'u16',
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
                '#': 'struct',
                fCtsHold: 'u32:1',
                fDsrHold: 'u32:1',
                fRlsdHold: 'u32:1',
                fXoffHold: 'u32:1',
                fXoffSent: 'u32:1',
                fEof: 'u32:1',
                fTxim: 'u32:1',
                fReserved: 'u32:25',
                cbInQue: 'u32',
                cbOutQue: 'u32',
            }
            const r = computeStructLayout(s)
            t.check('COMSTAT.size == 12', 12, r.size)
            t.check('fReserved.bit == 7', 7, bitOf(r.fields, 'fReserved').bit)
            t.check('cbInQue.offset == 4', 4, offOf(r.fields, 'cbInQue'))
            t.check('cbOutQue.offset == 8', 8, offOf(r.fields, 'cbOutQue'))
        }

        t.section('Bitfield: union 位域完全别名（mingw 实测：每位域成员独立 offset 0/bit 0）')
        {
            const u: C_Union = {
                '#': 'union',
                a: 'u32:1',
                b: 'u32:1',
            }
            const r = computeStructLayout(u)
            t.check('sizeof == 4', 4, r.size)
            t.check('a.offset == 0', 0, bitOf(r.fields, 'a').offset)
            t.check('a.bit == 0', 0, bitOf(r.fields, 'a').bit)
            t.check('b.offset == 0 (同址别名)', 0, bitOf(r.fields, 'b').offset)
            t.check('b.bit == 0 (同位别名，实测 a=1→b=1)', 0, bitOf(r.fields, 'b').bit)
        }

        t.section('Bitfield: union 溢出/混合形状不越界（regression：曾推进游标致 offset 越出 size）')
        {
            // 溢出：struct 里 30+4>32 开新单元；union 每成员独立回 offset 0
            const u2: C_Union = { '#': 'union', a: 'u32:30', b: 'u32:4' }
            const r2 = computeStructLayout(u2)
            t.check('overflow sizeof == 4', 4, r2.size)
            t.check('overflow a.offset == 0', 0, bitOf(r2.fields, 'a').offset)
            t.check('overflow b.offset == 0（回 offset 0 重叠，曾为 4）', 0, bitOf(r2.fields, 'b').offset)
            t.check('overflow b.bit == 0', 0, bitOf(r2.fields, 'b').bit)

            // 位域后跟普通成员：flushUnit 不得推进 union 游标
            const u3: C_Union = { '#': 'union', a: 'u32:1', b: 'u8' }
            const r3 = computeStructLayout(u3)
            t.check('mixed sizeof == 4', 4, r3.size)
            t.check('mixed a.offset == 0', 0, bitOf(r3.fields, 'a').offset)
            t.check('mixed b.offset == 0（曾错位到 4 → 越出 size 4）', 0, offOf(r3.fields, 'b'))
        }

        t.section('Bitfield validation')
        {
            const rejected = (s: C_Struct): boolean => {
                try { computeStructLayout(s); return false } catch { return true }
            }
            t.check('width 0 rejected (v1 不支持 :0 填充)', true,
                rejected({ '#': 'struct', x: 'u32:0' }))
            t.check('width > unit bits rejected', true,
                rejected({ '#': 'struct', x: 'u32:33' }))
            t.check('width > u8 bits rejected', true,
                rejected({ '#': 'struct', x: 'u8:9' }))
            t.check('negative width rejected（非 \\d+ → 落 token 分支抛）', true,
                rejected({ '#': 'struct', x: 'u32:-1' }))
            t.check('non-integer width rejected', true,
                rejected({ '#': 'struct', x: 'u32:2.5' }))
            t.check('array of bitfields rejected（# 形式）', true,
                rejected({ '#': 'struct', x: { '#': 'array', element: 'u32:1', length: 2 } }))
            t.check('array of bitfields rejected（数组糖，类型层拒绝故 as any）', true,
                rejected({ '#': 'struct', x: 'u32:1[2]' as any }))
            t.check('anonymous bitfield rejected', true,
                rejected({ '#': 'struct', $anon1: 'u32:1' } as any))
            t.check('float bitfield unit rejected（归一后非整数档）', true,
                rejected({ '#': 'struct', x: 'float:3' as any }))
            t.check('unknown bitfield unit rejected', true,
                rejected({ '#': 'struct', x: 'i3z:3' as any }))
            t.check('array with #pack rejected（#pack 仅 struct/union）', true,
                rejected({ '#': 'struct', x: { '#': 'array', element: 'u8', length: 2, '#pack': 4 } as any }))
        }

        t.section('# declaration validation')
        {
            const rejected = (s: C_Struct): boolean => {
                try { computeStructLayout(s); return false } catch { return true }
            }
            // '#' 必填：裸嵌套 map（漏写 '#'）不再默认 struct，直接报错
            t.check('bare nested map rejected（漏写 #）', true,
                rejected({ '#': 'struct', x: { mask: 'u32' } } as any))
            t.check('unknown # tag rejected', true,
                rejected({ '#': 'struct', x: { '#': 'oops' } } as any))
            t.check('void token rejected（无大小）', true,
                rejected({ '#': 'struct', x: 'void' } as any))
            t.check('bare ptr token rejected', true,
                rejected({ '#': 'struct', x: 'ptr' } as any))
        }
    }
}
