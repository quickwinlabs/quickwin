# TODO

## 高优先级
- [x] Fix C-level chunked encoding (`http_get_sync`/`read_http_response` hangs with Cloudflare)
- [x] Fix Worker thread safety — 方案 T 已落地（sock/async state 嵌入 JSThreadState，`c929a9c`），回归 `test_worker_concurrent.ts`
- [x] Fix cache bug: conditional request 200 doesn't update cache (`lib/fetch.ts:838`)
- [x] HTTPS/wss 校验证书 — 内嵌 7 张现代根（`lib/certs.ts`）+ 进程级 8 槽追加式信任库（`quickjs-wolfssl.c`）+ 默认 `VERIFY_PEER` + 宿主名校验 + `rejectUnauthorized` 逃生门；详见 `.agents/TLS_TRUST_STORE.md`

## 中优先级
- [x] Fix `test_ffi.ts` 32-bit PRINTER_INFO_2 layout — `structSize` 硬编码 136（x64），ia32 应为 **84**（非 80；MinGW 实测 sizeof=84 name=4 port=12 drv=16 comment=20 location=24 status=72）。已按 `os.arch` 分支 structSize/偏移，`readPtr` ia32 只读 4 字节，`decodeWideAtPtr` 加 4096 WCHAR 上限防越界死循环（详见 `.agents/QEMU_NET_SUITE_TEST.md`）
- [ ] `/exec` 命令行中文 lossy：`{"cmd":"cmd.exe /c echo 你好"}` 里中文经 `CreateProcessW` 构造命令行时被替换为 `?`（ASCII `3f`），`chcp 936/65001` 均无法挽救——`cmd /c "echo %*"` 回显为 `%* ??`，证明替换发生在进 cmd **之前**（输入侧，非输出编码）。影响"下发含中文参数的命令"（`mkdir 中文目录` 等）。规避：命令保持 ASCII，中文走文件/stdin 传。**注意 guest 侧中文能力本身完好**：Tiny11 Core 25H2 实测 `qwin -e "print('中文测试')"` → `e4b8ad e69687 e6b58b e8af95`（UTF-8 正确）、`chcp 936 & type <GBK文件>` → `c4e3bac3`（GBK 正确）、CJK 字体齐全（`msyh.ttc`/`simsun.ttc`，共 337 字体），**无需**拷字体进 `C:\Windows\Fonts`
- [ ] `test_url.ts` import cleanup: direct `import '../lib/url.js'` instead of polyfill
- [ ] `test_fetch_wasm.ts`: integrate into Makefile or remove
- [ ] Add `"type": "module"` to `package.json` to suppress Node.js warning

## 低优先级
- [ ] 系统性优化 FFI：评估移除 libffi 依赖；定义一层 JS API 简化调用（签名/类型/ABI 声明一次，隐藏 `ffiCall` 参数类型数组与 ia32/x64 句柄宽度差异；`FFI_DEFAULT_ABI` vs WinAPI stdcall；清理各处手写 `FFI_TYPE_UINT64` 句柄误用——`ListView.tsx`、`pdf_preview2.ts`、`PdfCanvas.tsx`、`PathPicker.tsx` 等）。动机：`text-measure` XP 宽度 bug + 调用样板过重
- [ ] `_PreloadedStream` optimization: `slice()` → `subarray()`
- [ ] Add protocol whitelist for `fetch()`
- [ ] `exec_server` 流式输出：当前三层全缓冲（worker `readBytes` 读到 EOF 一次 `postMessage` → `runInWorker` 等完整 `out` → `http-server.sendResponse` `_readStream` + `Content-Length` 一次 `queueSend`），命令跑完客户端才收到 body。要做流式需：(1) worker 分块 `postMessage({type:'chunk'})` + 结束 `result`；(2) `/exec` 用 `ReadableStream` 构造 Response；(3) `sendResponse` 支持 chunked 响应（先 headers 再多次 `sock.send`，EOF `0\r\n\r\n`）——`chunked` 目前只解析请求 body；(4) 中途断开/超时/worker 挂收尾；(5) `http_test.sh` 回归。文件：`examples/exec_server.ts`、`examples/exec_server_worker.ts`、`lib/http-server.ts`（`sendResponse` ~L395）
- [x] guest SMB 按路径缓存 `qwin*.exe` — 服务器侧治本：`smb_wrapper.sh` 加 `oplocks = no`（禁用授予读缓存）+ `smb2 leases = no`（win7/win11）。已验证：同路径覆盖写后 guest 经 `type` 立即读到新内容（3 轮交替 MATCH）。无需 guest 注册表/换名拷贝
- [ ] main.c js_file 探测把"空格分隔值"的裸值误当脚本名：`exec_server.exe --gui 0` / `--token x` / `--token ""` 中的 `0`/`x`/`""` 被 214-250 行当成 `js_file`（`--xxx` 以 `-` 开头被 242 循环跳过，取第一个非 `-` 参数），`Failed to load '0'` 启动即挂。只有无值开关（`--nogui`）与等号形式（`--gui=0`/`--token=x`）能活（`--gui=0` 整体以 `-` 开头被跳过，`file_idx` 越界 → 走内嵌 JS）。修复需区分"选项值 vs 脚本名"，涉及通用 runtime 行为（`-unknown script.js` 等形式），单独评估。当前对策：JS 层已删空格形式解析，见 `examples/exec_server.tsx` parseArgs 注释
- [ ] `start-novnc.sh` 的 `pkill -x websockify` 杀不干净：websockify 走 `multiprocessing.forkserver`，每路除主进程外还派生 worker 子进程和 `resource_tracker`，`-x` 精确匹配进程名只杀主进程，孤儿子进程可能残留并继续占住 6005/6007/6011，导致下次启动 `Address already in use`。实测 3 路桥接在 `podman top` 里匹配到 18 个 `websockify --log` 进程（3 主 + forkserver 派生子进程 + 2 个 resource_tracker）。改用 `pkill -f websockify` 或按进程组（`setsid` + 负 PID）清理
