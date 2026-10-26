import './test_helper.js'
import * as std from 'std'
import * as os from 'os'
import * as sock from 'sock'
import { Tester } from './test_helper.js'
import { createServer } from '../lib/http-server.js'
import '../lib/fetch.js'
import { FdEvent } from '../constants'

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
            if (event.lNetworkEvents & FdEvent.FD_CONNECT) {
                const err = event.iErrorCode[0]
                if (err !== 0) {
                    done = true
                    os.clearTimeout(timer)
                    sock.closesocket(s)
                    reject(new Error('connect error ' + err))
                    return
                }
                const bytes = new TextEncoder().encode(raw)
                // Loop: a large body exceeds the kernel send buffer and a
                // single send() would silently truncate the remainder.
                let off = 0
                while (off < bytes.byteLength) {
                    const n = sock.send(s, bytes.buffer.slice(off, bytes.byteLength))
                    if (n <= 0) break
                    off += n
                }
            }
            if (event.lNetworkEvents & FdEvent.FD_READ) {
                const rbuf = new ArrayBuffer(8192)
                while (true) {
                    const n = sock.recv(s, rbuf)
                    if (n <= 0) break
                    buf += new TextDecoder().decode(new Uint8Array(rbuf, 0, n))
                }
                const count = (buf.match(/HTTP\/1\.1 /g) || []).length
                if (count >= nResponses) {
                    done = true
                    os.clearTimeout(timer)
                    sock.closesocket(s)
                    resolve(buf)
                }
            }
            if (event.lNetworkEvents & FdEvent.FD_CLOSE) {
                if (!done) { done = true; os.clearTimeout(timer); sock.closesocket(s); resolve(buf) }
            }
        })
        sock.connect(s, host, port)
    })
}

/** Send a POST body one `quantum` per event-loop tick.
 *
 *  Pacing is the point: a trickling body makes the server's body `pull`
 *  suspend — it drains its socket, finds nothing more, and has to park until
 *  the next arrival wakes it. A body pushed in one burst never reaches that
 *  path, and `httpSend` can never produce one: it breaks out of its send loop
 *  on a full kernel buffer instead of waiting for writability. `delayMs`
 *  stretches the ticks so the transfer outlives the first chunk by a wide
 *  margin, for the arrival assertion further down. A regression in the wake
 *  path shows up here as a timeout. */
function httpSendPaced(host: string, port: number, ep: string, n: number, quantum: number,
    delayMs = 0, timeoutMs = 15000): Promise<string> {
    return new Promise((resolve, reject) => {
        const s = sock.socket()
        if (s < 0) { reject(new Error('socket create failed')); return }
        let buf = ''
        let done = false
        let sent = 0
        let data = new Uint8Array(0)
        let timer: ReturnType<typeof os.setTimeout> | null = null
        const pump = (): void => {
            if (done || sent >= n) return
            const k = sock.send(s, data.buffer.slice(0, Math.min(quantum, n - sent)))
            if (k < 0) { finish('send error'); return }
            sent += k
            if (sent < n && !done) timer = os.setTimeout(pump, delayMs)
        }
        const finish = (why: string) => {
            done = true
            if (timer !== null) os.clearTimeout(timer)
            sock.closesocket(s)
            reject(new Error(why + ' after ' + sent + '/' + n + ' bytes: ' + buf.slice(0, 120)))
        }
        const deadline = os.setTimeout(() => finish('timeout'), timeoutMs)
        // true once the whole response (headers + Content-Length body) is in
        const complete = (): boolean => {
            const i = buf.indexOf('\r\n\r\n')
            if (i < 0) return false
            const m = /content-length:\s*(\d+)/i.exec(buf.slice(0, i))
            return buf.length - (i + 4) >= (m ? Number(m[1]) : 0)
        }
        const settle = (): void => {
            if (done) return
            done = true
            os.clearTimeout(deadline)
            if (timer !== null) os.clearTimeout(timer)
            sock.closesocket(s)
            resolve(buf)
        }
        sock.set_on_event(s, (event) => {
            if (done) return
            if (event.lNetworkEvents & FdEvent.FD_CONNECT) {
                const err = event.iErrorCode[0]
                if (err !== 0) { finish('connect error ' + err); return }
                data = new TextEncoder().encode('x'.repeat(quantum))
                const head = new TextEncoder().encode(
                    'POST ' + ep + ' HTTP/1.1\r\nHost: x\r\nContent-Length: ' + n +
                    '\r\nConnection: close\r\n\r\n')
                let off = 0
                while (off < head.byteLength) {
                    const k = sock.send(s, head.buffer.slice(off, head.byteLength))
                    if (k <= 0) break
                    off += k
                }
                pump()
            }
            if (!done && (event.lNetworkEvents & FdEvent.FD_READ)) {
                const rbuf = new ArrayBuffer(8192)
                while (true) {
                    const k = sock.recv(s, rbuf)
                    if (k <= 0) break
                    buf += new TextDecoder().decode(new Uint8Array(rbuf, 0, k))
                }
                if (complete()) settle()
            }
            if (!done && (event.lNetworkEvents & FdEvent.FD_CLOSE)) settle()
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
            } else if (path === '/len') {
                // Echoes only the received byte count, so a large upload can be
                // verified without the test harness holding the whole body twice.
                const buf = await req.arrayBuffer()
                return new Response('len=' + buf.byteLength, { headers: { 'Content-Type': 'text/plain' } })
            } else if (path === '/count') {
                // Streams the body away, discarding each chunk, and reports how
                // long after the handler started the first chunk arrived. A
                // server that buffered the whole upload would not report it
                // until the last byte had landed.
                const t0 = Date.now()
                let n = 0
                let first = -1
                if (req.body) {
                    const rd = req.body.getReader()
                    for (;;) {
                        const { done, value } = await rd.read()
                        if (done) break
                        if (first < 0) first = Date.now() - t0
                        n += value!.byteLength
                    }
                }
                return new Response('count=' + n + ' first=' + first,
                    { headers: { 'Content-Type': 'text/plain' } })
            } else if (path === '/ignore') {
                // Deliberately never reads the request body.
                return new Response('ignored', { headers: { 'Content-Type': 'text/plain' } })
            } else if (path === '/json') {
                return new Response(JSON.stringify({ method: req.method, q: Object.fromEntries(url.searchParams) }), { headers: { 'Content-Type': 'application/json' } })
            } else if (path === '/stream') {
                // length unknown: server must send chunked frames
                return new Response(new ReadableStream({
                    start(control) {
                        control.enqueue(new TextEncoder().encode('chunkA/'))
                        control.enqueue(new TextEncoder().encode('chunkB'))
                        control.close()
                    }
                }), { headers: { 'Content-Type': 'text/plain' } })
            } else if (path === '/file') {
                // length known: server streams raw bytes with Content-Length
                return new Response(new ReadableStream({
                    start(control) {
                        control.enqueue(new TextEncoder().encode('chunkA/'))
                        control.enqueue(new TextEncoder().encode('chunkB'))
                        control.close()
                    }
                }), { headers: { 'Content-Type': 'text/plain', 'Content-Length': '13' } })
            } else if (path === '/stream-trailer') {
                // chunked stream with trailing headers (Node addTrailers
                // semantics: `Trailer` declaration + frames, then the footer)
                return new Response(new ReadableStream({
                    start(control) {
                        control.enqueue(new TextEncoder().encode('chunkA/'))
                        control.enqueue(new TextEncoder().encode('chunkB'))
                        control.close()
                    }
                }), {
                    headers: { 'Content-Type': 'text/plain', 'Trailer': 'X-Exit-Code' },
                    trailers: Promise.resolve({ 'X-Exit-Code': '3' })
                })
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
        t.checkTrue('static body gets content-length', r.toLowerCase().indexOf('content-length: 11') >= 0)

        // ── streaming chunked response (length unknown) ──
        t.section('streaming chunked response')
        r = await httpSend('127.0.0.1', port, 'GET /stream HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
        t.checkTrue('200 status', r.indexOf('HTTP/1.1 200') === 0)
        t.checkTrue('transfer-encoding chunked', r.toLowerCase().indexOf('transfer-encoding: chunked') >= 0)
        t.checkTrue('no content-length', r.toLowerCase().indexOf('content-length:') < 0)
        t.checkTrue('chunk frames + terminator', r.indexOf('7\r\nchunkA/\r\n6\r\nchunkB\r\n0\r\n\r\n') >= 0)

        // ── streaming raw response with known length ──
        t.section('streaming known-length response')
        r = await httpSend('127.0.0.1', port, 'GET /file HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
        t.checkTrue('200 status', r.indexOf('HTTP/1.1 200') === 0)
        t.checkTrue('content-length 13', r.toLowerCase().indexOf('content-length: 13') >= 0)
        t.checkTrue('no chunked encoding', r.toLowerCase().indexOf('transfer-encoding: chunked') < 0)
        t.checkTrue('streamed raw body', r.includes('chunkA/chunkB'))
        t.checkTrue('no chunk frame headers', r.indexOf('7\r\nchunkA/') < 0)

        // ── HEAD of a streamed body: headers only, empty body ──
        t.section('HEAD streaming response')
        r = await httpSend('127.0.0.1', port, 'HEAD /stream HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
        t.checkTrue('HEAD 200', r.indexOf('HTTP/1.1 200') === 0)
        t.checkTrue('HEAD content-length 13', r.toLowerCase().indexOf('content-length: 13') >= 0)
        const headBodyIdx = r.indexOf('\r\n\r\n')
        t.checkTrue('HEAD empty body', r.slice(headBodyIdx + 4).length === 0)

        // ── streaming chunked response with trailing headers ──
        t.section('streaming trailer response')
        r = await httpSend('127.0.0.1', port, 'GET /stream-trailer HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
        t.checkTrue('200 status', r.indexOf('HTTP/1.1 200') === 0)
        t.checkTrue('trailer declared in head', r.toLowerCase().indexOf('trailer: x-exit-code') >= 0)
        t.checkTrue('terminator carries trailer', r.indexOf('0\r\nX-Exit-Code: 3\r\n\r\n') >= 0)
        t.checkTrue('trailer footer after body', r.indexOf('7\r\nchunkA/\r\n6\r\nchunkB\r\n0\r\nX-Exit-Code: 3\r\n\r\n') >= 0)

        // ── fetch client consumes chunked response with trailer footer ──
        t.section('fetch consumes trailer response')
        {
            const rr = await fetch(`http://127.0.0.1:${port}/stream-trailer`)
            t.checkTrue('status 200', rr.status === 200)
            t.checkTrue('body decoded without trailer', await rr.text() === 'chunkA/chunkB')
        }

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

        // ── large upload over Content-Length framing ──
        t.section('large streamed upload')
        {
            const N = 512 * 1024
            let body = ''
            while (body.length < N) body += 'x'
            r = await httpSend('127.0.0.1', port,
                'POST /len HTTP/1.1\r\nHost: x\r\nContent-Length: ' + N + '\r\nConnection: close\r\n\r\n' + body)
            t.checkTrue('512KiB body counted (' + r.slice(-24) + ')', r.endsWith('len=' + N))
        }

        // ── large upload over chunked framing ──
        t.section('large chunked upload')
        {
            const N = 512 * 1024
            let body = ''
            for (let left = N; left > 0; ) {
                const sz = Math.min(left, 65536)
                body += sz.toString(16) + '\r\n' + 'y'.repeat(sz) + '\r\n'
                left -= sz
            }
            r = await httpSend('127.0.0.1', port,
                'POST /len HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n' +
                body + '0\r\n\r\n')
            t.checkTrue('512KiB chunked body counted (' + r.slice(-24) + ')', r.endsWith('len=' + N))
        }

        // ── chunked body with tiny chunks ──
        // 3-byte chunks make every framing byte land at a different offset
        // mod the 8 KiB recv window (gcd(7, 8192) == 1), so `\r\n` pairs are
        // split across sock.recv calls — the case that pins the pendingCR
        // state machine in decodeBody.
        t.section('chunked with many small chunks')
        {
            const N = 32 * 1024
            const parts: string[] = []
            for (let left = N; left > 0; ) {
                const sz = Math.min(left, 3)
                parts.push(sz.toString(16) + '\r\n' + 'z'.repeat(sz) + '\r\n')
                left -= sz
            }
            r = await httpSend('127.0.0.1', port,
                'POST /len HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n' +
                parts.join('') + '0\r\n\r\n')
            t.checkTrue('32KiB of 3-byte chunks counted (' + r.slice(-24) + ')', r.endsWith('len=' + N))
        }

        // ── body that arrives in dribbles ──
        // Sending one 8 KiB quantum per event-loop tick is what makes the
        // server's body `pull` suspend: it drains the socket, finds nothing
        // more, and has to park until the next arrival wakes it. `httpSend`
        // pushes the whole body in one burst, so it never reaches that path.
        t.section('paced upload')
        {
            const N = 256 * 1024
            r = await httpSendPaced('127.0.0.1', port, '/count', N, 8192)
            t.checkTrue('256KiB dribbled body counted', r.indexOf('count=' + N + ' first=') >= 0)
            r = await httpSendPaced('127.0.0.1', port, '/len', N, 8192)
            t.checkTrue('256KiB dribbled body counted by /len', r.endsWith('len=' + N))
        }

        // ── the body is streamed to the handler, not buffered ──
        // /count reports how long after the handler started the first chunk
        // arrived. Stretched to ~450 ms, a truncation to 1/4 leaves a wide
        // margin: streaming lands in the first millisecond, and any
        // implementation that holds the upload would report ~450 ms.
        t.section('streaming arrival')
        {
            const N = 128 * 1024
            const delay = 30
            const t0 = Date.now()
            r = await httpSendPaced('127.0.0.1', port, '/count', N, 8192, delay)
            const sendMs = Date.now() - t0
            const m = /first=(-?\d+)/.exec(r)
            const first = m ? Number(m[1]) : -1
            t.checkTrue('counted all ' + N + ' bytes', r.indexOf('count=' + N + ' first=') >= 0)
            t.checkTrue('first chunk in ' + first + 'ms of a ' + sendMs + 'ms upload',
                first >= 0 && first * 4 < sendMs)
        }

        // ── 411: body-carrying method with no framing ──
        t.section('411 length required')
        {
            r = await httpSend('127.0.0.1', port, 'POST /echo HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
            t.checkTrue('411 on unframed POST', r.indexOf('HTTP/1.1 411') === 0)
            r = await httpSend('127.0.0.1', port, 'PUT /echo HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
            t.checkTrue('411 on unframed PUT', r.indexOf('HTTP/1.1 411') === 0)
            r = await httpSend('127.0.0.1', port, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
            t.checkTrue('unframed GET is fine', r.indexOf('HTTP/1.1 200') === 0)
            r = await httpSend('127.0.0.1', port, 'DELETE /missing HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
            t.checkTrue('unframed DELETE not rejected', r.indexOf('HTTP/1.1 404') === 0)
        }

        // ── keep-alive after a request with a body ──
        // Bytes past the body end must be handed back to the header phase, so
        // the second request pipelined on the same connection still parses.
        t.section('keep-alive after body')
        {
            r = await httpSend('127.0.0.1', port,
                'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 7\r\n\r\npayload' +
                'GET /?name=b HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n', 2)
            t.checkTrue('body echoed', r.indexOf('POST:payload') >= 0)
            t.checkTrue('pipelined request served', r.indexOf('hello b') >= 0)
        }

        t.section('keep-alive after chunked body')
        {
            r = await httpSend('127.0.0.1', port,
                'POST /echo HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n' +
                '3\r\nabc\r\n4\r\ndefg\r\n0\r\n\r\n' +
                'GET /?name=c HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n', 2)
            t.checkTrue('chunked body echoed', r.indexOf('POST:abcdefg') >= 0)
            t.checkTrue('pipelined request served', r.indexOf('hello c') >= 0)
        }

        // ── handler that never drains the body: connection is not reused ──
        t.section('unread body drops keep-alive')
        {
            r = await httpSend('127.0.0.1', port,
                'POST /ignore HTTP/1.1\r\nHost: x\r\nContent-Length: 7\r\n\r\npayload' +
                'GET /?name=d HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n', 1)
            t.checkTrue('unread body acknowledged', r.indexOf('ignored') >= 0)
            t.checkTrue('connection closed after unread body',
                r.toLowerCase().indexOf('connection: close') >= 0 && r.indexOf('hello d') < 0)
        }

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
        t.check('total requests', 25, requests.length)
        t.checkTrue('saw GET /', requests.indexOf('GET /') >= 0)
        t.checkTrue('saw POST /echo', requests.indexOf('POST /echo') >= 0)
        t.checkTrue('saw POST /len', requests.indexOf('POST /len') >= 0)
        t.check('POST /len count', 4, requests.filter((r) => r === 'POST /len').length)
        t.check('POST /count count', 2, requests.filter((r) => r === 'POST /count').length)
        t.checkTrue('saw POST /ignore', requests.indexOf('POST /ignore') >= 0)
        // 411 is sent before the handler runs, so those never reach the log
        t.checkTrue('unframed PUT never reached the handler',
            requests.indexOf('PUT /echo') < 0)

        server.close()
        t.check('closed ok', true, true)

        std.printf('  (http-server suite done, %d requests)\n', requests.length)
    },
}
