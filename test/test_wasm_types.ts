import { Tester, readWasmFile } from './test_helper.js'

export const suite = {
    name: 'wasm-types',
    run: (t: Tester) => {
        const buf = readWasmFile('./types.wasm')
        if (!buf) { t.fail++; return }
        const m = new WebAssembly.Module(buf)
        const i = new WebAssembly.Instance(m)

        t.section('i32')
        t.check('add_i32(10, 20)', 30, i.exports.add_i32(10, 20))
        t.check('add_i32(-5, 3)', -2, i.exports.add_i32(-5, 3))

        t.section('i64')
        t.check('add_i64(100, 200)', 300, i.exports.add_i64(100, 200))
        t.check('add_i64(10000000000, 20000000000)', 30000000000, i.exports.add_i64(10000000000, 20000000000))
        t.check('add_i64(-10000000000, 5000000000)', -5000000000, i.exports.add_i64(-10000000000, 5000000000))
        t.check('factorial_i64(5)', 120, i.exports.factorial_i64(5))
        t.check('factorial_i64(10)', 3628800, i.exports.factorial_i64(10))

        t.section('f32')
        t.check('add_f32(1.5, 2.5)', 4.0, i.exports.add_f32(1.5, 2.5))
        t.check('add_f32(-1.0, 1.0)', 0.0, i.exports.add_f32(-1.0, 1.0))

        t.section('f64')
        t.check('add_f64(3.14, 2.86)', 6.0, i.exports.add_f64(3.14, 2.86))
        t.check('sqrt_f64(144.0)', 12.0, i.exports.sqrt_f64(144.0))

        t.section('mixed')
        t.check('mixed_args(1, 2, 3.0, 4.0)', 10.0, i.exports.mixed_args(1, 2, 3.0, 4.0))

        t.section('memory')
        i.exports.write_memory(0, 12345678)
        t.check('write/read memory', 12345678, i.exports.read_memory(0))

        t.section('JS-side TypedArray')
        t.check('Int32Array[0]', 12345678, new Int32Array(i.exports.memory.buffer)[0])
        i.exports.write_memory(4, 999)
        t.check('Int32Array[1] after write', 999, new Int32Array(i.exports.memory.buffer)[1])

        t.section('exported globals')
        t.check('const_i32.value', 42, i.exports.const_i32.value)
        t.check('const_f64.value', 3.14, i.exports.const_f64.value)
        t.check('mutable_i32 is Global', true, i.exports.mutable_i32 instanceof WebAssembly.Global)
        t.check('mutable_i32.value', 99, i.exports.mutable_i32.value)
        i.exports.mutable_i32.value = 500
        t.check('mutable_i32 after set from JS', 500, i.exports.mutable_i32.value)
        t.check('mutable_i32 after set from WASM', 500, i.exports.read_mut_global())

        t.section('Global constructor')
        var g: WebAssembly.Global
        g = new WebAssembly.Global({ value: 'i32', mutable: false }, 42)
        t.check('Global(i32)', 42, g.value)
        g = new WebAssembly.Global({ value: 'i64' }, 10000000000)
        t.check('Global(i64)', 10000000000, g.value)
        g = new WebAssembly.Global({ value: 'f64' }, 3.14)
        t.check('Global(f64)', 3.14, g.value)
        g = new WebAssembly.Global({ value: 'f32' }, 2.5)
        t.check('Global(f32)', 2.5, g.value)

        t.section('Global mutable set')
        g = new WebAssembly.Global({ value: 'i32', mutable: true }, 0)
        t.check('initial', 0, g.value)
        g.value = 77
        t.check('after set', 77, g.value)

        t.section('Global immutable set throws')
        g = new WebAssembly.Global({ value: 'i32', mutable: false }, 10)
        try {
            g.value = 999
            t.fail++
        } catch (e) {
            t.ok++
        }

        t.section('Global.valueOf')
        g = new WebAssembly.Global({ value: 'i32' }, 55)
        t.check('valueOf()', 55, g.valueOf())

        t.section('Memory constructor')
        var mem: WebAssembly.Memory
        mem = new WebAssembly.Memory({ initial: 1 })
        t.check('Memory created', true, mem instanceof WebAssembly.Memory)
        t.check('buffer byteLength', 65536, mem.buffer.byteLength)
        mem = new WebAssembly.Memory({ initial: 2, maximum: 4 })
        t.check('Memory(2,4) buffer', 131072, mem.buffer.byteLength)
        t.check('grow(1) returned', 2, mem.grow(1))
        t.check('after grow buffer', 196608, mem.buffer.byteLength)

        t.section('instance.exports.memory')
        t.check('memory is Memory', true, i.exports.memory instanceof WebAssembly.Memory)
        t.check('memory.buffer.byteLength', 65536, i.exports.memory.buffer.byteLength)

        t.section('standalone Memory + TypedArray')
        mem = new WebAssembly.Memory({ initial: 1 })
        var arr = new Int32Array(mem.buffer)
        arr[0] = 42; arr[1] = 7
        t.check('Int32Array[0]', 42, arr[0])
        t.check('Int32Array[1]', 7, arr[1])

        t.section('buffer identity')
        arr[2] = 100
        t.check('old view[2]', 100, arr[2])
        t.check('new view[2]', 100, new Int32Array(mem.buffer)[2])
        t.check('buffer is same object', true, mem.buffer === mem.buffer)
    }
}
