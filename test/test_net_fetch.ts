import '../lib/fetch.js'
import * as std from 'std'
import * as os from 'os'
import { Tester } from './test_helper.js'

export const suite = {
    name: 'net-fetch',
    run: async (t: Tester) => {
        function assert(name: string, ok: boolean): void {
            if (ok) { t.ok++; std.printf('  PASS: %s\n', name) }
            else { t.fail++; std.printf('  FAIL: %s\n', name) }
        }

        // Retry: public-site reachability (baidu/jsdelivr/esm.sh) depends on
        // CI network conditions, and a single dropped connection must not be
        // reported as a certificate regression. The last error is printed so a
        // real failure is still diagnosable.
        async function safeFetch(url: any, init?: RequestInit) {
            let last = 'unknown'
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    return await fetch(url, init)
                } catch (e) {
                    last = String((e as Error)?.message || e)
                    if (attempt < 2) os.sleep(500)
                }
            }
            std.printf('    fetch %s failed after 3 attempts: %s\n', String(url), last)
            return null
        }
        const BASE = 'http://localhost:18923'

        // ── Plain HTTP GET (regression: slot 0 + !s bug) ──
        t.section('plain HTTP')
        const r0 = await safeFetch(BASE + '/', { timeout: 5000 })
        if (r0) {
            assert('plain HTTP status 200', r0.status === 200)
            const body = await r0.text()
            assert('plain HTTP body non-empty', body.length > 0)
            assert('plain HTTP body matches', body === 'hello from test server')
        } else {
            assert('plain HTTP endpoint reachable', false)
        }

        // ── Basic HTTP GET ──
        t.section('HTTP GET')
        const r1 = await safeFetch(BASE + '/any')
        if (r1) {
            assert('status received', r1.status > 0)
            const body = await r1.text()
            assert('body received', body.length > 0)
        } else {
            assert('local server reachable', false)
        }

        // ── Query string ──
        t.section('query string')
        const rq = await safeFetch(BASE + '/any?foo=bar&baz=42')
        if (rq) {
            const body = JSON.parse(await rq.text())
            assert('query args received', body.args !== undefined)
            assert('?foo=bar preserved', body.args.foo === 'bar')
            assert('?baz=42 preserved', body.args.baz === '42')
        } else {
            assert('query string endpoint reachable', false)
        }

        // ── Request constructor ──
        t.section('Request constructor')
        {
            const r = new Request('https://httpbun.com/any?x=1&y=2', { method: 'POST', headers: { 'X-Test': 'val' }, body: 'hello' })
            assert('Request.url', r.url === 'https://httpbun.com/any?x=1&y=2')
            assert('Request.method', r.method === 'POST')
            assert('Request.headers get', r.headers.get('x-test') === 'val')
            assert('Request.body is ReadableStream', r.body !== null && typeof r.body.getReader === 'function')
        }
        {
            const r1 = new Request('https://example.com/path')
            assert('Request default method GET', r1.method === 'GET')
            assert('Request default redirect follow', r1.redirect === 'follow')
        }
        {
            const r2 = new Request('https://httpbun.com/any')
            const r3 = new Request(r2, { method: 'PUT' })
            assert('Request clone same url', r3.url === r2.url)
            assert('Request clone override method', r3.method === 'PUT')
        }
        {
            const r = await safeFetch(new Request(BASE + '/any', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'req-class' }))
            if (r) {
                const body = JSON.parse(await r.text())
                assert('fetch(Request) status', r.status > 0)
                assert('fetch(Request) method POST', body.method === 'POST')
                assert('fetch(Request) body received', body.data === 'req-class')
                assert('fetch(Request) content-type', body.headers['content-type'] === 'text/plain')
            } else {
                assert('fetch(Request) endpoint reachable', false)
            }
        }

        // ── body / bodyUsed / stream ──
        t.section('body / bodyUsed / stream')
        const r2 = await safeFetch(BASE + '/any')
        if (r2) {
            assert('r.body exists', typeof r2.body === 'object' && r2.body !== null)
            assert('bodyUsed false before read', r2.bodyUsed === false)

            const reader = r2.body!.getReader()
            let total = 0
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                total += value.length
            }
            assert('reader streams all bytes', total > 0)
            assert('bodyUsed true after stream', r2.bodyUsed === true)
        } else {
            assert('body test endpoint reachable', false)
        }

        // ── text/json/arrayBuffer ──
        t.section('text / json / arrayBuffer')
        const r3 = await safeFetch(BASE + '/any')
        if (r3) {
            const text = await r3.text()
            assert('text() returns string', typeof text === 'string' && text.length > 0)
            assert('bodyUsed true after text()', r3.bodyUsed === true)

            const r4 = await safeFetch(BASE + '/any')
            if (r4) {
                const buf = await r4.arrayBuffer()
                assert('arrayBuffer() returns bytes', buf.byteLength > 0)
            }
        } else {
            assert('text/json/ab endpoint reachable', false)
        }

        // double text() throws
        t.section('bodyUsed throws')
        const r5 = await safeFetch(BASE + '/any')
        if (r5) {
            await r5.text()
            try { await r5.text(); assert('double text() throws', false) }
            catch (e: unknown) { assert('double text() throws TypeError', (e as Error).message === 'Body already used') }
        }

        // ── POST ──
        t.section('POST')
        const r6 = await safeFetch(BASE + '/any', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ msg: 'hello' })
        })
        if (r6) {
            const body = await r6.text()
            assert('POST body received', body.length > 0)
        } else {
            assert('POST endpoint reachable', false)
        }

        // ── Headers (local, no network) ──
        t.section('Headers (local)')
        const h = new Headers({ 'Content-Type': 'text/html', 'X-Custom': 'hello', 'Accept': '*/*' })
        let c = 0
        for (const [k, v] of h) { c++; if (typeof k !== 'string' || typeof v !== 'string') assert('for...of type', false) }
        assert('for...of yields entries', c === 3)
        assert('get()', h.get('content-type') === 'text/html')
        assert('get() case-insensitive', h.get('Content-Type') === 'text/html')
        assert('has()', h.has('x-custom'))
        assert('set() overwrites', (h.set('accept', 'application/json'), h.get('accept') === 'application/json'))
        assert('append() adds', (h.append('accept', 'text/plain'), h.get('accept') === 'application/json, text/plain'))
        assert('delete()', (h.delete('accept'), h.has('accept') === false))

        const h2 = new Headers({ 'a': '1', 'b': '2' })
        let ec = 0; for (const _ of h2.entries()) { ec++ }
        assert('entries()', ec === 2)
        let kc = 0; for (const _ of h2.keys()) { kc++ }
        assert('keys()', kc === 2)
        let vc = 0; for (const _ of h2.values()) { vc++ }
        assert('values()', vc === 2)

        // ── Chunked Transfer-Encoding ──
        t.section('chunked transfer encoding')
        const r8 = await safeFetch(BASE + '/anything')
        if (r8) {
            assert('chunked status 200', r8.status === 200)
            const body = await r8.json<{ url: string }>()
            assert('chunked json has url', typeof body.url === 'string' && body.url.length > 0)
        } else {
            assert('local server reachable', false)
        }

        // ── stream cancel ──
        t.section('stream cancel')
        const r7 = await safeFetch(BASE + '/any')
        if (r7) {
            r7.body!.cancel()
            assert('cancel() succeeds', true)
            // After cancel: buffered chunks still readable, then done
            const reader = r7.body!.getReader()
            let finalDone = false
            while (true) {
                const { done } = await reader.read()
                if (done) { finalDone = true; break }
            }
            assert('reader done after cancel', finalDone === true)
        } else {
            assert('cancel test endpoint reachable', false)
        }

        // ── UTF-8 Chinese text body ──
        t.section('utf-8 chinese text')
        const r9 = await safeFetch(BASE + '/base64/5Lit5paH')
        if (r9) {
            assert('chinese status 200', r9.status === 200)
            const body = await r9.text()
            assert('chinese body is 中文', body === '\u4e2d\u6587')
            assert('chinese body length=2', body.length === 2)
        } else {
            assert('local server reachable', false)
        }

        // ── POST with Chinese body ──
        t.section('post with chinese body')
        const r10 = await safeFetch(BASE + '/post', {
            method: 'POST',
            body: '\u4e2d\u6587',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        })
        if (r10) {
            assert('post status 200', r10.status === 200)
            const body = await r10.text()
            assert('post body contains 中文', body.includes('\u4e2d\u6587'))
        } else {
            assert('local server reachable', false)
        }

        // ── HTTPS fetch ──
        t.section('HTTPS fetch')
        const r11 = await safeFetch('https://localhost:18924/', { timeout: 5000, rejectUnauthorized: false })
        if (r11) {
            assert('https status 200', r11.status === 200)
            const body = await r11.text()
            assert('https body matches', body === 'hello from test server')
        } else {
            assert('https endpoint reachable', false)
        }

        // ── GlobalSign R3 root chain (regression: ASN_SIG_CONFIRM_E -155) ──
        // baidu.com and jsdelivr terminate in GlobalSign's 2018 re-keyed R3,
        // which reuses the self-signed R3's subject-key-identifier with a
        // different public key. Shipping the self-signed R3 in lib/certs.ts
        // made wolfSSL match the wrong key and fail the handshake with -155.
        // Both are public CDNs: a 500/429 or a dropped connection then counts
        // as a retried attempt, not an immediate failure — only a persistent
        // failure (cert regression or long-lived outage) should fail CI.
        t.section('GlobalSign R3 root chain')
        {
            async function fetchR3(url: any): Promise<string | null> {
                const init = { timeout: 10000 }
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        const r = await fetch(url, init)
                        const body = await r.text()
                        if (r.status === 200 && body.length > 0) return body
                        std.printf('    fetch %s status=%s len=%d (attempt %d)\n',
                            String(url), String(r.status), body.length, attempt)
                    } catch (e) {
                        std.printf('    fetch %s error: %s (attempt %d)\n',
                            String(url), String((e as Error)?.message || e), attempt)
                    }
                    os.sleep(1000)
                }
                return null
            }

            const bb = await fetchR3('https://www.baidu.com/')
            if (bb) {
                assert('baidu (GlobalSign R3) status', true)
                assert('baidu (GlobalSign R3) body non-empty', bb.length > 0)
            } else {
                assert('baidu (GlobalSign R3) reachable', false)
            }

            const JSDELIVR_HOSTS = ['cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'gcore.jsdelivr.net']
            for (const host of JSDELIVR_HOSTS) {
                const bj = await fetchR3('https://' + host + '/npm/left-pad@1.3.0')
                if (bj) {
                    assert('jsdelivr (GlobalSign R3) status', true)
                    assert('jsdelivr (GlobalSign R3) body non-empty', bj.length > 0)
                    break
                }
                if (host !== JSDELIVR_HOSTS[JSDELIVR_HOSTS.length - 1]) {
                    std.printf('    jsdelivr host %s failed, trying next\n', host)
                } else {
                    assert('jsdelivr (GlobalSign R3) reachable', false)
                }
            }
        }

        // ── large HTTPS body (wolfSSL_read int contract) ──
        // read returns the raw int; -1/WANT_READ must never leak into
        // byte accounting (regression: a leaked -1 made receivedBytes
        // NaN → stream never closed → hang).
        t.section('large HTTPS body')
        {
            const LARGE = 200000
            try {
                const r = await Promise.race([
                    fetch(`https://localhost:18924/large/${LARGE}`, { timeout: 15000, rejectUnauthorized: false }),
                    new Promise<never>((_, rej) =>
                        os.setTimeout(() => rej(new Error('Body hang watchdog 15s')), 15000)
                    )
                ])
                assert('large HTTPS status 200', r.status === 200)
                const buf = await Promise.race([
                    r.arrayBuffer(),
                    new Promise<never>((_, rej) =>
                        os.setTimeout(() => rej(new Error('arrayBuffer hang watchdog 15s')), 15000)
                    )
                ])
                assert('large HTTPS byteLength exact', buf.byteLength === LARGE)
            } catch (e: unknown) {
                assert('large HTTPS completed without hang (' + String((e as Error).message) + ')', false)
            }
        }

        // ── large HTTP body (sock.recv path same null contract) ──
        t.section('large HTTP body')
        {
            const LARGE = 200000
            try {
                const r = await Promise.race([
                    fetch(`http://localhost:18923/large/${LARGE}`, { timeout: 15000 }),
                    new Promise<never>((_, rej) =>
                        os.setTimeout(() => rej(new Error('Body hang watchdog 15s')), 15000)
                    )
                ])
                assert('large HTTP status 200', r.status === 200)
                const buf = await Promise.race([
                    r.arrayBuffer(),
                    new Promise<never>((_, rej) =>
                        os.setTimeout(() => rej(new Error('arrayBuffer hang watchdog 15s')), 15000)
                    )
                ])
                assert('large HTTP byteLength exact', buf.byteLength === LARGE)
            } catch (e: unknown) {
                assert('large HTTP completed (' + String((e as Error).message) + ')', false)
            }
        }

        // ── body timeout after headers (armTimeout after doResolve) ──
        t.section('HTTPS body timeout')
        {
            let rejected = false
            let msg = ''
            try {
                const r = await fetch('https://localhost:18924/stall', { timeout: 2000, rejectUnauthorized: false })
                await Promise.race([
                    r.arrayBuffer(),
                    new Promise<never>((_, rej) =>
                        os.setTimeout(() => rej(new Error('Body timeout')), 8000)
                    )
                ])
            } catch (e: unknown) {
                rejected = true
                msg = String((e as Error).message)
            }
            assert('stall body rejects (timeout)', rejected)
            assert('stall error mentions timeout', /timeout/i.test(msg))
        }
    }
}
