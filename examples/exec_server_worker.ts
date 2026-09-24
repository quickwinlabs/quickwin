import * as os from 'os'
import * as std from 'std'

function readBytes(file: std.FILE): Uint8Array {
    const chunks: Uint8Array[] = []
    const buf = new Uint8Array(4096)
    while (true) {
        const n = file.read(buf.buffer, 0, 4096)
        if (n <= 0) break
        chunks.push(buf.slice(0, n))
    }
    let total = 0
    for (const c of chunks) total += c.length
    const out = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) { out.set(c, offset); offset += c.length }
    return out
}

const parent = os.Worker.parent
parent.onmessage = (e) => {
    const msg = e.data as { type: string; id: number; cmd?: string }
    if (msg.type !== 'run' || typeof msg.cmd !== 'string') return
    let out: Uint8Array = new Uint8Array(0)
    let code = -1
    let error: string | null = null
    try {
        const file = std.popen(msg.cmd, 'r')
        if (!file) {
            error = 'popen failed'
        } else {
            out = readBytes(file)
            code = file.close()
        }
    } catch (ex) {
        error = String(ex)
    }
    parent.postMessage({ type: 'result', id: msg.id, out, code, error })
}
