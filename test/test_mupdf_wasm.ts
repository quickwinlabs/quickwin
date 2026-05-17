import { Tester, readWasmFile } from './test_helper.js'

export const suite = {
    name: 'vendor/mupdf-wasm',
    run: (t: Tester) => {
        t.section('validate binary')
        const buf = readWasmFile('../vendor/mupdf-wasm/mupdf-wasm.wasm')
        if (!buf) { t.fail++; return }
        t.check('file size > 0', true, buf.byteLength > 0)
        const header = new Uint8Array(buf)
        t.check('magic', true, header[0] === 0x00 && header[1] === 0x61 && header[2] === 0x73 && header[3] === 0x6d)
        t.check('version 1', true, header[4] === 0x01 && header[5] === 0x00 && header[6] === 0x00 && header[7] === 0x00)
        t.check('WebAssembly.validate', true, WebAssembly.validate(buf))

        t.section('Module')
        var mod: WebAssembly.Module | null = null
        try {
            mod = new WebAssembly.Module(buf)
            t.ok++
        } catch (e) { t.fail++ }

        t.section('imports/exports')
        if (mod) {
            const exps = WebAssembly.Module.exports(mod)
            t.check('exports > 0', true, exps.length > 0)
            const imps = WebAssembly.Module.imports(mod)
            t.check('imports', imps.length, imps.length)
        }
    }
}
