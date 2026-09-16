import { createServer } from '../lib/http-server.js'
import * as std from 'std'

const server = createServer(async (req) => {
    if (req.method === 'POST' && new URL(req.url).pathname === '/exec') {
        const body = await req.json() as { cmd: string }
        const file = std.popen(body.cmd, 'r')
        if (!file) return new Response(JSON.stringify({ error: 'popen failed' }), { status: 500 })
        const output = file.readAsString()
        file.close()
        return new Response(JSON.stringify({ output }))
    }
    return new Response('Not Found', { status: 404 })
})

server.listen(8080)
console.log('listening on http://localhost:8080')
