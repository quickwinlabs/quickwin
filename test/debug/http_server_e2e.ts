import '../../lib/fetch.js'
import { createServer } from '../../lib/http-server.js'
import * as std from 'std'

const server = createServer(async (req) => {
    const url = new URL(req.url)
    if (url.pathname === '/echo') {
        return new Response(
            JSON.stringify({ method: req.method, path: url.pathname, body: await req.text(), q: Object.fromEntries(url.searchParams) }),
            { headers: { 'Content-Type': 'application/json' } }
        )
    }
    return new Response('hello from quickwin http-server', { headers: { 'Content-Type': 'text/plain' } })
})
const rc = server.listen(0, '127.0.0.1')
if (rc !== 0) { console.log('listen failed'); std.exit(1) }
const addr = server.address()
const port = addr!.port
console.log('server on port', port)

async function main(): Promise<void> {
    const r1 = await fetch(`http://127.0.0.1:${port}/`)
    console.log('GET / status', r1.status, 'body:', await r1.text())

    const r2 = await fetch(`http://127.0.0.1:${port}/echo?x=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'hello-body',
    })
    console.log('POST /echo status', r2.status, 'body:', await r2.text())
    server.close()
    std.exit(0)
}
main()
