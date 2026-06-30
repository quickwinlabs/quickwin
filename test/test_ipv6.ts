import * as sock from 'sock'
import * as std from 'std'
import * as os from 'os'
import '../lib/fetch.js'
import '../lib/websocket.js'
import { Tester } from './test_helper.js'

const HTTP_PORT = 18923
const HTTPS_PORT = 18924

export const suite = {
    name: 'ipv6',
    run: async (t: Tester) => {
        function assert(name: string, ok: boolean): void {
            if (ok) { t.ok++; std.printf('  PASS: %s\n', name) }
            else { t.fail++; std.printf('  FAIL: %s\n', name) }
        }

        // ── 1. sock.resolve ──
        t.section('sock.resolve ::1')
        {
            const ip = sock.resolve('::1')
            assert('resolve ::1 returns ::1', ip === '::1')
        }

        // ── 2. Raw socket IPv6 ──
        t.section('raw socket ::1 HTTP GET')
        await new Promise<void>((resolve, reject) => {
            const s = sock.socket()
            if (s === null || s < 0) { t.fail++; reject(new Error('socket() failed')); return }

            let connected = false, gotData = false

            sock.set_on_event(s, (event: { lNetworkEvents: number; iErrorCode: number[] }) => {
                if (event.lNetworkEvents & sock.FdEvent.FD_CONNECT) {
                    if (event.iErrorCode[0] === 0) {
                        connected = true; t.ok++
                        const req = "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
                        const buf = new ArrayBuffer(req.length)
                        const v = new Uint8Array(buf)
                        for (let i = 0; i < req.length; i++) v[i] = req.charCodeAt(i)
                        sock.send(s, buf)
                    } else {
                        sock.closesocket(s)
                        reject(new Error('connect error: ' + event.iErrorCode[0]))
                    }
                }
                if (event.lNetworkEvents & sock.FdEvent.FD_READ && connected && !gotData) {
                    const data = sock.recv(s, 4096)
                    if (data && data.byteLength > 0) { gotData = true; t.ok++ }
                }
                if (event.lNetworkEvents & sock.FdEvent.FD_CLOSE) {
                    sock.closesocket(s)
                    if (gotData && connected) resolve()
                    else reject(new Error('test incomplete'))
                }
            })
            sock.connect(s, '::1', HTTP_PORT)
        })

        // ── 3. fetch HTTP IPv6 ──
        t.section('fetch http://[::1]')
        {
            const r = await fetch(`http://[::1]:${HTTP_PORT}/`, { timeout: 5000 })
            assert('fetch IPv6 HTTP status 200', r.status === 200)
            const body = await r.text()
            assert('fetch IPv6 HTTP body', body === 'hello from test server')
        }

        // ── 4. fetch HTTPS IPv6 ──
        t.section('fetch https://[::1]')
        {
            const r = await fetch(`https://[::1]:${HTTPS_PORT}/`, { timeout: 5000 })
            assert('fetch IPv6 HTTPS status 200', r.status === 200)
            const body = await r.text()
            assert('fetch IPv6 HTTPS body', body === 'hello from test server')
        }

        // ── 5. WebSocket IPv6 ──
        t.section('ws://[::1] echo')
        await new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(`ws://[::1]:${HTTP_PORT}/`)
            const timeoutId = os.setTimeout(() => reject(new Error('WS IPv6 timeout')), 10000)

            ws.onopen = () => {
                t.ok++
                ws.send('hello ipv6')
            }
            ws.onmessage = (evt: { data: string }) => {
                t.ok++
                assert('WS IPv6 echo matches', evt.data === 'hello ipv6')
                ws.close()
            }
            ws.onclose = () => {
                os.clearTimeout(timeoutId)
                resolve()
            }
            ws.onerror = () => {
                os.clearTimeout(timeoutId)
                reject(new Error('WS IPv6 error'))
            }
        })

        // ── 6. WebSocket WSS IPv6 ──
        t.section('wss://[::1] echo')
        await new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(`wss://[::1]:${HTTPS_PORT}/`)
            const timeoutId = os.setTimeout(() => reject(new Error('WSS IPv6 timeout')), 10000)

            ws.onopen = () => {
                t.ok++
                ws.send('hello wss ipv6')
            }
            ws.onmessage = (evt: { data: string }) => {
                t.ok++
                assert('WSS IPv6 echo matches', evt.data === 'hello wss ipv6')
                ws.close()
            }
            ws.onclose = () => {
                os.clearTimeout(timeoutId)
                resolve()
            }
            ws.onerror = () => {
                os.clearTimeout(timeoutId)
                reject(new Error('WSS IPv6 error'))
            }
        })
    }
}
