import { createServer } from '../lib/http-server.js'
import * as std from 'std'

function readAll(file: std.FILE): string {
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
    return new TextDecoder().decode(out)
}

const server = createServer(async (req) => {
    if (req.method === 'POST' && new URL(req.url).pathname === '/exec') {
        const body = await req.json() as { cmd: string }
        const file = std.popen(body.cmd, 'r')
        if (!file) return new Response('popen failed', { status: 500 })
        const output = readAll(file)
        file.close()
        return new Response(output, {
            headers: { 'Content-Type': 'application/octet-stream' }
        })
    }
    return new Response('Not Found', { status: 404 })
})

server.listen(8080)
console.log('listening on http://localhost:8080')
