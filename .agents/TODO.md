# TODO

## 待办

- [ ] FFI 两个可选优化方向（2026-10-19 记录，均未做）：**(1) 元数/签名特化 wrapper**——按签名生成调用代码，去掉 rest 参数数组与逐槽循环，目标 sub-µs（node:ffi 同场景个位数 ns 是 V8 整路径 inline 的效果）。代价：代码生成、可读性。**(2) codec 契约 debug 守卫**——"写槽期间不得回调已 bind 的函数"现为文档契约 + 零运行时检查；可加 debug-only 检测（写槽期间置位 + 入口检测 → fail-loud）。归因数据见 `.agents/FFI_PERF.md`
- [ ] `ffi-struct` 覆盖缺口（按需再补）：by-value struct **返回**（需隐藏指针/sret 级 ABI，当前零消费者）；varargs（x64 `AL` 恒 0 且 MS x64 ABI 未定义 varargs 约定，实战触发为零，暂缓）。union / bitfield / `#pragma pack(n)` / by-value 入参均已实现（`lib/ffi/struct.ts`）
- [ ] FFI `@Enum` 严格值域（enum 成员联合，定稿暂缓）：当前参数位收 `EnumMap[E]` 已拦域外字面量与异种枚举，唯一实质缺口是品牌交叉型 `Ptr<'HWND'>` 放行（误把窗口句柄当位置常量/命令值传）。严格化代价：错误文案从干净的 `ShowWindowCmd` 退化为冗长成员联合列表。触发条件：指针位 `@Enum` 扩张到大量调用点时再评估
- [ ] execd Job Object 收口 `/exec` 进程树——**原型已验证可行、决策暂不采纳**：Win7/XP assign 均成功、`start /b` 逃逸用例被收干净、三条收尾路径正常；未采纳因净增约 50 行且引入句柄时序（CloseHandle 与回调顺序）/双路径/`CREATE_SUSPENDED`-`ResumeThread` 三类新复杂度，收益（仅逃逸用例）不匹配。Win7 不支持嵌套 job，仍须保留 taskkill 回退

## 归档（已完成；细节见链接文档与 git log）

- [x] C 层 chunked encoding 修复（`http_get_sync`/`read_http_response` 对 Cloudflare 挂死）
- [x] Worker 线程安全：方案 T 落地（sock/async state 嵌入 `JSThreadState`），回归 `test/test_worker_concurrent.ts`
- [x] cache 修复：条件请求 200 不更新缓存（`lib/fetch.ts`）
- [x] HTTPS/wss 证书校验：内嵌现代根证书（`lib/certs.ts`）+ 进程级追加式信任库（`src/quickjs-wolfssl.c`）+ 默认 `VERIFY_PEER` + 宿主名校验 + `rejectUnauthorized` 逃生门，见 `.agents/TLS_TRUST_STORE.md`
- [x] `test_ffi` 32 位 PRINTER_INFO_2 布局修复（`structSize` 按 `os.arch` 分支、`readPtr` ia32 只读 4 字节、`decodeWideAtPtr` 加上限防死循环），见 `.agents/QEMU_NET_SUITE_TEST.md`
- [x] `/exec` 中文 lossy：根因是 cmd 内置输出按 ACP 编码（mkdir/文件系统、qwin 子进程本就无损）；**最终方案为全平台 worker 恒拼 `cmd /u /c`**（内置输出 UTF-16LE 绕开 ACP，不做 NLS 固化），见 `.agents/CMD_ENCODING_ACP_NLS.md` §8
- [x] react-qw React 错误不再静默：`createRoot` 的 `onUncaughtError`/`onCaughtError`/`onRecoverableError` 接 `console.log`（React 放弃整树白屏可从 stdout 看到栈）
- [x] FFI 系统性优化：libffi 移出构建（汇编桩，见 `.agents/REMOVE_LIBFFI_PLAN.md`）→ `bind()` DSL → bind 期 `CallPlan` + 零分配（参数帧复用、共享返回槽）；生产代码全迁 `bind()`，旧 `ffiCall`/`FFI_TYPE_*` 导出删除。归因/数据见 `.agents/FFI_PERF.md`，ABI 不变式见 `.agents/FFI_ARGS_RET_SEMANTICS.md`
- [x] `http_test.sh <vm> <filter>` filter 生效修复：根因是运行时透传 `scriptArgs` 脚本名不占位、`test/run.ts` 取错下标；同轮修掉 filter 匹配 0 个 suite 假绿与 suite 加载失败静默跳过
- [x] FFI 回调落地：`closure(sig, fn, {stdcall?})` → `{ptr, dispose}`，每闭包一个 `VirtualAlloc` 可执行块（trampoline + wrapper 派发）
- [x] FFI typedef 别名机制移除（token 词汇单一化）：签名只收规范 token，`'DWORD'`/`'HANDLE'` 类 typedef 名类型层塌 `never` + 运行时 `Unknown token` 双 fail-loud
- [x] FFI `ptr!` 非空 token 与 `i32@Enum` 枚举标注（类型层收紧 + 运行时执法；"标注即担保"语义与规则表见 `docs/ffi-types.md`）
- [x] `fetch()` 协议白名单：`fetchRequest` 入口拒绝非 `http:`/`https:` scheme，负例覆盖初始请求与重定向链
- [x] execd 流式输出：worker 分块 `postMessage` → `/exec` `ReadableStream` + chunked 发送 + trailing `X-Exit-Code`；断连/超时 kill 子进程
- [x] guest SMB 按路径缓存 exe——服务器侧治本：`smb_wrapper.sh` 加 `oplocks = no` + `smb2 leases = no`，覆盖写同路径立即生效
- [x] `src/main.c` 参数解析收敛为固定槽位文法 `exe [-d] [-o target] [-e code | file]`：槽位外一切原样透传给脚本，"裸值误当脚本名"路径整体消除
- [x] `start-novnc.sh` 清理 websockify 残留：精简容器无 procps（pkill/pgrep 缺失是 no-op），改为 bash 直扫 `/proc/*/cmdline` 按绝对路径形态 kill，幂等
- [x] Job Object 原型验证后不采纳（决策，见上"待办"末条）

（更早归档）

- [x] Fetch API 类型对齐（原 `FETCH_TYPES_PROGRESS.md`）：`quickwin.d.ts` 对齐浏览器 Fetch API；「HTTPS 大 body 挂死」根因是 `wolfSSL_read` 返 `-1`（WANT_READ）时 JS 侧 `!data` 守卫不成立 → `byteLength` 累加成 NaN，修复 = C 侧返 `JS_NULL` + 读循环 null 守卫 + 超时重武装
- [x] SetParent 缓存问题（原 `DELAYED_CREATE_PLAN.md`）：SysListView32/SysTreeView32 在 `WM_CREATE` 缓存父 HWND，最终方案 = 这两类控件延迟 `CreateWindow`
- [x] mupdf-wasm 内存破坏（原 `MUPDF_WASM_MEMORY.md`）：WAMR 异常处理重建 + import global 链接 + app heap 调整后解决
