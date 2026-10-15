// ── mupdf-wasm CDN loading ──
//
// The runtime loads mupdf from unpkg; the npm package itself only ships
// types (devDependency @quickwinlabs/mupdf-wasm resolved through the
// package's exports types mapping — no local vendor copy involved).
// MUPDF_VERSION must stay in sync with the devDependency in package.json
// when bumping.
//
// Importing this module wires up the HTTPS stack (certs + fetch): the
// wasm bytes travel through the process-wide HTTP cache next to the
// executable, so the first fetch is the only network hit.

import '../lib/certs.js'
import '../lib/fetch.js'

export const MUPDF_VERSION = '1.28.0'
const BASE = `https://unpkg.com/@quickwinlabs/mupdf-wasm@${MUPDF_VERSION}`

export const MUPDF_JS_URL = `${BASE}/mupdf.js`
export const MUPDF_WASM_URL = `${BASE}/mupdf-wasm.wasm`

/** Fetch the wasm binary over HTTPS (HTTP-cached, no filesystem involved). */
export async function fetchMupdfWasm(): Promise<ArrayBuffer> {
    const resp = await fetch(MUPDF_WASM_URL)
    if (resp.status !== 200) throw new Error(`mupdf wasm fetch failed: HTTP ${resp.status}`)
    const wasmBinary = await resp.arrayBuffer()
    if (wasmBinary.byteLength < 1_000_000) throw new Error(`mupdf wasm truncated: ${wasmBinary.byteLength} bytes`)
    return wasmBinary
}

/**
 * Fetch the wasm binary and pre-wire it as $libmupdf_wasm_Module so the
 * mupdf.js module factory instantiates from memory (same injection the
 * local-vendor loading used).
 */
export async function preloadMupdfWasm(): Promise<ArrayBuffer> {
    const wasmBinary = await fetchMupdfWasm()
    ;(globalThis as any).$libmupdf_wasm_Module = {
        wasmBinary,
        locateFile: (p: string) => p,
    }
    return wasmBinary
}
