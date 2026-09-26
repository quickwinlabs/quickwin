# Worker 线程安全：方案 T — 将全局 runtime 表嵌入 JSThreadState

**状态：** 已实施并验证（Win7 429/429、XP 426/427），本 commit 落地。

> 分支：`research/worker-locks`（基于 main `432de9e`）  
> 替代：旧分支 `worker-locks@6fa63e4`（加 CRITICAL_SECTION）**不采用**  
> 日期：2026-09-23

## 1. 背景与问题

### 1.1 现状

QuickWin 在 QuickJS 之外增加了两个**进程级全局表**，按 `JSRuntime*` 索引 per-runtime 数据：

| 文件 | 全局状态 | 写者 | 读者 |
|------|----------|------|------|
| `quickjs-sock.c:107-109` | `g_sock_runtimes` / `g_nsock_runtimes` / `g_runtimes_capacity` | `js_sock_init`（每个 `JS_NewCustomContext`）、`js_sock_remove_runtime`（每次 `JS_FreeCustomRuntime`）、`js_sock_cleanup` | `find_runtime` → `slot_count` / `collect_handles` / `handle_event`（`js_os_poll`） |
| `quickjs-async-task.c:3-5` | `g_runtimes` / `g_nruntimes` / `g_runtimes_capacity` | `js_async_task_init`（仅 main `main.c:253`）、`js_async_task_destroy`、`js_async_task_cleanup` | 同上 poll 路径 |

### 1.2 竞态（多 Worker）

- **init 并发**：主创建 Worker A、B 串行 `pthread_create`，但 A/B 各自在子线程跑 `JS_NewCustomContext` → `js_sock_init`；若 A 未跑完 init 就创建 B，两线程同时 `realloc` / `g_nsock_runtimes++`，写同一 slot。
- **remove 并发**：Worker 退出时 `js_sock_remove_runtime` 的 swap-remove 与另一线程 `find_runtime` 竞态。
- **退出 UAF**：工程无 `pthread_join`（上游设计，`PTHREAD_CREATE_DETACHED` + `/* no join at the end */`）。主 `js_std_loop` 返回后 `js_async_task_cleanup` / `js_sock_cleanup` `free` 全局数组；Worker 若仍存活（`port_list`/sock 未空、仍在 `MsgWait`/`find_runtime`）→ use-after-free。窗口在 `free` 之后、`ExitProcess` 之前。

### 1.3 与上游 QuickJS 的边界

| 行为 | 归属 |
|------|------|
| 不 join Worker、detached、`onmessage` 钉住线程、主可先退 | **上游设计**（`quickjs.texi:794-795`、`PTHREAD_CREATE_DETACHED`）——不改 |
| `list_empty(&ts->port_list)` 早退、per-runtime `ts` | 上游设计——不改 |
| `g_sock_runtimes` / `g_runtimes` 无锁 | **仅 QuickWin**——本方案要删 |
| cleanup `free` 全局表 vs Worker 仍 `find` | **仅 QuickWin**——嵌入后表不存在 |

### 1.4 旧分支 `worker-locks@6fa63e4` 弃用原因

1. 懒初始化 `if (!g_*_lock_init)` 本身有竞态；TODO 要求移到 `main.c`。
2. `js_async_task_make_task` grow 路径漏写 `r->slots_capacity = newCap`。
3. cleanup 里 `DeleteCriticalSection`：无 join，Worker 可能在删锁后仍 `Enter`。
4. 基于 `eef02c7`，落后 main 约 98 个 commit，rebase 成本高于重写。

---

## 2. 方案 T 设计

### 2.1 思路

per-runtime 数据挂 runtime opaque（`JSThreadState`），与 `os_timers` / `port_list` 一致：

- **无跨线程共享表** → Phase 1（并发 init/find）结构性消失，**不需要** `CRITICAL_SECTION`（XP 也省事）。
- **无全局 `free`** → Phase 2（退出 UAF）对 sock/async 表消失；进程退出仍靠 `ExitProcess` 杀 detached Worker（与上游相同）。

### 2.2 关键决策

#### D1. 共享 `JSThreadState` 定义：新建内部头（推荐）

`JSThreadState` 现为 `quickjs-libc.c` 私有（L177-187）。新建 **`quickjs-thread-state.h`**（不进公开安装头）：

```c
/* quickjs-thread-state.h */
#pragma once
#include "quickjs.h"
#include "quickjs-sock.h"          /* SockState */
#include "quickjs-async-task.h"    /* AsyncTaskState */

typedef struct JSThreadState {
    struct list_head os_rw_handlers;
    struct list_head os_signal_handlers;
    struct list_head os_timers;
    struct list_head port_list;
    struct list_head rejected_promise_list;
    int eval_script_recurse;
    int next_timer_id;
    JSWorkerMessagePipe *recv_pipe, *send_pipe;
    SockState sock;              /* 嵌入，替代 g_sock_runtimes 槽位 */
    AsyncTaskState async_task;        /* 嵌入，替代 g_runtimes 槽位 */
} JSThreadState;
```

- `quickjs-libc.c`：删本地 typedef，`#include "quickjs-thread-state.h"`。
- `quickjs-sock.c` / `quickjs-async-task.c`：`JS_GetRuntimeOpaque(rt)` → `&ts->sock` / `&ts->async_task`。
- `SockHandle` 保持 `quickjs-sock.c` 私有；`SockState` 上移到 `quickjs-sock.h`（`struct SockHandle *slots` 前向声明）。

备选：libc 导出 `SockState *js_sock_state(JSRuntime *)`。**不推荐**（耦合、三文件不对称）。

#### D2. 公开 API 签名不变

`js_sock_*(JSRuntime *rt)` / `js_async_task_*(JSRuntime *rt)` 签名保留 → `main.c`、`js_os_poll` 调用点几乎不动，只改实现与**清理顺序**。

#### D3. 生命周期与调用顺序（嵌入后的硬约束）

`js_std_free_handlers` 会 `free(ts)` 并 `JS_SetRuntimeOpaque(rt, NULL)`。全局表方案下 `find_runtime` 不依赖 opaque；**嵌入后必须先用 opaque 再 free handlers**。

| 位置 | 现状 | 改为 |
|------|------|------|
| `main.c` 退出 (~L331-334) | `js_std_free_handlers` → `JS_FreeCustomRuntime` → `js_async_task_cleanup` + `js_sock_cleanup` | **`JS_FreeCustomRuntime` → `js_std_free_handlers`**；**删除**两个 `cleanup` 调用 |
| `worker_func` (`quickjs-libc.c` ~L3769-3773) | `js_std_free_handlers` → `js_worker_free_rt_func` | **`js_worker_free_rt_func` → `js_std_free_handlers`** |
| `main.c:253` | `js_async_task_init` 在 `js_std_init_handlers` **之前**（opaque 仍 NULL） | **挪到 `js_std_init_handlers` 之后** |

#### D4. 资源归属

| 资源 | 分配 | 释放 |
|------|------|------|
| `ts->sock.slots` | `js_sock_init`（`JS_NewCustomContext`，handlers 之后） | `JS_FreeCustomRuntime` 内 `js_sock_free_handles` + `js_sock_remove_runtime`（原地 free，非 swap-remove） |
| `ts->async_task.event/slots` | `js_async_task_init`（仅主 runtime，handlers 之后） | `JS_FreeCustomRuntime` 内 `js_async_task_destroy` |
| `ts` 本体 | `js_std_init_handlers` | `js_std_free_handlers`（**最后**） |
| `g_*` 数组、`js_*_cleanup` | — | **删除** |

约定：**只在 `JS_FreeCustomRuntime` 释放 sock/async 资源；`js_std_free_handlers` 不碰 `sock.slots` / `async`**（防双 free）。

Worker 从不调 `js_async_task_init`：`memset(ts,0)` 后 `async_task` 全零 → `slot_count==0`、`get_event==NULL`；`destroy` 对 `event/slots==NULL` 判空。与今天“不在全局表”等价。

#### D5. `inet_init_compat`

`p_inet_ntop` / `p_inet_pton` 仍为进程级写一次；双线程首调写入相同值可接受，或 `WinMain` 提前调一次。不引入锁。

---

## 3. 分文件改动清单

### 3.1 新建 `quickjs-thread-state.h`

见 D1。仅 `quickjs-libc.c` / `quickjs-sock.c` / `quickjs-async-task.c` /（如需）`main.c` 使用；**不**加入安装头列表。

### 3.2 `quickjs-sock.h`

- 导出 `typedef struct SockState { SockHandle *slots; int slot_count; int slots_capacity; } SockState;`（`struct SockHandle;` 前向声明；`JSRuntime *rt` 字段可删）。
- 删除 `void js_sock_cleanup(void);`。
- 其余 `js_sock_init` / `remove_runtime` / `slot_count` / `collect_handles` / `handle_event` / `free_handles` 声明保留。

### 3.3 `quickjs-sock.c`（核心）

- 删除 `g_sock_runtimes` / `g_nsock_runtimes` / `g_runtimes_capacity`（L107-109）。
- `find_runtime(rt)` → `JSThreadState *ts = JS_GetRuntimeOpaque(rt); return ts ? &ts->sock : NULL;`。
- `js_sock_init`：原地初始化 `ts->sock.slots`（`malloc` + `fd=-1`），不再 `realloc` 全局表、不再 `g_nsock_runtimes++`。
- `js_sock_remove_runtime`：`free(slots)` + 字段清零，不再 swap-remove。
- **删除** `js_sock_cleanup`（L158-164）。
- `slot_count` / `collect_handles` / `handle_event` / `free_handles` / `get_sock`：仅换 `find_runtime`，槽位逻辑不变。
- `#include "quickjs-thread-state.h"`。

### 3.4 `quickjs-async-task.h` / `quickjs-async-task.c`

- 删除 `void js_async_task_cleanup(void);` 及实现（L111-117）。
- 删除 `g_runtimes` / `g_nruntimes` / `g_runtimes_capacity`（L3-5）。
- `find_runtime` → `ts ? &ts->async_task : NULL`。
- `js_async_task_init`：填 `ts->async_task`（`CreateEvent` + `js_mallocz_rt` slots），返回 `&ts->async_task`；**必须在 opaque 就绪后调用**。
- `js_async_task_destroy`：`CloseHandle` + `js_free_rt(slots)` + 字段清零；`event/slots` 判空（Worker 全零路径）。
- `make_task` grow 路径：**补 `r->slots_capacity = newCap`**（L64-75，旧分支同款 bug）。
- `get_event` / `slot_count` / `process`：换 `find_runtime`。

### 3.5 `quickjs-libc.c`

- 删本地 `typedef struct JSThreadState`（L177-187），include 新头。
- `js_std_init_handlers`：`memset` 已清零 `sock`/`async`，无需额外 init（async 仍由 `main.c` 显式调用）。
- `js_std_free_handlers`：**不**释放 `sock.slots` / `async`（归 `JS_FreeCustomRuntime`）；仍只清 lists + pipes + `free(ts)`。
- `js_os_poll`：调用签名不变。
- **`worker_func`（~L3769-3773）**：交换顺序 → `js_worker_free_rt_func(rt)` **先于** `js_std_free_handlers(rt)`。

### 3.6 `main.c`

- `js_async_task_init(rt)` 从 L253 挪到 `js_std_init_handlers(rt)`（L257）**之后**。
- 退出路径（~L328-336）：

```c
js_std_loop(ctx);
gui_cleanup();
JS_FreeCustomRuntime(rt);   /* 先：destroy async + free sock + remove */
js_std_free_handlers(rt);   /* 后：free ts, opaque = NULL */
/* 删除 js_async_task_cleanup(); */
/* 删除 js_sock_cleanup();   */
JS_FreeContext(ctx);
JS_FreeRuntime(rt);
```

- `JS_NewCustomContext` / `JS_FreeCustomRuntime` 内对 `js_sock_*` / `js_async_task_*` 的调用保持不变。

### 3.7 `Makefile`

- 源文件列表不变；若对新头有显式依赖规则，补 `quickjs-thread-state.h`。

### 3.8 文档（实施完成后）

- `.agents/TODO.md`：高优「Fix Worker thread safety」→ `[x]`，注明方案 T（嵌入 JSThreadState），废弃 `worker-locks` 加锁方案。
- `AGENTS.md` §10：已在整体精简时删除；Worker 线程安全现状（方案 T + `quickjs-thread-state.h`）见 `.agents/` 代码注释，无独立文档
- 旧分支 `worker-locks` / `origin/worker-locks`：修完后是否删除 → **待用户确认**。

### 3.9 明确不包含

- 不 `pthread_join`、不改 `port_list` / `onmessage` 语义（上游 detached 设计）。
- 不引入 `CRITICAL_SECTION` / `SRWLock` / `InitOnceExecuteOnce`（XP：纯 C 结构调整，无新 Win32 API）。
- 不动 `docker/run.sh` 的 `-vnc` 未提交改动（单独处理）。

---

## 4. XP 兼容性

- 无新系统 API；仅结构体重排 + 去全局表。
- `Makefile` 已有 `-D_WIN32_WINNT=0x0501`。
- `CRITICAL_SECTION` 方案本就不必上；方案 T 连锁都不需要。

---

## 5. 验证计划

1. 容器内：`make js && make` 无编译错误。
2. `make test TEST=-net`，重点：
   - `test/test_worker.ts`、`test_worker_fetch.ts`、`test_worker_net.ts`、`test_worker_wasm_concurrent.ts`
   - 全量回归（sock 相关 net/http/websocket 若在非 net 段则一并跑）。
3. **多 Worker 并发压测**：新增 `test/test_worker_concurrent.ts`（见 §8-5）：
   - 主线程同时 `new` 两个 Worker，秒级脚本退出，重复 N=20～50 次；
   - 断言：无崩溃、双方收到 message、主 loop 能退出；
   - 默认进 `make test`（注意 XP 全量耗时，N 勿过大）。
   - 可选：Worker 内开 sock 再退出，压多 runtime 的 `free_handles`。
4. 退出路径：主脚本结束、Worker 尚存活时主不再 `free` 共享表（表已不存在）；进程正常退出。
5. XP：`make cc32` / `cc64` 交叉编译通过；有 VM 可跑同一 worker 测试更佳。

---

## 6. 风险与对策

| 风险 | 对策 |
|------|------|
| 漏改 `free_handlers` / `FreeCustomRuntime` 顺序 → opaque NULL 后 find | D3 明确顺序；`main` + `worker_func` **两处**都改 |
| `js_async_task_init` 仍在 opaque 前 | 显式挪到 `js_std_init_handlers` 后 |
| `SockState` 上移头文件 include 环 | 新头只依赖 `quickjs.h` + sock.h + async-task.h；单向 include |
| 双 free `slots` | 约定只在 `JS_FreeCustomRuntime` 释放；`free_handlers` 不碰 |
| Worker `async` 全零路径 | `destroy`/`get_event` 判空；`slot_count` 为 0 |
| 行为回归 | worker 套件 + 多 Worker 压测 |

---

## 7. 实施顺序

1. 新建 `quickjs-thread-state.h` + `SockState` 上移 + `JSThreadState` 嵌入（先能编译）。
2. 改写 `quickjs-sock.c` 去全局。
3. 改写 `quickjs-async-task.c` 去全局 + 修 `slots_capacity`。
4. 改 `main.c` / `worker_func` 顺序，删两个 `cleanup`。
5. 新增 `test/test_worker_concurrent.ts`（§8-5）。
6. 编译 + worker 测试 + 多 Worker 压测。
7. 更新 `TODO.md` / `AGENTS.md`。
8. **展示 `git diff` + 拟用 commit message，用户确认后再 `git add` / `git commit` / `git push`**（遵守 AGENTS.md）。
9. 方案 T 验证通过后：删除旧分支 `worker-locks` 本地 + 远端（§8-3）；`docker/run.sh` `-vnc` 另开 commit（§8-4）。

**拟用 commit message（待 diff 确认后微调）：**

```
refactor(worker): embed sock/async state in JSThreadState to fix thread races
```

**`docker/run.sh` 单独 commit（方案 T 之后）：**

```
docker(run): enable VNC display for win7 VM
```

---

## 8. 决策（已确认）

| # | 问题 | 决策 | 理由 |
|---|------|------|------|
| 1 | 头文件方案 | **新建 `quickjs-thread-state.h`** | 三个 `.c` 对称、无 libc 私有 getter；只依赖 `quickjs.h` + sock.h + async-task.h，不易成环；不污染公开 `quickjs-libc.h`。 |
| 2 | `js_sock_remove_runtime` 命名 | **保留原名，只改语义**（原地 free slots） | 调用点（`main.c` / `JS_FreeCustomRuntime`）零改动；改名收益低、diff 噪音大。实现处注释一句 “dispose in-place, no global array”。 |
| 3 | 旧分支 `worker-locks` | **新实现测试通过后删本地 + 远端** | 方案 T 与加锁路线互斥，留着易误导；现在先不删，验证完成后再删。历史仍在 git。 |
| 4 | `docker/run.sh` `-vnc` 未提交改动 | **与方案 T 拆开，另开 commit**（或暂不提交） | 与线程安全无关，混进 refactor 会污染 diff。commit：`docker(run): enable VNC display for win7 VM`。若暂不动 noVNC，可先只提交 C 代码，run.sh 留工作区。 |
| 5 | 多 Worker 并发压测 | **新增 `test/test_worker_concurrent.ts`** | 单次 worker 测试测不出竞态；固定 “双 Worker 同时创建 + 秒退 × N” 才能回归。默认进 `make test`，N=20～50，避免拖垮 XP 全量。 |

---

## 9. 相关文件速查

| 路径 | 角色 |
|------|------|
| `quickjs-sock.c` / `.h` | 去全局、原地 init/remove |
| `quickjs-async-task.c` / `.h` | 去全局、修 capacity、删 cleanup |
| `quickjs-thread-state.h` | **新建**，共享 `JSThreadState` |
| `quickjs-libc.c` | 删本地 typedef、`worker_func` 顺序 |
| `main.c` | init 顺序、退出顺序、删 cleanup 调用 |
| `Makefile` | 源列表 / 头依赖（如需） |
| `.agents/TODO.md`、`AGENTS.md` §10 | 完成后更新 |
| `test/test_worker*.ts`、`test/test_worker_concurrent.ts` | 回归 + 并发压测（§8-5 新增） |
| `docker/run.sh` | `-vnc` 改动与本方案拆开单独 commit（§8-4） |
