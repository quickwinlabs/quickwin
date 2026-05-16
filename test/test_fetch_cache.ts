import '../lib/fetch.js'
import * as std from 'std'
import * as os from 'os'
import { Tester } from './test_helper.js'

function getCacheDir(): string {
    const url = import.meta.url
    let path = url.slice(7)
    if (path.length >= 3 && path[1] === ':') path = path.slice(1)
    const idx = path.lastIndexOf('/')
    if (idx < 0) return '_cache'
    const buildDir = path.slice(0, idx)
    const idx2 = buildDir.lastIndexOf('/')
    if (idx2 < 0) return '_cache'
    return buildDir.slice(0, idx2 + 1) + '_cache'
}

export const suite = {
    name: 'fetch-cache',
    run: async (t: Tester) => {
        function assert(name: string, ok: boolean): void {
            if (ok) { t.ok++; std.printf('  PASS: %s\n', name) }
            else { t.fail++; std.printf('  FAIL: %s\n', name) }
        }

        const cacheDir = getCacheDir()
        const trackedUrls: string[] = []

        t.section('__httpCache__ API exists')
        assert('__httpCache__ is defined', typeof __httpCache__ !== 'undefined')
        if (!__httpCache__) return

        assert('readMeta is function', typeof __httpCache__.readMeta === 'function')
        assert('readBody is function', typeof __httpCache__.readBody === 'function')
        assert('writeCache is function', typeof __httpCache__.writeCache === 'function')
        assert('writeMeta is function', typeof __httpCache__.writeMeta === 'function')
        assert('cacheKey is function', typeof __httpCache__.cacheKey === 'function')

        t.section('writeCache + readMeta + readBody')
        const fakeUrl = 'https://test.local/cache-test'
        trackedUrls.push(fakeUrl)
        const testBody = 'hello cache test!'
        __httpCache__.writeCache(fakeUrl, 60, testBody)

        const metaStr = __httpCache__.readMeta(fakeUrl)
        assert('meta written', metaStr !== null)
        if (metaStr) {
            const meta = JSON.parse(metaStr)
            assert('meta has storedAt', typeof meta.storedAt === 'number')
            assert('meta has maxAge', meta.maxAge === 60)
        }

        const fullMeta = JSON.stringify({
            storedAt: Math.floor(Date.now() / 1000),
            maxAge: 60,
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'text/plain' },
        })
        __httpCache__.writeMeta(fakeUrl, fullMeta)

        const metaStr2 = __httpCache__.readMeta(fakeUrl)
        assert('meta overwritten', metaStr2 !== null)
        if (metaStr2) {
            const meta2 = JSON.parse(metaStr2)
            assert('meta has status', meta2.status === 200)
            assert('meta has headers', meta2.headers['content-type'] === 'text/plain')
        }

        const bodyAb = __httpCache__.readBody(fakeUrl)
        assert('body read as ArrayBuffer', bodyAb !== null)
        if (bodyAb) {
            const view = new Uint8Array(bodyAb)
            let str = ''
            for (let i = 0; i < view.length; i++) str += String.fromCharCode(view[i])
            assert('body content correct', str === testBody)
        }

        t.section('cacheKey')
        const key = __httpCache__.cacheKey('https://example.com/test.js')
        assert('cacheKey returns 16 hex chars', /^[0-9a-f]{16}$/.test(key))

        t.section('fetch with caching')
        const cacheTestUrl = 'https://httpbin.org/cache/60'
        trackedUrls.push(cacheTestUrl)

        const resp1 = await fetch(cacheTestUrl)
        assert('first fetch ok', resp1.ok)
        const body1 = await resp1.text()
        assert('first fetch body non-empty', body1.length > 0)

        const cachedMeta = __httpCache__.readMeta(cacheTestUrl)
        assert('cached meta exists', cachedMeta !== null)
        if (cachedMeta) {
            const m = JSON.parse(cachedMeta)
            assert('cached status = 200', m.status === 200)
            assert('cached maxAge = 60', m.maxAge === 60)
        }

        const cachedBody = __httpCache__.readBody(cacheTestUrl)
        assert('cached body exists', cachedBody !== null)
        if (cachedBody) {
            assert('cached body matches', cachedBody.byteLength > 0)
        }

        t.section('second fetch hits cache')
        const resp2 = await fetch(cacheTestUrl)
        assert('second fetch ok', resp2.ok)
        const body2 = await resp2.text()
        assert('second fetch body same length', body2.length === body1.length)

        t.section('timing: network vs cache')
        const timingUrl = 'https://httpbin.org/cache/60?t=' + String(Date.now())
        trackedUrls.push(timingUrl)

        const t0 = Date.now()
        const rNet = await fetch(timingUrl)
        const t1 = Date.now()
        const timeNet = t1 - t0
        assert('network fetch ok', rNet.ok)
        const bodyNet = await rNet.text()
        assert('network body non-empty', bodyNet.length > 0)

        const t2 = Date.now()
        const rCache = await fetch(timingUrl)
        const t3 = Date.now()
        const timeCache = t3 - t2
        assert('cache fetch ok', rCache.ok)
        const bodyCache = await rCache.text()
        assert('cache body same length', bodyCache.length === bodyNet.length)
        assert('cache faster than network (' + timeCache + 'ms vs ' + timeNet + 'ms)', timeCache < timeNet)

        t.section('cleanup')
        for (const url of trackedUrls) {
            const key = __httpCache__.cacheKey(url)
            os.remove(cacheDir + '/' + key + '.meta')
            os.remove(cacheDir + '/' + key + '.body')
            assert('no meta leftover for ' + key, __httpCache__.readMeta(url) === null)
        }
    }
}
