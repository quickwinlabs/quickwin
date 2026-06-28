import * as std from 'std'
import { Tester, readWasmFile } from './test_helper.js'

function is_available(): boolean {
    const buf = readWasmFile('./add.aot')
    return buf !== null
}

function run(t: Tester) {
    t.section('AOT module')
    const aotBuf = readWasmFile('./add.aot')
    if (!aotBuf) { t.fail++; return }

    const mod = new WebAssembly.Module(aotBuf)
    t.check('AOT Module created', true, mod instanceof WebAssembly.Module)

    const inst = new WebAssembly.Instance(mod)
    t.check('AOT Instance created', true, inst instanceof WebAssembly.Instance)

    const add = inst.exports.add as (a: number, b: number) => number
    t.check('add(40, 2) = 42', 42, add(40, 2))
    t.check('add(0, 0) = 0', 0, add(0, 0))
    t.check('add(-5, 5) = 0', 0, add(-5, 5))

    t.section('WASM still works')
    const wasmBuf = readWasmFile('./add.wasm')
    if (!wasmBuf) { t.fail++; return }

    const wasmMod = new WebAssembly.Module(wasmBuf)
    t.check('WASM Module loads', true, wasmMod instanceof WebAssembly.Module)

    const wasmInst = new WebAssembly.Instance(wasmMod)
    const wasmAdd = wasmInst.exports.add as (a: number, b: number) => number
    t.check('wasm add(10, 20) = 30', 30, wasmAdd(10, 20))
}

export const suite = {
    name: 'aot-load',
    run,
}
