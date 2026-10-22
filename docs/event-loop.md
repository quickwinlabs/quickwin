# 事件循环

QuickWin 的所有异步事件——GUI 消息、socket、stdin、worker 消息、async task、定时器——全部由**一个函数**等待和派发：

```
src/quickjs-libc.c   js_os_poll()
```

JS runtime 每次回到这个函数，做一次等待，派发**一个**事件，然后返回 JS。每个线程只有一个这样的等待点——主线程一个，每个 worker 各一个。

---

## 异步源

| 来源 | 等待方式 |
|---|---|
| GUI 消息 | `QS_ALLINPUT`（由 `MsgWaitForMultipleObjects` 的最后一个参数携带） |
| socket | 每个 socket 一个 `WSAEVENT`，由 `js_sock_collect_handles` 收集 |
| stdin | `fd == 0` 的 rw handler，`_get_osfhandle(0)` |
| worker 消息 | 每个端口一个事件，`port->recv_pipe->waker.handle` |
| async task | 全局单个事件，`js_async_task_get_event()` |
| 定时器 | 折算成 `timeout` 传给等待调用 |

等待调用：

```c
ret = MsgWaitForMultipleObjects(count, handles, FALSE, timeout,
                                main_thread ? QS_ALLINPUT : 0);
```

只有主线程会等 GUI 消息，worker 线程传 0。

## 每轮只派发一个事件

派发后立即 `return 0` 交还 JS runtime，而不是在同一轮里把所有就绪事件都处理完。

**唯一的例外是 GUI 消息**：拿到 `WAIT_OBJECT_0 + count` 之后会 `while (PeekMessageW(...))` 把积压消息全部 drain 掉。

原因是 IME：提交一个汉字时会连续产生多条 `WM_CHAR` / `WM_IME_*`，如果每轮只处理一条，消息之间的 JS 轮询开销会累积成逐字卡顿。而 `DispatchMessageW` 是微秒级操作，不会造成其他事件饥饿。

## 回调不可阻塞

因为一轮只派发一个事件，**任何一个回调阻塞，整个运行时就停住**：

- GUI 卡住：所有窗口失去响应
- socket 回调阻塞：其他连接、定时器、worker 消息全部延迟
- worker 回调阻塞：消息队列只增不减

正确做法是把耗时操作丢进 worker，结果通过 `postMessage` 回主线程。

## 退出条件

`js_os_poll` 开头会检查是否还有事件源：

```text
if (os_rw_handlers 空 && os_timers 空 && port_list 空
    && socket 槽数 == 0 && async task 槽数 == 0)
```

（实际源码是一条 `list_empty(...)` 连写，此处为伪代码便于阅读。）

满足时按线程区分：

- **worker 线程**：直接返回 `-1`，循环结束，线程退出
- **主线程**：再调 `EnumThreadWindows` 看当前线程还有没有窗口。**一个窗口都没有才退出**

所以“主线程保持存活”的条件是有窗口、有 socket、有定时器、有 worker 端口里的任意一个。一个只做网络服务、不建窗口的进程，关掉 socket 之后就会自然退出。

## 64 句柄上限

```c
HANDLE handles[MAXIMUM_WAIT_OBJECTS];   // 64
```

所有异步源共享这 64 个槽位，**收集顺序决定谁优先**：

```
1  socket          js_sock_collect_handles 先跑，一次把所有连着的 socket 收进来
2  stdin           fd == 0
3  worker 端口     每个端口一个
4  async task      全局一个
5  GUI 消息        0（走 QS_ALLINPUT，不占槽位）
```

**超出不会报错，而且先收集的会占满后来的**。计数处的写法是：

```c
if (s->fd >= 0 && *count < max) {
    handles[*count] = (HANDLE)s->event;
    (*count)++;
}
```

`*count == max` 时直接跳过，后面几个 `list_for_each` 也会在满员时 break。两个方向的后果：

- **socket 侧**：槽位耗尽后，后续连接不进等待集——请求不被处理、零日志，客户端表现为超时，服务端看起来一切正常
- **反方向更隐蔽**：socket 先收集，所以当开放连接接近上限时，**stdin、worker 消息、async task 一个都进不了等待集**——控制台读不到输入，worker 之间不再通信，只剩定时器还能唤醒

需要更多并发时，限制连接数或用 worker 分担（每个 worker 有自己的循环和 64 槽位）。

## 已知缺陷：socket 回调异常被吞掉

三条回调路径的异常处理并不一致：

| 路径 | 异常处理 |
|---|---|
| 定时器、stdin、worker 消息、async task | 经 `call_handler` → `js_std_dump_error` 打印 |
| 窗口过程 | `showError` 打印 |
| **socket** | `JS_GetException` 后直接 `JS_FreeValue` **丢弃** |

socket 路径（`src/quickjs-sock.c` 里的事件回调）绕过了 `call_handler`，异常静默消失，没有任何输出。写回调时抛出的错误会表现为“请求没响应但进程没报错”。

## 排查工具

`-d` 参数打开循环日志：

```bash
qwin.exe -d
```

输出带时间戳的每一步：进入循环时各事件源数量、等待前的句柄数与 timeout、返回值、以及派发的是哪个分支。排查“事件没被处理”时第一步就是打开它。
