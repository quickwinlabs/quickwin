# Fetch API 类型对齐进度

## 已完成
- `quickwin.d.ts` 类型与浏览器 Fetch API 对齐（`HeadersInit`、`BodyInit`、`RequestInit`、`RequestRedirect`、`RequestCache`、`RequestCredentials`、`RequestMode`、`ResponseType`、`AbortSignal`）
- `lib/fetch.ts` 内部实现更新：`FetchHeaders` 构造函数支持数组形式、`FetchRequest`/`FetchResponse` 补齐标准接口字段、`normalizeHeaders()` 辅助函数
- 消除 `_PreloadedStream` 中的 4 个 `as any` 类型转换
- 测试 `test_net_fetch.ts` 修复 null-safety
- 384/384 测试全部通过（含网络测试）

## 国内站 HTTPS 根因（2026-09-24，XP 实测，已修复）

**现象：** `fetch('https://www.qq.com/')` / `https://www.jd.com/`（129KB/190KB 页）promise 永不 settle；baidu（227B）正常。HTTP `redirect:'manual'`、裸 sock+wolfSSL 全路径、POST/302 状态行均正常。

**根因链（`lib/fetch.ts` ST_RECV_BODY）：**

1. 头解析成功 → `doResolve(response)` → **`cleanup()` 清掉 request timeout**，随后 `doFetch` 对 200 GET + `__httpCache__` 执行 `await response.arrayBuffer()`。
2. 大 body 多次 `wolfSSL_read`；无数据时 C 返回 **number `-1`（WANT_READ）**，不是 ArrayBuffer。
3. JS 判空 `if (!data || data.byteLength === 0)` 对 `-1` 不成立（`!(-1)=false`，`(-1).byteLength===undefined`）。
4. 继续 `receivedBytes += data.byteLength` → **`NaN`**；`contentLength > 0 && NaN >= contentLength` 恒 false → stream 永不 `close()`。
5. timeout 已清 + body 挂死 → 进程只能被 exec 超时杀掉（exit=1 / http=000）。

**插桩证据（`fetch_dbg`）：** `DBG body read num-1 recv 9313` → 下一轮 `recv NaN cl 129853`。

**对照：** 302/POST 只用状态行故通过；删 `__httpCache__` 后 200 不再强制 `arrayBuffer` 也可立刻返回状态；baidu 小 body 在撞上 `-1` 前已收齐。

**修复（2026-09-24）：**
- `quickjs-wolfssl.c`：`wolfSSL_read` `ret <= 0` → `JS_NULL`（与 `sock.recv` 一致；EOF/WANT_READ/致命均 null，分类靠 `wolfSSL_get_error`）
- `lib/fetch.ts` 三处读循环：`!data || data.byteLength === 0` → break（C 返回 null 后此守卫成立）
- body 阶段超时：`armTimeout()` 在 `doResolve` 后重新武装；`ST_RECV_BODY` 超时 → `_controller.error` + `cleanupSocket`
- `quickwin.d.ts`：`wolfSSL_read` → `ArrayBuffer | null` + 注释
- `lib/websocket.ts` 守卫本已是 `!data`，C 改 null 后无需改 TS

**测试（2026-09-24 已补）：**
- `test/test_wolfssl_read.ts`（suite `net-wolfssl-read`）：raw TLS 断言 `wolfSSL_read` 只返 `ArrayBuffer|null`，绝不返 number；null 时 `get_error ∈ {WANT_READ,WANT_WRITE,ZERO_RETURN,SSL,SYSCALL}`
- `test/test_net_fetch.ts` 新增 3 段：`large HTTPS/HTTP body`（200000 字节 exact，15s watchdog）、`HTTPS body timeout`（`/stall` 超时 reject）
- `tools/serve_test.ts` 新增 `/large/:n`、`/stall`、`/close`（HTTP+HTTPS 对称）
- **旧码复现有效**：stash 修复后 `net-wolfssl-read` 4/7 FAIL（`got number -1`）、`net-fetch`/全 `net` suite exec timeout 挂死

**修复后回归（2026-09-24）：** XP/Win7 `http_test.sh <vm> net` 均 **80/80 PASS**（含新用例）

## 待办

- [x] ~~修 `lib/fetch.ts`：`wolfSSL_read` 返回 number 时勿累加 `byteLength`（NaN）；body 阶段保留超时~~
- [x] ~~补回归测试：wolfSSL_read null 契约 + 大 body + body timeout~~
- [ ] 修复缓存 bug：条件请求返回 200 时不更新缓存（`lib/fetch.ts:838`）
- [ ] `_PreloadedStream` 优化：`slice()` → `subarray()` 内存优化
- [ ] 为 `fetch()` 添加协议白名单
