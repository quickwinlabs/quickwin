# TODO

## 高优先级
- [x] Fix C-level chunked encoding (`http_get_sync`/`read_http_response` hangs with Cloudflare)
- [ ] Fix Worker thread safety — 已搁置在 `worker-locks` 分支（`6fa63e4`）。需将 CRITICAL_SECTION 初始化移到 `main.c`，去掉 `g_*_lock_init` 静态标记
- [x] Fix cache bug: conditional request 200 doesn't update cache (`lib/fetch.ts:838`)

## 中优先级
- [ ] Fix `test_ffi.ts` 32-bit PRINTER_INFO_2 layout — `structSize` 硬编码 136（x64），x86 应为 80；字段偏移（+8/+24/+32/+40/+48/+124）也按 64 位指针算。Win7 有真实打印机时 `decodeWideAtPtr` 读垃圾 WCHAR 指针死循环 → GC=777MB OOM（全量 427/428 唯一失败）。XP 无打印机 `needed=0` 提前 return 未触发（425/426）。需按指针宽度分支 structSize/偏移，并给 `decodeWideAtPtr` 加读长上限防越界死循环（详见 `.agents/QEMU_NET_SUITE_TEST.md`）
- [ ] `test_url.ts` import cleanup: direct `import '../lib/url.js'` instead of polyfill
- [ ] `test_fetch_wasm.ts`: integrate into Makefile or remove
- [ ] Add `"type": "module"` to `package.json` to suppress Node.js warning

## 低优先级
- [ ] `_PreloadedStream` optimization: `slice()` → `subarray()`
- [ ] Add protocol whitelist for `fetch()`
