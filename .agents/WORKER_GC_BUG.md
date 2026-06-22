# Worker 生命周期管理

## 背景

QuickJS 的 Worker 是一个普通 JS 对象，其存活完全依赖 JS 层的引用可达性。这与浏览器 Worker 不同——浏览器有 DOM/渲染引擎的内部引用在 GC 之外保持 Worker 存活。

## 现象

Worker 在 `new Promise` executor 内创建且无外部引用时，onmessage 回调可能无法触发：

```js
// 错误：Worker 在 executor 内创建，无外部引用
await new Promise((resolve) => {
  const worker = new Worker(...)
  worker.onmessage = (e) => resolve(e.data)
  worker.postMessage('start')
})  // executor 返回后 worker 局部变量超出作用域，可被 GC
```

## 正确写法

保持 Worker 引用可达的三种方式：

```js
// 1. Worker 声明在 Promise 外部，闭包捕获引用（推荐）
let worker: os.Worker
const result = await new Promise((resolve) => {
  worker = new os.Worker('./module.js')
  worker.onmessage = (e) => {
    resolve({ data: e.data })  // 闭包引用 worker
  }
  worker.postMessage({ type: 'start' })
})

// 2. resolve 值包含 worker
await new Promise((resolve) => {
  const worker = new os.Worker(...)
  worker.onmessage = (e) => {
    resolve({ worker, data: e.data })  // resolve 值持有 worker
  }
})

// 3. Worker 在 Promise 外部创建
const worker = new os.Worker(...)
await new Promise((resolve) => {
  worker.onmessage = (e) => resolve(e.data)
  worker.postMessage({ type: 'start' })
})
```

## 原因

Worker 是 QuickJS 的 GC 托管对象。当 worker 变量超出作用域且无闭包引用时：

1. GC（在合适的时机）回收 Worker 对象
2. `js_worker_finalizer` 释放 port
3. port 从 `ts->port_list` 移除
4. 后续消息无法触发回调

## 实验验证

| 场景 | 强制 GC | 结果 |
|------|---------|------|
| 不引用 worker | 是 | 超时 - worker 被 GC 回收 |
| 闭包引用 worker | 是 | 正常 - worker 存活 |
| 不引用 worker | 否 | 正常 - GC 未触发 |

## 结论

这不是 QuickJS 的 bug，而是设计差异：

- **浏览器**：Worker 有内部引用保持存活
- **QuickJS**：Worker 是纯 JS 对象，JS 代码必须维持引用

使用 Worker 时，始终确保有引用指向 Worker 对象。推荐方式 1（声明在 Promise 外部 + 闭包捕获），最简洁且不需要 C 层改动。

## 相关文档

- [QuickJS GC 工作原理](./QUICKJS_GC.md)
