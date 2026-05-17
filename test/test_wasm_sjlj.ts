import { Tester, readWasmFile } from './test_helper.js'

class EmscriptenEH {}
class EmscriptenSjLj extends EmscriptenEH {}

export const suite = {
    name: 'wasm-sjlj',
    run: (t: Tester) => {
        globalThis.EmscriptenEH = EmscriptenEH
        globalThis.EmscriptenSjLj = EmscriptenSjLj

        const buf = readWasmFile('./sjlj.wasm')
        if (!buf) { t.fail++; return }

        t.section('Module')
        var mod: WebAssembly.Module | null = null
        try {
            mod = new WebAssembly.Module(buf)
            t.check('Module created', true, mod instanceof WebAssembly.Module)
        } catch (e) { t.fail++; return }

        t.section('Instance with SjLj imports')
        var inst: WebAssembly.Instance | null = null
        var threwBit = 0
        var threwValue = 0

        function getWasmTableEntry(index: number): Function {
            const table = inst!.exports['__indirect_function_table'] as any
            const fn = table.get(index)
            return fn as Function
        }

        function _setThrew(val: number, v: number): void {
            if (threwBit === 0) {
                threwValue = v
                threwBit = val
            }
        }

        function invoke_ii(index: number, a1: number): number {
            try {
                return getWasmTableEntry(index)(a1) as number
            } catch (e) {
                if (!(e instanceof EmscriptenEH)) throw e
                _setThrew(1, 0)
                return 0
            }
        }

        try {
            inst = new WebAssembly.Instance(mod, {
                env: {
                    throw_longjmp: () => { throw new EmscriptenSjLj },
                    invoke_ii: invoke_ii,
                }
            })
            t.check('Instance created', true, inst instanceof WebAssembly.Instance)
        } catch (e) {
            t.fail++
            return
        }

        t.section('identity (no throw)')
        try {
            threwBit = 0
            threwValue = 0
            const result = (inst.exports as any).identity(42)
            t.check('identity(42) = 42', 42, result)
        } catch (e) { t.fail++ }

        t.section('invoke_ii with no-throw function')
        try {
            threwBit = 0
            threwValue = 0
            const result = (inst.exports as any).test_no_throw()
            t.check('test_no_throw() returns 10', 10, result)
            t.check('threwBit is 0', 0, threwBit)
        } catch (e) { t.fail++ }

        t.section('invoke_ii with throwing function')
        try {
            threwBit = 0
            threwValue = 0
            const result = (inst.exports as any).test_throw()
            t.check('test_throw() detects threwBit', true, result !== 0)
            t.check('threwBit is set', true, threwBit !== 0)
        } catch (e) { t.fail++ }

        t.section('nested invoke (invoke_ii calls invoke_ii)')
        try {
            threwBit = 0
            threwValue = 0
            const result = (inst.exports as any).test_nested_invoke()
            t.check('test_nested_invoke() detects threwBit', true, result !== 0)
            t.check('threwBit is set', true, threwBit !== 0)
        } catch (e) { t.fail++ }

        t.section('setjmp_test pattern')
        try {
            threwBit = 0
            threwValue = 0
            const result = (inst.exports as any).setjmp_test(0)
            t.check('setjmp_test detects throw', -1, result)
            t.check('threwBit is set', true, threwBit !== 0)
        } catch (e) { t.fail++ }

        t.section('setjmp/longjmp: a(x) normal path')
        try {
            threwBit = 0
            threwValue = 0
            const result = (inst.exports as any).a(5)
            t.check('a(5) returns 10 (b returns x*2)', 10, result)
            t.check('threwBit is 0', 0, threwBit)
        } catch (e) { t.fail++ }

        t.section('setjmp/longjmp: a(x) longjmp path')
        try {
            threwBit = 0
            threwValue = 0
            const result = (inst.exports as any).a(-1)
            t.check('a(-1) returns -1 (longjmp caught)', -1, result)
            t.check('threwBit is set', true, threwBit !== 0)
        } catch (e) { t.fail++ }

        t.section('EmscriptenSjLj instanceof check')
        try {
            const exc = new EmscriptenSjLj()
            t.check('instanceof EmscriptenEH', true, exc instanceof EmscriptenEH)
            t.check('instanceof EmscriptenSjLj', true, exc instanceof EmscriptenSjLj)
            const regularErr = new Error('test')
            t.check('Error not instanceof EmscriptenEH', false, regularErr instanceof EmscriptenEH)
        } catch (e) { t.fail++ }
    }
}
