import * as std from 'std'
import * as os from 'os'
import { Tester } from './test_helper.js'

function getCacheDir(): string {
    // import.meta.url: file:///C:/.../_build/test/file.js
    const url = import.meta.url
    // Strip file:// (7 chars), giving /C:/.../
    let path = url.slice(7)
    // Remove leading / before drive letter
    if (path.length >= 3 && path[1] === ':') path = path.slice(1)
    // path now: C:/Users/Docker/quickwin/_build/test/file.js
    // Go up to _build/
    const idx = path.lastIndexOf('/')
    if (idx < 0) return '_cache'
    const buildDir = path.slice(0, idx) // .../_build/test
    const idx2 = buildDir.lastIndexOf('/')
    if (idx2 < 0) return '_cache'
    return buildDir.slice(0, idx2 + 1) + '_cache' // .../_build/_cache
}

export const suite = {
    name: 'http-import',
    run: async (t: Tester) => {
        function assert(name: string, ok: boolean): void {
            if (ok) { t.ok++; std.printf('  PASS: %s\n', name) }
            else { t.fail++; std.printf('  FAIL: %s\n', name) }
        }

        const url = 'https://esm.sh/left-pad@1.3.0'
        const cacheDir = getCacheDir()

        t.section('list cache before')
        const [before, err] = os.readdir(cacheDir)
        if (err !== 0) {
            std.printf('  cache dir: %s (error %d, will be created on first request)\n', cacheDir, err)
        }
        const beforeCount = err === 0 ? before.length : 0

        t.section('import module')
        let mod: any
        try {
            mod = await import(url)
        } catch (e) {
            assert('import succeeds', false)
            std.printf('  ERROR: %s\n', String(e))
            return
        }
        assert('import succeeds', true)
        assert('default is function', typeof mod.default === 'function')
        assert('left-pad works', mod.default('hello', 8) === '   hello')

        t.section('check cache')
        const [after, err2] = os.readdir(cacheDir)
        assert('cache dir readable', err2 === 0)
        if (err2 !== 0) return
        assert('cache has body files', after.some(function(f: string) { return f.endsWith('.body') }))
        assert('cache has meta files', after.some(function(f: string) { return f.endsWith('.meta') }))
        for (const f of after) {
            if (f.endsWith('.meta') && (err !== 0 || before.indexOf(f) < 0)) {
                std.printf('  meta: %s\n', f)
                const fp = std.open(cacheDir + '/' + f, 'r')
                if (fp) {
                    const metaStr = fp.readAsString()
                    fp.close()
                    if (metaStr) {
                        const meta = JSON.parse(metaStr)
                        std.printf('    storedAt: %d, maxAge: %d\n', meta.storedAt, meta.maxAge)
                    }
                }
            }
        }
    }
}
