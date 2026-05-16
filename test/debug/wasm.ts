import * as std from 'std'

function readWasmFile(path: string): ArrayBuffer | null {
    const fp = std.open(path, 'rb')
    if (!fp) return null
    fp.seek(0, 2)
    const size = fp.tell()
    fp.seek(0, 0)
    const buffer = new ArrayBuffer(size)
    fp.read(buffer, 0, size)
    fp.close()
    return buffer
}

var ok = 0, fail = 0
function check(name: string, expected: any, actual: any) {
    if (typeof expected === 'number' && typeof actual === 'number') {
        if (Math.abs(expected - actual) < 0.0001) { ok++; std.printf('  PASS: %s = %s\n', name, String(actual)) }
        else { fail++; std.printf('  FAIL: %s = %s (expected %s)\n', name, String(actual), String(expected)) }
    } else if (expected === actual) { ok++; std.printf('  PASS: %s = %s\n', name, String(actual)) }
    else { fail++; std.printf('  FAIL: %s = %s (expected %s)\n', name, String(actual), String(expected)) }
}

std.printf('=== validate ===\n')
check('empty buffer', false, WebAssembly.validate(new Uint8Array([]).buffer))
check('invalid bytes', false, WebAssembly.validate(new Uint8Array([1, 2, 3]).buffer))

const wasmBuffer = readWasmFile('./add.wasm')
if (!wasmBuffer) { std.printf('FAIL: cannot load add.wasm\n'); std.exit(1) }
check('valid module', true, WebAssembly.validate(wasmBuffer))

std.printf('=== Module ===\n')
var module: any = null
try {
    module = new WebAssembly.Module(wasmBuffer)
    check('Module constructor', true, module instanceof WebAssembly.Module)
} catch (e) {
    std.printf('  FAIL: Module constructor: %s\n', String(e)); fail++
}

std.printf('=== Module.exports ===\n')
if (module) {
    try {
        const exps = WebAssembly.Module.exports(module)
        check('exports count', 1, exps.length)
        check('export name', 'add', exps[0].name)
        check('export kind', 'function', exps[0].kind)
    } catch (e) {
        std.printf('  FAIL: Module.exports: %s\n', String(e)); fail++
    }
}

std.printf('=== Instance (add.wasm) ===\n')
if (module) {
    try {
        const instance = new WebAssembly.Instance(module)
        check('Instance created', true, instance instanceof WebAssembly.Instance)
        check('add(1, 2)', 3, instance.exports.add(1, 2))
        check('add(10, 20)', 30, instance.exports.add(10, 20))
        check('add(-5, 3)', -2, instance.exports.add(-5, 3))
    } catch (e) {
        std.printf('  FAIL: Instance: %s\n', String(e)); fail++
    }
}

std.printf('=== complex.wasm (multi exports) ===\n')
const complexBuffer = readWasmFile('./complex.wasm')
if (complexBuffer) {
    try {
        const cmod = new WebAssembly.Module(complexBuffer)
        const cinst = new WebAssembly.Instance(cmod)
        check('add(3, 4)', 7, cinst.exports.add(3, 4))
        check('sub(10, 3)', 7, cinst.exports.sub(10, 3))
        check('mul(6, 7)', 42, cinst.exports.mul(6, 7))
        check('factorial(0)', 1, cinst.exports.factorial(0))
        check('factorial(5)', 120, cinst.exports.factorial(5))
        check('factorial(10)', 3628800, cinst.exports.factorial(10))
    } catch (e) {
        std.printf('  FAIL: complex.wasm: %s\n', String(e)); fail++
    }
}

std.printf('=== import function support ===\n')
const importFuncBuffer = readWasmFile('./import_func.wasm')
if (importFuncBuffer) {
    try {
        const ifmod = new WebAssembly.Module(importFuncBuffer)
        const importObject = {
            env: { imported_add: (a: number, b: number) => a + b }
        }
        const ifinst = new WebAssembly.Instance(ifmod, importObject)
        check('add_via_import(3, 4)', 7, ifinst.exports.add_via_import(3, 4))
        check('add_via_import(10, 20)', 30, ifinst.exports.add_via_import(10, 20))
        check('add_via_import(-5, 3)', -2, ifinst.exports.add_via_import(-5, 3))
    } catch (e) {
        std.printf('  FAIL: import_func.wasm: %s\n', String(e)); fail++
    }
}

std.printf('\n%d/%d tests passed\n', ok, ok+fail)
if (fail > 0) std.exit(1)
