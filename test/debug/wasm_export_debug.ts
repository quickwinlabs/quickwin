import * as std from 'std'

const fp = std.open('./mupdf-wasm/mupdf-wasm.wasm', 'rb')
if (!fp) { console.log('cannot open mupdf-wasm.wasm'); std.exit(1) }
fp.seek(0, 2)
const size = fp.tell()
fp.seek(0, 0)
const buf = new ArrayBuffer(size)
fp.read(buf, 0, size)
fp.close()

const module = new WebAssembly.Module(buf)
const exports = WebAssembly.Module.exports(module)
const imports = WebAssembly.Module.imports(module)

// List ALL export names
console.log(`=== All exports (${exports.length}) ===`)
for (let i = 0; i < exports.length; i++) {
    if (exports[i].name === 'ul' || exports[i].name === 'tl')
        console.log(`  ${i}: ${exports[i].name} (${exports[i].kind}) *** FOUND ***`)
}
// Check last 20 exports
console.log(`\n=== Last 20 exports ===`)
for (let i = Math.max(0, exports.length - 20); i < exports.length; i++)
    console.log(`  ${i}: ${exports[i].name} (${exports[i].kind})`)

// Check if ul/tl are import functions
console.log(`\n=== Imports (${imports.length}) ===`)
for (let i = 0; i < imports.length; i++) {
    if (imports[i].name === 'ul' || imports[i].name === 'tl')
        console.log(`  ${i}: ${imports[i].module}.${imports[i].name}`)
}

// Now try to call simple exports and see if exec_env is the issue
console.log(`\n=== Direct instance call test ===`)
const importObj = { a: {} }
for (const imp of imports) {
    if (!importObj[imp.module]) importObj[imp.module] = {}
    if (imp.kind === 'function') {
        importObj[imp.module][imp.name] = () => 0
    }
}

// Test calling db, eb sequentially
const inst = new WebAssembly.Instance(module, importObj)
console.log('1. calling db()...')
inst.exports['db']()
console.log('2. calling db() again...')
inst.exports['db']()  
console.log('3. calling eb()...')
try {
    inst.exports['eb']()
    console.log('   eb() succeeded')
} catch(e) {
    console.log('   eb() failed:', e)
}
console.log('4. calling fb(100)...')
try {
    const r = inst.exports['fb'](100)
    console.log('   fb(100) =', r)
} catch(e) {
    console.log('   fb(100) failed:', e)
}
