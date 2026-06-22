import * as os from 'os'

const parent = os.Worker.parent

parent.onmessage = (e) => {
    if (e.data.type === 'start') {
        try {
            const mod = new WebAssembly.Module(e.data.wasmBuf)
            const inst = new WebAssembly.Instance(mod, e.data.imports || {})
        const results: number[] = []
        for (const [name, args] of e.data.calls) {
            results.push(inst.exports[name](...args))
        }
        parent.postMessage({ ok: true, results })
        } catch (err) {
            parent.postMessage({ ok: false, error: String(err) })
        }
    } else if (e.data.type === 'done') {
        parent.onmessage = null
    }
}
