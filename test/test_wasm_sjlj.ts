import { Tester, readWasmFile } from './test_helper.js'

class EmscriptenEH {}
class EmscriptenSjLj extends EmscriptenEH {}

export const suite = {
    name: 'wasm-sjlj',
    run: (t: Tester) => {
        ;(globalThis as any).EmscriptenEH = EmscriptenEH
        ;(globalThis as any).EmscriptenSjLj = EmscriptenSjLj

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

        function getWasmTableEntry(index: number): Function {
            const table = inst!.exports['__indirect_function_table'] as { get(index: number): Function }
            const fn = table.get(index)
            return fn as Function
        }

        function _setThrew(val: number, _v: number): void {
            if (threwBit === 0) {
                threwBit = val
            }
        }

        function invoke_ii(index: number, a1: number): number {
            try {
                return getWasmTableEntry(index)(a1)
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
            const result = (inst.exports as { identity: (x: number) => number }).identity(42)
            t.check('identity(42) = 42', 42, result)
        } catch (e) { t.fail++ }

        t.section('invoke_ii with no-throw function')
        try {
            threwBit = 0
            const result = (inst.exports as { test_no_throw: () => number }).test_no_throw()
            t.check('test_no_throw() returns 10', 10, result)
            t.check('threwBit is 0', 0, threwBit)
        } catch (e) { t.fail++ }

        t.section('invoke_ii with throwing function')
        try {
            threwBit = 0
            const result = (inst.exports as { test_throw: () => number }).test_throw()
            t.check('test_throw() detects threwBit', true, result !== 0)
            t.check('threwBit is set', true, threwBit !== 0)
        } catch (e) { t.fail++ }

        t.section('nested invoke (invoke_ii calls invoke_ii)')
        try {
            threwBit = 0
            const result = (inst.exports as { test_nested_invoke: () => number }).test_nested_invoke()
            t.check('test_nested_invoke() detects threwBit', true, result !== 0)
            t.check('threwBit is set', true, threwBit !== 0)
        } catch (e) { t.fail++ }

        t.section('setjmp_test pattern')
        try {
            threwBit = 0
            const result = (inst.exports as { setjmp_test: (x: number) => number }).setjmp_test(0)
            t.check('setjmp_test detects throw', -1, result)
            t.check('threwBit is set', true, threwBit !== 0)
        } catch (e) { t.fail++ }

        t.section('setjmp/longjmp: a(x) normal path')
        try {
            threwBit = 0
            const result = (inst.exports as { a: (x: number) => number }).a(5)
            t.check('a(5) returns 10 (b returns x*2)', 10, result)
            t.check('threwBit is 0', 0, threwBit)
        } catch (e) { t.fail++ }

        t.section('setjmp/longjmp: a(x) longjmp path')
        try {
            threwBit = 0
            const result = (inst.exports as { a: (x: number) => number }).a(-1)
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
