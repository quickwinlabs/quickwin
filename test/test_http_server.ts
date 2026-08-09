import './test_helper.js'
import * as std from 'std'
import * as os from 'os'
import * as sock from 'sock'
import { Tester } from './test_helper.js'
import { createServer } from '../lib/http-server.js'

// ── Minimal raw HTTP client for testing ──

function httpSend(host: string, port: number, raw: string, nResponses = 1): Promise<string> {
    return new Promise((resolve, reject) => {
        const s = sock.socket()
        if (s < 0) { reject(new Error('socket create failed')); return }
        let buf = ''
        let done = false
        const timer = os.setTimeout(() => {
            if (!done) { done = true; sock.closesocket(s); reject(new Error('timeout: ' + buf)) }
        }, 10000)
        sock.set_on_event(s, (event) => {
            if (done) return
            if (event.lNetworkEvents & sock.FdEvent.FD_CONNECT) {
                const err = event.iErrorCode[0]
                if (err !== 0) {
                    done = true
                    os.clearTimeout(timer)
                    sock.closesocket(s)
                    reject(new Error('connect error ' + err))
                    return
                }
                const bytes = new TextEncoder().encode(raw)
                sock.send(s, bytes.buffer)
            }
            if (event.lNetworkEvents & sock.FdEvent.FD_READ) {
                while (true) {
                    const d = sock.recv(s, 8192) as unknown as ArrayBuffer | number
                    if (typeof d === 'number') break
                    if (!d || d.byteLength === 0) break
                    buf += new TextDecoder().decode(new Uint8Array(d))
                }
                const count = (buf.match(/HTTP\/1\.1 /g) || []).length
                if (count >= nResponses) {
                    done = true
                    os.clearTimeout(timer)
                    sock.closesocket(s)
                    resolve(buf)
                }
            }
            if (event.lNetworkEvents & sock.FdEvent.FD_CLOSE) {
                if (!done) { done = true; os.clearTimeout(timer); sock.closesocket(s); resolve(buf) }
            }
        })
        sock.connect(s, host, port)
    })
}

// ── Test suite ──

export const suite = {
    name: 'http-server',
    run: async (t: Tester) => {
        const requests: string[] = []
        const server = createServer(async (req) => {
            const url = new URL(req.url)
            const path = url.pathname
            requests.push(req.method + ' ' + path)
            if (path === '/') {
                return new Response('hello ' + (url.searchParams.get('name') || ''), { headers: { 'Content-Type': 'text/plain' } })
            } else if (path === '/echo') {
                return new Response(req.method + ':' + await req.text(), { headers: { 'Content-Type': 'text/plain' } })
            } else if (path === '/json') {
                return new Response(JSON.stringify({ method: req.method, q: Object.fromEntries(url.searchParams) }), { headers: { 'Content-Type': 'application/json' } })
            } else {
                return new Response('not found', { status: 404 })
            }
        })

        const rc = server.listen(0, '127.0.0.1')
        t.checkTrue('listen ok', rc === 0)
        const addr = server.address()
        if (!addr) { t.check('address', 'non-null', 'null'); return }
        t.checkTrue('bound port > 0', addr.port > 0)
        const port = addr.port

        // ── GET with query ──
        t.section('GET with query')
        let r = await httpSend('127.0.0.1', port, 'GET /?name=world HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
        t.checkTrue('200 status', r.indexOf('HTTP/1.1 200') === 0)
        t.checkTrue('body = hello world', r.endsWith('hello world'))
        t.checkTrue('content-type text', r.toLowerCase().indexOf('content-type: text/plain') >= 0)

        // ── POST with body ──
        t.section('POST with body')
        r = await httpSend('127.0.0.1', port, 'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 7\r\nConnection: close\r\n\r\npayload')
        t.checkTrue('echo body', r.endsWith('POST:payload'))

        // ── POST with chunked request body ──
        t.section('chunked request body')
        const chunkedRaw = 'POST /echo HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n' +
            '3\r\nabc\r\n4\r\ndefg\r\n0\r\n\r\n'
        r = await httpSend('127.0.0.1', port, chunkedRaw)
        t.checkTrue('chunked decoded', r.endsWith('POST:abcdefg'))

        // ── 404 ──
        t.section('404')
        r = await httpSend('127.0.0.1', port, 'GET /missing HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
        t.checkTrue('404 status', r.indexOf('HTTP/1.1 404') === 0)
        t.checkTrue('404 body', r.endsWith('not found'))

        // ── HEAD (headers present, empty body) ──
        t.section('HEAD')
        r = await httpSend('127.0.0.1', port, 'HEAD / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
        t.checkTrue('HEAD 200', r.indexOf('HTTP/1.1 200') === 0)
        t.checkTrue('HEAD content-length present', r.toLowerCase().indexOf('content-length: 6') >= 0)
        const bodyIdx = r.indexOf('\r\n\r\n')
        t.checkTrue('HEAD empty body', r.slice(bodyIdx + 4).length === 0)

        // ── keep-alive: two requests on one connection ──
        t.section('keep-alive pipelining')
        const pipelined = 'GET /?name=a HTTP/1.1\r\nHost: x\r\n\r\n' +
            'GET /?name=b HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'
        r = await httpSend('127.0.0.1', port, pipelined, 2)
        t.checkTrue('two responses received', r.indexOf('hello a') >= 0 && r.indexOf('hello b') >= 0)
        t.checkTrue('connection close on last', r.toLowerCase().indexOf('connection: close') >= 0)

        // ── server received expected requests ──
        t.section('request log')
        t.check('total requests', 7, requests.length)
        t.checkTrue('saw GET /', requests.indexOf('GET /') >= 0)
        t.checkTrue('saw POST /echo', requests.indexOf('POST /echo') >= 0)

        server.close()
        t.check('closed ok', true, true)

        std.printf('  (http-server suite done, %d requests)\n', requests.length)
    },
}
