# TODO

## 高优先级
- [x] Fix C-level chunked encoding (`http_get_sync`/`read_http_response` hangs with Cloudflare)
- [ ] Fix Worker thread safety — 已搁置在 `worker-locks` 分支（`6fa63e4`）。需将 CRITICAL_SECTION 初始化移到 `main.c`，去掉 `g_*_lock_init` 静态标记
- [x] Fix cache bug: conditional request 200 doesn't update cache (`lib/fetch.ts:838`)

## 中优先级
- [ ] `test_url.ts` import cleanup: direct `import '../lib/url.js'` instead of polyfill
- [ ] `test_fetch_wasm.ts`: integrate into Makefile or remove
- [ ] Add `"type": "module"` to `package.json` to suppress Node.js warning

## 低优先级
- [ ] `_PreloadedStream` optimization: `slice()` → `subarray()`
- [ ] Add protocol whitelist for `fetch()`
