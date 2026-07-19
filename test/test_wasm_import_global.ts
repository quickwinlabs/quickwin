import { Tester, readWasmFile } from './test_helper.js'

type GlobalImportsExports = {
    get_offset: () => number
    compute: (x: number) => number
    run: (x: number) => number
}

export const suite = {
    name: 'wasm-import-global',
    run: (t: Tester) => {
        const giBuf = readWasmFile('./global_imports.wasm')
        if (!giBuf) { t.fail++; return }
        const giMod = new WebAssembly.Module(giBuf)

        t.section('import globals')
        var giInst: WebAssembly.Instance<GlobalImportsExports>
        try {
            giInst = new WebAssembly.Instance<GlobalImportsExports>(giMod, {
                env: {
                    offset: new WebAssembly.Global({ value: 'i32', mutable: false }, 42),
                    factor: new WebAssembly.Global({ value: 'f64', mutable: false }, 3.14),
                    log: function (_x: number) { /* noop */ }
                }
            })
        } catch (e) {
            t.fail++; return
        }
        t.check('get_offset()', 42, giInst.exports.get_offset())
        t.check('compute(10)', 31.4, giInst.exports.compute(10))
        t.check('run(8)', 50, giInst.exports.run(8))

        t.section('second instance')
        var giInst2 = new WebAssembly.Instance<GlobalImportsExports>(giMod, {
            env: {
                offset: new WebAssembly.Global({ value: 'i32', mutable: false }, 100),
                factor: new WebAssembly.Global({ value: 'f64', mutable: false }, 2.0),
                log: function (_x: number) { /* noop */ }
            }
        })
        t.check('instance2 get_offset()', 100, giInst2.exports.get_offset())
        t.check('instance2 compute(5)', 10, giInst2.exports.compute(5))
        t.check('instance1 still get_offset()', 42, giInst.exports.get_offset())
    }
}
