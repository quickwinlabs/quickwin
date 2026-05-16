import * as std from 'std'

std.printf("Hello\n")
function readWasmFile(path: string): ArrayBuffer | null {
    const fp = std.open(path, 'rb')
    if (!fp) {
        return null
    }

    fp.seek(0, 2) // SEEK_END
    const size = fp.tell()
    fp.seek(0, 0) // SEEK_SET

    const buffer = new ArrayBuffer(size)
    fp.read(buffer, 0, size)
    fp.close()

    return buffer
}

const wasmBuf = readWasmFile('./complex_imports.wasm')

try {
    if (!wasmBuf) throw new Error('failed to load wasm')
    const m = new WebAssembly.Module(wasmBuf)
    console.log('imports:', WebAssembly.Module.imports(m))
    console.log('exports:', WebAssembly.Module.exports(m))
    const inst = new WebAssembly.Instance(m, {
        env: {
            log_i32: (x) => { console.log('  log_i32:', x) },
            log_i64: (x) => { console.log('  log_i64:', x) },
            log_f32: (x) => { console.log('  log_f32:', x) },
            log_f64: (x) => { console.log('  log_f64:', x) },
            op_i32: (a, b, c) => a * b + c,
        }
    });

    console.log('--- i32 ---')
    let r = inst.exports.run_i32(7)
    console.log('  run_i32(7) =>', r, '(expected 75)')

    console.log('--- i64 ---')
    r = inst.exports.run_i64(100000, 200000)
    console.log('  run_i64(100000, 200000) =>', r, '(expected 300000)')
    r = inst.exports.run_i64(10000000000, 20000000000)
    console.log('  run_i64(10000000000, 20000000000) =>', r, '(expected 30000000000)')

    console.log('--- f32 ---')
    r = inst.exports.run_f32(3.5)
    console.log('  run_f32(3.5) =>', r, '(expected 7.0)')

    console.log('--- f64 ---')
    r = inst.exports.run_f64(2.5, 4.0)
    console.log('  run_f64(2.5, 4.0) =>', r, '(expected 10.0)')

    console.log('--- all done ---')
} catch (e) {
    console.log('ERROR:', e)
};

