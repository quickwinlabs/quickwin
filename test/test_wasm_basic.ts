import { Tester, readWasmFile } from './test_helper.js'

export const suite = {
    name: 'wasm-basic',
    run: (t: Tester) => {
        t.section('validate')
        t.check('empty buffer', false, WebAssembly.validate(new Uint8Array([]).buffer))
        t.check('invalid bytes', false, WebAssembly.validate(new Uint8Array([1, 2, 3]).buffer))
        const wasmBuf = readWasmFile('./add.wasm')
        if (!wasmBuf) { t.fail++; return }
        t.check('valid add.wasm', true, WebAssembly.validate(wasmBuf))

        t.section('Module')
        var mod: WebAssembly.Module | null = null
        try {
            mod = new WebAssembly.Module(wasmBuf)
            t.check('Module constructor', true, mod instanceof WebAssembly.Module)
        } catch (e) { t.fail++ }

        t.section('Module.exports')
        if (mod) {
            try {
                const exps = WebAssembly.Module.exports(mod)
                t.check('exports count', 1, exps.length)
                t.check('export name', 'add', exps[0].name)
                t.check('export kind', 'function', exps[0].kind)
            } catch (e) { t.fail++ }
        }

        t.section('Instance (add.wasm)')
        if (mod) {
            try {
                const inst = new WebAssembly.Instance(mod)
                t.check('Instance created', true, inst instanceof WebAssembly.Instance)
                t.check('add(1, 2)', 3, inst.exports.add(1, 2))
                t.check('add(10, 20)', 30, inst.exports.add(10, 20))
                t.check('add(-5, 3)', -2, inst.exports.add(-5, 3))
            } catch (e) { t.fail++ }
        }

        t.section('complex.wasm')
        const complexBuf = readWasmFile('./complex.wasm')
        if (complexBuf) {
            try {
                const cmod = new WebAssembly.Module(complexBuf)
                const cinst = new WebAssembly.Instance(cmod)
                t.check('add(3, 4)', 7, cinst.exports.add(3, 4))
                t.check('sub(10, 3)', 7, cinst.exports.sub(10, 3))
                t.check('mul(6, 7)', 42, cinst.exports.mul(6, 7))
                t.check('factorial(0)', 1, cinst.exports.factorial(0))
                t.check('factorial(5)', 120, cinst.exports.factorial(5))
                t.check('factorial(10)', 3628800, cinst.exports.factorial(10))
            } catch (e) { t.fail++ }
        }

        t.section('import function')
        const importFuncBuf = readWasmFile('./import_func.wasm')
        if (importFuncBuf) {
            try {
                const ifmod = new WebAssembly.Module(importFuncBuf)
                const ifinst = new WebAssembly.Instance(ifmod, {
                    env: { imported_add: (a: number, b: number) => a + b }
                })
                t.check('add_via_import(3, 4)', 7, ifinst.exports.add_via_import(3, 4))
                t.check('add_via_import(10, 20)', 30, ifinst.exports.add_via_import(10, 20))
                t.check('add_via_import(-5, 3)', -2, ifinst.exports.add_via_import(-5, 3))
            } catch (e) { t.fail++ }
        }
    }
}
