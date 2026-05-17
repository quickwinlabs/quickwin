import * as std from 'std'
import { Tester } from './test_helper.js'

declare var scriptArgs: string[]

const BOLD  = '\x1b[1m'
const GREEN = '\x1b[32m'
const RED   = '\x1b[31m'
const RESET = '\x1b[0m'

const suiteDefs = [
    { name: 'basic',             file: './test_basic.js' },
    { name: 'url',               file: './test_url.js' },
    { name: 'wasm-basic',        file: './test_wasm_basic.js' },
    { name: 'wasm-types',        file: './test_wasm_types.js' },
    { name: 'wasm-import-global', file: './test_wasm_import_global.js' },
    { name: 'wasm-sjlj',          file: './test_wasm_sjlj.js' },
    { name: 'wasm-frame-encoding', file: './test_frame_encoding.js' },
    { name: 'mupdf-wasm',        file: './test_mupdf_wasm.js' },
    { name: 'net-fetch',         file: './test_net_fetch.js' },
    { name: 'net-websocket',     file: './test_net_websocket.js' },
    { name: 'net-event',         file: './test_net_event.js' },
    { name: 'mupdf-render',      file: './test_mupdf_render.js' },
    { name: 'http-import',       file: './test_http_import.js' },
    { name: 'fetch-cache',       file: './test_fetch_cache.js' },
    { name: 'ffi',               file: './test_ffi.js' },
]

async function main(): Promise<void> {
    const filter = scriptArgs.length > 2 ? scriptArgs[2] : ''

    std.printf('%s====== QuickWin Test Runner ======%s\n', BOLD, RESET)
    if (filter) std.printf('Filter: %s\n', filter)

    const results: { name: string, ok: number, fail: number }[] = []
    let totalOk = 0, totalFail = 0

    for (const def of suiteDefs) {
        if (filter && def.name.indexOf(filter) < 0) continue

        let mod: any
        try {
            mod = await import(def.file)
        } catch (e) {
            continue
        }
        if (!mod.suite) continue

        const t = new Tester()
        std.printf('\n%s--- %s ---%s\n', BOLD, def.name, RESET)
        try {
            await mod.suite.run(t)
        } catch (e) {
            std.printf('  %sSUITE FAILED:%s %s\n', RED, RESET, String(e))
            t.fail++
        }
        t.summary()
        results.push({ name: def.name, ok: t.ok, fail: t.fail })
        totalOk += t.ok
        totalFail += t.fail
    }

    const color = totalFail > 0 ? RED : GREEN
    std.printf('\n%s====== Test Results ======%s\n', BOLD, RESET)
    for (const r of results) {
        const c = r.fail > 0 ? RED : GREEN
        std.printf('  %s%-18s %s%d/%d passed%s\n', c, r.name, RESET, r.ok, r.ok + r.fail, c)
    }
    std.printf('%s====== Summary: %d/%d passed ======%s\n', color, totalOk, totalOk + totalFail, RESET)
    if (totalFail > 0) std.exit(1)
}

main()
