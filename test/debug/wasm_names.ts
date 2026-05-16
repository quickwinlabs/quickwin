import * as std from 'std'

// Load the mupdf-wasm binary using our pre-load mechanism
const fp = std.open('./mupdf-wasm/mupdf-wasm.wasm', 'rb')
if (!fp) { console.log('cannot open mupdf-wasm.wasm'); std.exit(1) }
fp.seek(0, 2)
const size = fp.tell()
fp.seek(0, 0)
const buf = new ArrayBuffer(size)
fp.read(buf, 0, size)
fp.close()

// Check exports for Tf
const module = new WebAssembly.Module(buf)
const exports = WebAssembly.Module.exports(module)
const imports = WebAssembly.Module.imports(module)

// Look for Tf specifically
let foundTf = false
for (const e of exports) {
    if (e.name === 'Tf') {
        console.log('FOUND Tf in exports')
        foundTf = true
        break
    }
}
if (!foundTf) console.log('Tf NOT in exports')

// Check a few nearby names used in assignWasmExports
const wanted = ['Tf', 'Uf', 'Vf', 'Wf', 'Xf', 'Yf', 'Sf', 'Rf', 'Qf', 'Pf', 'Of', 'Nf']
const found: string[] = []
const missing: string[] = []
for (const w of wanted) {
    if (exports.some(e => e.name === w)) found.push(w)
    else missing.push(w)
}
console.log('found:', found.join(', '))
console.log('missing:', missing.join(', '))

// Count exports
console.log('total exports:', exports.length)
console.log('total imports:', imports.length)

// List first 30 export names
for (let i = 0; i < 30 && i < exports.length; i++)
    console.log('  export', i, '=', exports[i].name)
