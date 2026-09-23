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
    const path = new URL(req.url).pathname
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
        return new Response('ok', { headers: { 'Content-Type': 'text/plain' } })
    }
    if (req.method === 'POST' && path === '/exec') {
        const body = await req.json() as { cmd: string }
        const file = std.popen(body.cmd, 'r')
        if (!file) {
            return new Response(JSON.stringify({ out: '', code: -1, error: 'popen failed' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            })
        }
        const output = readAll(file)
        const code = file.close()
        return new Response(JSON.stringify({ out: output, code }), {
            headers: { 'Content-Type': 'application/json' }
        })
    }
    return new Response('Not Found', { status: 404 })
})

const rc = server.listen(8080, '0.0.0.0')
console.log('listen rc=' + rc + ' addr=' + JSON.stringify(server.address()))
