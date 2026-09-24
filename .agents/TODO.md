# TODO

## 高优先级
- [x] Fix C-level chunked encoding (`http_get_sync`/`read_http_response` hangs with Cloudflare)
- [ ] Fix Worker thread safety — 已搁置在 `worker-locks` 分支（`6fa63e4`）。需将 CRITICAL_SECTION 初始化移到 `main.c`，去掉 `g_*_lock_init` 静态标记
- [x] Fix cache bug: conditional request 200 doesn't update cache (`lib/fetch.ts:838`)

## 中优先级
- [x] Fix `test_ffi.ts` 32-bit PRINTER_INFO_2 layout — `structSize` 硬编码 136（x64），ia32 应为 **84**（非 80；MinGW 实测 sizeof=84 name=4 port=12 drv=16 comment=20 location=24 status=72）。已按 `os.arch` 分支 structSize/偏移，`readPtr` ia32 只读 4 字节，`decodeWideAtPtr` 加 4096 WCHAR 上限防越界死循环（详见 `.agents/QEMU_NET_SUITE_TEST.md`）
- [ ] `test_url.ts` import cleanup: direct `import '../lib/url.js'` instead of polyfill
- [ ] `test_fetch_wasm.ts`: integrate into Makefile or remove
- [ ] Add `"type": "module"` to `package.json` to suppress Node.js warning

## 低优先级
- [ ] 系统性优化 FFI：评估移除 libffi 依赖；定义一层 JS API 简化调用（签名/类型/ABI 声明一次，隐藏 `ffiCall` 参数类型数组与 ia32/x64 句柄宽度差异；`FFI_DEFAULT_ABI` vs WinAPI stdcall；清理各处手写 `FFI_TYPE_UINT64` 句柄误用——`ListView.tsx`、`pdf_preview2.ts`、`PdfCanvas.tsx`、`PathPicker.tsx` 等）。动机：`text-measure` XP 宽度 bug + 调用样板过重
- [ ] `_PreloadedStream` optimization: `slice()` → `subarray()`
- [ ] Add protocol whitelist for `fetch()`
- [ ] `exec_server` 流式输出：当前三层全缓冲（worker `readBytes` 读到 EOF 一次 `postMessage` → `runInWorker` 等完整 `out` → `http-server.sendResponse` `_readStream` + `Content-Length` 一次 `queueSend`），命令跑完客户端才收到 body。要做流式需：(1) worker 分块 `postMessage({type:'chunk'})` + 结束 `result`；(2) `/exec` 用 `ReadableStream` 构造 Response；(3) `sendResponse` 支持 chunked 响应（先 headers 再多次 `sock.send`，EOF `0\r\n\r\n`）——`chunked` 目前只解析请求 body；(4) 中途断开/超时/worker 挂收尾；(5) `http_test.sh` 回归。文件：`examples/exec_server.ts`、`examples/exec_server_worker.ts`、`lib/http-server.ts`（`sendResponse` ~L395）
- [ ] 研究 guest SMB 按路径缓存 `qwin*.exe` 的治本方案：覆盖写/inode 变仍跑旧映像（已实测新文件名立刻生效）。候选：`http_test.sh` 本地临时拷贝换名、`smb_wrapper` 关 oplock、guest 关客户端缓存注册表、exe hash 变自动 `--restart`。现状见 `docs/development-workflow.md` 故障表
