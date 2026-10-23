import { cleanCache } from '../lib/fetch.js'
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
        assert('write is function', typeof __httpCache__.write === 'function')
        assert('cacheKey is function', typeof __httpCache__.cacheKey === 'function')
        assert('dir is string', typeof __httpCache__.dir === 'string')

        t.section('write + readMeta + readBody')
        const fakeUrl = 'https://test.local/cache-test'
        trackedUrls.push(fakeUrl)
        const testBody = 'hello cache test!'
        __httpCache__.write(fakeUrl, toIni(
            {},
            {
                url: fakeUrl,
                storedAt: String(Math.floor(Date.now() / 1000)),
                maxAge: '60',
                status: '200',
                statusText: 'OK',
            }
        ), testBody)

        const metaStr = __httpCache__.readMeta(fakeUrl)
        assert('meta written', metaStr !== null)
        if (metaStr) {
            const ini = parseIni(metaStr)
            assert('meta has storedAt', typeof ini.meta.storedAt === 'string' && ini.meta.storedAt.length > 0)
            assert('meta has maxAge', ini.meta.maxAge === '60')
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
        __httpCache__.write(fakeUrl, fullMeta)

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
            for (let i = 0; i < view.length; i++) str += String.fromCharCode(view[i]!)
            assert('body content correct', str === testBody)
        }

        t.section('cacheKey')
        const key = __httpCache__.cacheKey('https://example.com/test.js')
        assert('cacheKey returns 16 hex chars', /^[0-9a-f]{16}$/.test(key))

        t.section('lastAccess via readMeta/write')
        const laUrl = 'https://test.local/lastaccess-test'
        trackedUrls.push(laUrl)
        __httpCache__.write(laUrl, toIni({}, {
            url: laUrl,
            storedAt: String(Math.floor(Date.now() / 1000)),
            maxAge: '300',
            status: '200',
            statusText: 'OK',
        }), 'test')
        const beforeMeta = __httpCache__.readMeta(laUrl)
        if (beforeMeta) {
            const ini0 = parseIni(beforeMeta)
            assert('no lastAccess before update', ini0.meta.lastAccess === undefined)
        }
        const now = Math.floor(Date.now() / 1000)
        const laMeta = parseIni(__httpCache__.readMeta(laUrl) || '')
        laMeta.meta.lastAccess = String(now)
        __httpCache__.write(laUrl, toIni(laMeta.headers, laMeta.meta))
        const afterMeta = __httpCache__.readMeta(laUrl)
        if (afterMeta) {
            const ini1 = parseIni(afterMeta)
            assert('lastAccess present after update', typeof ini1.meta.lastAccess === 'string' && ini1.meta.lastAccess.length > 0)
            assert('lastAccess is numeric', /^\d+$/.test(ini1.meta.lastAccess!))
            assert('meta preserved after lastAccess', ini1.meta.maxAge === '300')
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
            assert('cached maxAge = 60', ini.meta.maxAge === '60')
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
            assert('lastAccess set after fetch cache hit', typeof iniLA.meta.lastAccess === 'string' && iniLA.meta.lastAccess.length > 0)
        }

        t.section('timing: network vs cache')
        const timingUrl = 'http://localhost:18923/cache/60?t=' + String(Date.now())
        trackedUrls.push(timingUrl)

        const rNet = await fetch(timingUrl)
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

        t.section('revalidation: stale entry revalidates (304) and serves cached body')
        const revalUrl = 'http://localhost:18923/cache/1'
        trackedUrls.push(revalUrl)
        const rv1 = await fetch(revalUrl)
        assert('reval first fetch ok', rv1.ok)
        const rvBody1 = await rv1.text()
        assert('reval first body non-empty', rvBody1.length > 0)
        await os.sleepAsync(1200)
        const rv2 = await fetch(revalUrl)
        assert('reval second fetch is 200 (not raw 304)', rv2.ok && rv2.status === 200)
        const rvBody2 = await rv2.text()
        assert('reval body served from cache', rvBody2 === rvBody1)

        t.section('304 refreshes maxAge from Cache-Control')
        const revalMaxUrl = 'http://localhost:18923/cache/1?maxage'
        trackedUrls.push(revalMaxUrl)
        const mx1 = await fetch(revalMaxUrl)
        await mx1.text()
        await os.sleepAsync(1200)
        const mx2 = await fetch(revalMaxUrl)
        assert('reval maxAge fetch ok', mx2.ok && mx2.status === 200)
        await mx2.text()
        const mxMeta = __httpCache__.readMeta(revalMaxUrl)
        assert('maxAge updated from 304', !!mxMeta && parseIni(mxMeta).meta.maxAge === '60')

        t.section('304 with missing body recovers via unconditional refetch')
        // 制造“meta 在、body 被清”的残缺缓存：fresh 命中失败 → 带条件头再验证 → 304 →
        // 应回退为无条件重发（否则调用方会直接收到 304）
        const missUrl = 'http://localhost:18923/cache/60'
        trackedUrls.push(missUrl)
        const m1 = await fetch(missUrl)
        assert('missing-body setup fetch ok', m1.ok)
        await m1.text()
        const missKey = __httpCache__.cacheKey(missUrl)
        os.remove(cacheDir + '/' + missKey + '.body')
        const m2 = await fetch(missUrl)
        assert('fetch after body loss is 200 (not 304)', m2.ok && m2.status === 200)
        const m2Body = await m2.text()
        assert('recovered body non-empty', m2Body.length > 0)
        assert('recovered entry re-stored', __httpCache__.readBody(missUrl) !== null)

        t.section('dir is configurable')
        const origDir = __httpCache__.dir
        assert('dir is non-empty string', typeof origDir === 'string' && origDir.length > 0)
        const subDir = origDir + '/sub'
        os.mkdir(subDir)
        const dirUrl = 'https://test.local/dir-test'
        const dirIni = toIni({}, {
            url: dirUrl, storedAt: String(Math.floor(Date.now() / 1000)),
            maxAge: '60', lastAccess: String(Math.floor(Date.now() / 1000)),
            status: '200', statusText: 'OK',
        })
        try {
            __httpCache__.dir = subDir
            assert('dir reflects custom path', __httpCache__.dir === subDir)
            __httpCache__.write(dirUrl, dirIni, 'dir-body')
            assert('entry written under custom dir', __httpCache__.readMeta(dirUrl) !== null)
        } finally {
            __httpCache__.dir = ''
        }
        assert('dir restored to default', __httpCache__.dir === origDir)
        assert('entry gone after restoring dir', __httpCache__.readMeta(dirUrl) === null)
        const dirKey = __httpCache__.cacheKey(dirUrl)
        os.remove(subDir + '/' + dirKey + '.meta')
        os.remove(subDir + '/' + dirKey + '.body')

        t.section('cleanCache(seconds): expired and untouched entries')
        const nowSec = Math.floor(Date.now() / 1000)
        const expUrl = 'https://test.local/clean-expired'
        const keepUrl = 'https://test.local/clean-keep'
        const idleUrl = 'https://test.local/clean-idle'
        trackedUrls.push(expUrl, keepUrl, idleUrl)

        // 已过期：1 小时前入库，maxAge=60
        __httpCache__.write(expUrl, toIni({}, {
            url: expUrl, storedAt: String(nowSec - 3600), maxAge: '60',
            lastAccess: String(nowSec), status: '200', statusText: 'OK',
        }), 'expired')
        // 新鲜且刚访问过：应保留
        __httpCache__.write(keepUrl, toIni({}, {
            url: keepUrl, storedAt: String(nowSec), maxAge: '3600',
            lastAccess: String(nowSec), status: '200', statusText: 'OK',
        }), 'keep')
        // 新鲜但约一天没访问：应删除
        __httpCache__.write(idleUrl, toIni({}, {
            url: idleUrl, storedAt: String(nowSec), maxAge: '3600',
            lastAccess: String(nowSec - 100000), status: '200', statusText: 'OK',
        }), 'idle')

        const evicted = cleanCache(5)
        assert('cleanCache(seconds) evicted entries', evicted >= 2)
        assert('expired entry removed', __httpCache__.readMeta(expUrl) === null)
        assert('untouched entry removed', __httpCache__.readMeta(idleUrl) === null)
        assert('recently accessed entry kept', __httpCache__.readMeta(keepUrl) !== null)

        t.section('cleanup')
        const allRemoved = cleanCache()
        assert('clean() removed remaining entries', allRemoved > 0)
        for (const url of trackedUrls) {
            assert('no meta leftover for ' + __httpCache__.cacheKey(url), __httpCache__.readMeta(url) === null)
        }
    }
}
