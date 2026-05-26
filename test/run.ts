import * as std from 'std'
import { Tester } from './test_helper.js'

declare var scriptArgs: string[]

function formatDuration(ms: number): string {
    if (ms >= 1000) return (ms / 1000).toFixed(2) + 's'
    return ms + 'ms'
}

const BOLD  = '\x1b[1m'
const GREEN = '\x1b[32m'
const RED   = '\x1b[31m'
const RESET = '\x1b[0m'

const suiteDefs = [
    { name: 'basic',             file: './test_basic.js',            tags: [] },
    { name: 'url',               file: './test_url.js',              tags: [] },
    { name: 'wasm-basic',        file: './test_wasm_basic.js',       tags: ['wasm'] },
    { name: 'wasm-types',        file: './test_wasm_types.js',       tags: ['wasm'] },
    { name: 'wasm-import-global', file: './test_wasm_import_global.js', tags: ['wasm'] },
    { name: 'wasm-sjlj',          file: './test_wasm_sjlj.js',       tags: ['wasm'] },
    { name: 'wasm-frame-encoding', file: './test_frame_encoding.js', tags: ['wasm'] },
    { name: 'mupdf-wasm',        file: './test_mupdf_wasm.js',       tags: ['wasm', 'mupdf'] },
    { name: 'mupdf-twice',       file: './test_mupdf_twice.js',      tags: ['wasm', 'mupdf'] },
    { name: 'mupdf-render',      file: './test_mupdf_render.js',     tags: ['wasm', 'mupdf'] },
    { name: 'ffi',               file: './test_ffi.js',              tags: [] },
    { name: 'net-fetch',         file: './test_net_fetch.js',        tags: ['net'] },
    { name: 'net-websocket',     file: './test_net_websocket.js',    tags: ['net'] },
    { name: 'net-event',         file: './test_net_event.js',        tags: ['net'] },
    { name: 'http-import',       file: './test_http_import.js',      tags: ['net'] },
    { name: 'fetch-cache',       file: './test_fetch_cache.js',      tags: ['net'] },
    { name: 'polyfill',          file: './test_polyfill.js',         tags: [] },
    { name: 'brotli',            file: './test_brotli.js',           tags: [] },
    { name: 'preact-ref',        file: './test_preact_ref.js',       tags: [] },
    { name: 'components',        file: './test_components.js',       tags: [] },
]

async function main(): Promise<void> {
    const filter = scriptArgs.length > 1 ? scriptArgs[1] : ''

    std.printf('%s====== QuickWin Test Runner ======%s\n', BOLD, RESET)
    if (filter) std.printf('Filter: %s\n', filter)

    const results: { name: string, ok: number, fail: number, elapsed: number }[] = []
    let totalOk = 0, totalFail = 0

    for (const def of suiteDefs) {
        if (filter) {
            if (filter.startsWith('-')) {
                const excludeTag = filter.slice(1)
                if (def.tags.indexOf(excludeTag) >= 0) continue
            } else {
                if (def.name.indexOf(filter) < 0) continue
            }
        }

        let mod: any
        try {
            mod = await import(def.file)
        } catch (e) {
            continue
        }
        if (!mod.suite) continue

        const t = new Tester()
        std.printf('\n%s--- %s ---%s\n', BOLD, def.name, RESET)
        const suiteStart = Date.now()
        try {
            await mod.suite.run(t)
        } catch (e) {
            std.printf('  %sSUITE FAILED:%s %s\n', RED, RESET, String(e))
            t.fail++
        }
        const suiteElapsed = Date.now() - suiteStart
        t.summary()
        results.push({ name: def.name, ok: t.ok, fail: t.fail, elapsed: suiteElapsed })
        totalOk += t.ok
        totalFail += t.fail
    }

    const color = totalFail > 0 ? RED : GREEN
    std.printf('\n%s====== Test Results ======%s\n', BOLD, RESET)
    for (const r of results) {
        const c = r.fail > 0 ? RED : GREEN
        std.printf('  %s%-18s %s%d/%d passed  %s(%s)%s\n', c, r.name, RESET, r.ok, r.ok + r.fail, c, formatDuration(r.elapsed), RESET)
    }
    std.printf('%s====== Summary: %d/%d passed ======%s\n', color, totalOk, totalOk + totalFail, RESET)
    if (totalFail > 0) std.exit(1)
}

main()
