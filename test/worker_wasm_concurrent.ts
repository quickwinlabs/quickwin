import * as os from 'os'

const parent = os.Worker.parent

parent.onmessage = (e) => {
    const d = e.data as { type: string; wasmBuf: ArrayBuffer; imports?: Record<string, unknown>; calls: [string, unknown[]][] }
    if (d.type === 'start') {
        try {
            const mod = new WebAssembly.Module(d.wasmBuf)
            const inst = new WebAssembly.Instance(mod, d.imports || {})
        const results: number[] = []
        for (const [name, args] of d.calls) {
            results.push((inst.exports[name] as Function)(...args))
        }
        parent.postMessage({ ok: true, results })
        } catch (err) {
            parent.postMessage({ ok: false, error: String(err) })
        }
    } else if (d.type === 'done') {
        parent.onmessage = null
    }
}
