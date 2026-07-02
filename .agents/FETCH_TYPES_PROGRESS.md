# Fetch API 类型对齐进度

## 已完成
- `quickwin.d.ts` 类型与浏览器 Fetch API 对齐（`HeadersInit`、`BodyInit`、`RequestInit`、`RequestRedirect`、`RequestCache`、`RequestCredentials`、`RequestMode`、`ResponseType`、`AbortSignal`）
- `lib/fetch.ts` 内部实现更新：`FetchHeaders` 构造函数支持数组形式、`FetchRequest`/`FetchResponse` 补齐标准接口字段、`normalizeHeaders()` 辅助函数
- 消除 `_PreloadedStream` 中的 4 个 `as any` 类型转换
- 测试 `test_net_fetch.ts` 修复 null-safety
- 384/384 测试全部通过（含网络测试）

## 待办

- [ ] 修复缓存 bug：条件请求返回 200 时不更新缓存（`lib/fetch.ts:838`）
- [ ] `_PreloadedStream` 优化：`slice()` → `subarray()` 内存优化
- [ ] 为 `fetch()` 添加协议白名单
