import '../lib/certs.js'
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

type Result = { name: string, ok: number, fail: number, skip: number, elapsed: number }

const suiteDefs = [
    { name: 'basic',             file: './test_basic.js',            tags: [] },
    { name: 'basic-fetch',       file: './test_basic_fetch.js',       tags: [] },
    { name: 'ipv6',              file: './test_ipv6.js',              tags: ['net'] },
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
    { name: 'ffi-bind',          file: './test_ffi_bind.js',         tags: [] },
    { name: 'ffi-struct',        file: './test_ffi_struct.js',       tags: [] },
    { name: 'ffi-struct-layout', file: './test_ffi_struct_layout.js', tags: [] },
    { name: 'ffi-array',         file: './test_ffi_array.js',         tags: [] },
    { name: 'ffi-abi',           file: './test_ffi_abi.js',          tags: [] },
    { name: 'ffi-user32',        file: './test_ffi_user32.js',       tags: [] },
    { name: 'ffi-windows',       file: './test_ffi_windows.js',      tags: [] },
    { name: 'com',               file: './test_com.js',              tags: [] },
    { name: 'gdi-draw',          file: './test_gdi_draw.js',         tags: [] },
    { name: 'registry',          file: './test_registry.js',         tags: [] },
    { name: 'files',             file: './test_files.js',            tags: [] },
    { name: 'printer',           file: './test_printer.js',          tags: [] },
    { name: 'sysinfo',           file: './test_sysinfo.js',          tags: [] },
    { name: 'proc',              file: './test_proc.js',             tags: [] },
    { name: 'net-fetch',         file: './test_net_fetch.js',        tags: ['net'] },
    { name: 'net-wolfssl-read',   file: './test_wolfssl_read.js',     tags: ['net'] },
    { name: 'net-websocket',     file: './test_net_websocket.js',    tags: ['net'] },
    { name: 'net-event',         file: './test_net_event.js',        tags: ['net'] },
    { name: 'http-server',       file: './test_http_server.js',      tags: ['net'] },
    { name: 'http-import',       file: './test_http_import.js',      tags: ['net'] },
    { name: 'fetch-cache',       file: './test_fetch_cache.js',      tags: ['net'] },
    { name: 'polyfill',          file: './test_polyfill.js',         tags: [] },
    { name: 'brotli',            file: './test_brotli.js',           tags: [] },
    { name: 'worker',            file: './test_worker.js',           tags: [] },
    { name: 'worker-wasm',       file: './test_worker_wasm_concurrent.js', tags: ['wasm'] },
    { name: 'worker-http',       file: './test_worker_net.js',       tags: ['net'] },
    { name: 'worker-fetch',      file: './test_worker_fetch.js',     tags: ['net'] },
    { name: 'worker-concurrent', file: './test_worker_concurrent.js', tags: [] },
    { name: 'worker-data-url',   file: './test_worker_data_url.js',   tags: [] }
]

// A suite that cannot even load (bad import, missing export at bind time) must
// fail: counting it as "absent" would keep the Summary green.
function pushLoadFailure(results: Result[], name: string, why: string): void {
    std.printf('\n%s--- %s ---%s\n  %sSUITE FAILED:%s %s\n', BOLD, name, RESET, RED, RESET, why)
    results.push({ name, ok: 0, fail: 1, skip: 0, elapsed: 0 })
}

async function main(): Promise<void> {
    // scriptArgs[0] is the first argument after the script slot: the runtime
    // hands over everything past `exe [flags] file` verbatim, so the script
    // name never occupies a slot (unlike stock qjs). Filter is a suite-name
    // substring, or `-tag` to exclude a tag.
    const filter = scriptArgs[0] ?? ''

    std.printf('%s====== QuickWin Test Runner ======%s\n', BOLD, RESET)
    if (filter) std.printf('Filter: %s\n', filter)

    const results: Result[] = []
    let totalOk = 0, totalFail = 0, totalSkip = 0

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
            pushLoadFailure(results, def.name, 'did not load: ' + String(e))
            totalFail++
            continue
        }
        if (!mod.suite) {
            pushLoadFailure(results, def.name, 'exports no suite')
            totalFail++
            continue
        }

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
        results.push({ name: def.name, ok: t.ok, fail: t.fail, skip: t.skip, elapsed: suiteElapsed })
        totalOk += t.ok
        totalFail += t.fail
        totalSkip += t.skip
    }

    if (results.length === 0) {
        std.printf('%sFAIL: no suite matched filter "%s"%s\n', RED, filter, RESET)
        totalFail++
    }
    const color = totalFail > 0 ? RED : GREEN
    std.printf('\n%s====== Test Results ======%s\n', BOLD, RESET)
    for (const r of results) {
        const c = r.fail > 0 ? RED : GREEN
        const skipped = r.skip > 0 ? ` (${r.skip} skipped)` : ''
        std.printf('  %s%-18s %s%d/%d passed%s  %s(%s)%s\n', c, r.name, RESET, r.ok, r.ok + r.fail, skipped, c, formatDuration(r.elapsed), RESET)
    }
    const skipped = totalSkip > 0 ? ` (${totalSkip} skipped)` : ''
    std.printf('%s====== Summary: %d/%d passed%s ======%s\n', color, totalOk, totalOk + totalFail, skipped, RESET)
}

main()
