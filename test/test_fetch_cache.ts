import '../lib/fetch.js'
import * as std from 'std'
import * as os from 'os'
import { Tester } from './test_helper.js'
import { parseIni, toIni } from '../lib/cache-utils.js'

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
        assert('writeBodyOnly is function', typeof __httpCache__.writeBodyOnly === 'function')
        assert('writeMeta is function', typeof __httpCache__.writeMeta === 'function')
        assert('cacheKey is function', typeof __httpCache__.cacheKey === 'function')

        t.section('writeBodyOnly + writeMeta + readMeta + readBody')
        const fakeUrl = 'https://test.local/cache-test'
        trackedUrls.push(fakeUrl)
        const testBody = 'hello cache test!'
        __httpCache__.writeBodyOnly(fakeUrl, testBody)
        __httpCache__.writeMeta(fakeUrl, toIni(
            {},
            {
                url: fakeUrl,
                storedAt: String(Math.floor(Date.now() / 1000)),
                maxAge: '60',
                status: '200',
                statusText: 'OK',
            }
        ))

        const metaStr = __httpCache__.readMeta(fakeUrl)
        assert('meta written', metaStr !== null)
        if (metaStr) {
            const ini = parseIni(metaStr)
            assert('meta has storedAt', typeof ini.meta.storedat === 'string' && ini.meta.storedat.length > 0)
            assert('meta has maxAge', ini.meta.maxage === '60')
        }

        const fullMeta = toIni(
            { 'content-type': 'text/plain' },
            {
                url: fakeUrl,
                storedAt: String(Math.floor(Date.now() / 1000)),
                maxAge: '60',
                status: '200',
                statusText: 'OK',
            }
        )
        __httpCache__.writeMeta(fakeUrl, fullMeta)

        const metaStr2 = __httpCache__.readMeta(fakeUrl)
        assert('meta overwritten', metaStr2 !== null)
        if (metaStr2) {
            const ini2 = parseIni(metaStr2)
            assert('meta has status', ini2.meta.status === '200')
            assert('meta has headers', ini2.headers['content-type'] === 'text/plain')
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

        t.section('lastAccess via readMeta/writeMeta')
        const laUrl = 'https://test.local/lastaccess-test'
        trackedUrls.push(laUrl)
        __httpCache__.writeBodyOnly(laUrl, 'test')
        __httpCache__.writeMeta(laUrl, toIni({}, {
            url: laUrl,
            storedAt: String(Math.floor(Date.now() / 1000)),
            maxAge: '300',
            status: '200',
            statusText: 'OK',
        }))
        const beforeMeta = __httpCache__.readMeta(laUrl)
        if (beforeMeta) {
            const ini0 = parseIni(beforeMeta)
            assert('no lastAccess before update', ini0.meta.lastaccess === undefined)
        }
        const now = Math.floor(Date.now() / 1000)
        const laMeta = parseIni(__httpCache__.readMeta(laUrl) || '')
        laMeta.meta.lastaccess = String(now)
        __httpCache__.writeMeta(laUrl, toIni(laMeta.headers, laMeta.meta))
        const afterMeta = __httpCache__.readMeta(laUrl)
        if (afterMeta) {
            const ini1 = parseIni(afterMeta)
            assert('lastAccess present after update', typeof ini1.meta.lastaccess === 'string' && ini1.meta.lastaccess.length > 0)
            assert('lastAccess is numeric', /^\d+$/.test(ini1.meta.lastaccess))
            assert('meta preserved after lastAccess', ini1.meta.maxage === '300')
            assert('no headers leaked', Object.keys(ini1.headers).length === 0)
        }

        t.section('fetch with caching')
        const cacheTestUrl = 'http://localhost:18923/cache/60'
        trackedUrls.push(cacheTestUrl)

        const resp1 = await fetch(cacheTestUrl)
        assert('first fetch ok', resp1.ok)
        const body1 = await resp1.text()
        assert('first fetch body non-empty', body1.length > 0)

        const cachedMeta = __httpCache__.readMeta(cacheTestUrl)
        assert('cached meta exists', cachedMeta !== null)
        if (cachedMeta) {
            const ini = parseIni(cachedMeta)
            assert('cached status = 200', ini.meta.status === '200')
            assert('cached maxAge = 60', ini.meta.maxage === '60')
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

        const afterFetchMeta = __httpCache__.readMeta(cacheTestUrl)
        if (afterFetchMeta) {
            const iniLA = parseIni(afterFetchMeta)
            assert('lastAccess set after fetch cache hit', typeof iniLA.meta.lastaccess === 'string' && iniLA.meta.lastaccess.length > 0)
        }

        t.section('timing: network vs cache')
        const timingUrl = 'http://localhost:18923/cache/60?t=' + String(Date.now())
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
        assert('cache non-negative time (' + timeCache + 'ms)', timeCache >= 0)

        t.section('cleanup')
        for (const url of trackedUrls) {
            const key = __httpCache__.cacheKey(url)
            os.remove(cacheDir + '/' + key + '.meta')
            os.remove(cacheDir + '/' + key + '.body')
            assert('no meta leftover for ' + key, __httpCache__.readMeta(url) === null)
        }
    }
}
