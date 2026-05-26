import '../lib/fetch.js'
import * as std from 'std'
import { Tester } from './test_helper.js'

export const suite = {
    name: 'net-fetch',
    run: async (t: Tester) => {
        function assert(name: string, ok: boolean): void {
            if (ok) { t.ok++; std.printf('  PASS: %s\n', name) }
            else { t.fail++; std.printf('  FAIL: %s\n', name) }
        }

        async function safeFetch(url: any, init?: RequestInit) {
            try {
                return await fetch(url, init);
            } catch {
                return null;
            }
        }
        // ── Basic HTTP GET ──
        t.section('HTTP GET')
        const r1 = await safeFetch('https://httpbin.org/anything')
        if (r1) {
            assert('status received', r1.status > 0)
            const body = await r1.text()
            assert('body received', body.length > 0)
        } else {
            assert('httpbin.org reachable', false)
        }

        // ── Query string ──
        t.section('query string')
        const rq = await safeFetch('https://httpbin.org/anything?foo=bar&baz=42')
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
            const r = new Request('https://httpbin.org/anything?x=1&y=2', { method: 'POST', headers: { 'X-Test': 'val' }, body: 'hello' })
            assert('Request.url', r.url === 'https://httpbin.org/anything?x=1&y=2')
            assert('Request.method', r.method === 'POST')
            assert('Request.headers get', r.headers.get('x-test') === 'val')
            assert('Request.body', r.body === 'hello')
        }
        {
            const r1 = new Request('https://example.com/path')
            assert('Request default method GET', r1.method === 'GET')
            assert('Request default redirect follow', r1.redirect === 'follow')
        }
        {
            const r2 = new Request('https://httpbin.org/anything')
            // clone with override
            const r3 = new Request(r2, { method: 'PUT' })
            assert('Request clone same url', r3.url === r2.url)
            assert('Request clone override method', r3.method === 'PUT')
        }
        {
            const r = await safeFetch(new Request('https://httpbin.org/anything', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'req-class' }))
            if (r) {
                const body = JSON.parse(await r.text())
                assert('fetch(Request) status', r.status > 0)
                assert('fetch(Request) method POST', body.method === 'POST')
                assert('fetch(Request) body received', body.data === 'req-class')
                assert('fetch(Request) content-type', body.headers['Content-Type'] === 'text/plain')
            } else {
                assert('fetch(Request) endpoint reachable', false)
            }
        }

        // ── body / bodyUsed / stream ──
        t.section('body / bodyUsed / stream')
        const r2 = await safeFetch('https://httpbin.org/anything')
        if (r2) {
            assert('r.body exists', typeof r2.body === 'object' && r2.body !== null)
            assert('bodyUsed false before read', r2.bodyUsed === false)

            const reader = r2.body.getReader()
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
        const r3 = await safeFetch('https://httpbin.org/anything')
        if (r3) {
            const text = await r3.text()
            assert('text() returns string', typeof text === 'string' && text.length > 0)
            assert('bodyUsed true after text()', r3.bodyUsed === true)

            const r4 = await safeFetch('https://httpbin.org/anything')
            if (r4) {
                const buf = await r4.arrayBuffer()
                assert('arrayBuffer() returns bytes', buf.byteLength > 0)
            }
        } else {
            assert('text/json/ab endpoint reachable', false)
        }

        // double text() throws
        t.section('bodyUsed throws')
        const r5 = await safeFetch('https://httpbin.org/anything')
        if (r5) {
            await r5.text()
            try { await r5.text(); assert('double text() throws', false) }
            catch (e: unknown) { assert('double text() throws TypeError', (e as Error).message === 'Body already used') }
        }

        // ── POST ──
        t.section('POST')
        const r6 = await safeFetch('https://httpbin.org/anything', {
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
        const r8 = await safeFetch('https://catfact.ninja/fact')
        if (r8) {
            assert('chunked status 200', r8.status === 200)
            const body = await r8.json()
            assert('chunked json has fact', typeof body.fact === 'string' && body.fact.length > 0)
        } else {
            assert('catfact.ninja reachable', false)
        }

        // ── stream cancel ──
        t.section('stream cancel')
        const r7 = await safeFetch('https://httpbin.org/anything')
        if (r7) {
            r7.body.cancel()
            assert('cancel() succeeds', true)
            // After cancel: buffered chunks still readable, then done
            const reader = r7.body.getReader()
            // After cancel: buffered chunks still readable, then done
            let finalDone = false
            while (true) {
                const { done } = await reader.read()
                if (done) { finalDone = true; break }
            }
            assert('reader done after cancel', finalDone === true)
        } else {
            assert('cancel test endpoint reachable', false)
        }
    }
}
