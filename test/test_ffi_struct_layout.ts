import { Tester } from './test_helper.js'
import { computeStructLayout, computeArray } from '../lib/ffi/struct.js'
import type { CStruct, CUnion, CString, CArray } from '../lib/ffi/ctype.js'

export const suite = {
    name: 'ffi-struct-layout',
    run: (t: Tester) => {
        // === 基础布局 ===

        t.section('Basic struct')
        {
            const s: CStruct = {
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
            const s: CStruct = {
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
            const inner: CStruct = {
                tag: 'struct',
                member: [
                    { name: 'x', type: 'u32' },
                    { name: 'y', type: 'u32' },
                ]
            }
            const s: CStruct = {
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
            const u: CUnion = {
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
            const u: CUnion = {
                tag: 'union',
                member: [
                    { name: 'a', type: 'u8' },
                    { name: 'b', type: 'u32' },
                ]
            }
            const s: CStruct = {
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
            const inner: CStruct = {
                tag: 'struct',
                member: [
                    { name: 'x', type: 'u32' },
                    { name: 'y', type: 'u32' },
                ]
            }
            const s: CStruct = {
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
            const arr: CArray = { tag: 'array', ctype: 'u32', length: 4 }
            const r = computeArray(arr)
            t.check('size', 16, r.size)
            t.check('align', 4, r.align)
        }

        t.section('Array of struct')
        {
            const inner: CStruct = {
                tag: 'struct',
                member: [
                    { name: 'x', type: 'u32' },
                    { name: 'y', type: 'u32' },
                ]
            }
            const arr: CArray = { tag: 'array', ctype: inner, length: 3 }
            const r = computeArray(arr)
            t.check('size', 24, r.size)  // 3 * 8
            t.check('align', 4, r.align)
        }

        t.section('Array in struct')
        {
            const s: CStruct = {
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
            const s: CString = { tag: 'string', unit: 'u16', length: 10, encoding: 'utf-16le' }
            const r = computeStructLayout({ tag: 'struct', member: [{ name: 'name', type: s }] })
            t.check('size', 20, r.size)  // 2 * 10
            t.check('align', 2, r.maxEffectiveAlign)
            t.check('offset', 0, r.fields[0]!.offset)
        }

        // === Pack ===

        t.section('Pack(1)')
        {
            const s: CStruct = {
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
            const s: CStruct = {
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
            const s: CStruct = {
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
            const s: CStruct = {
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
            const s: CStruct = {
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
            const s: CStruct = {
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
            const s: CStruct = {
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
    }
}
