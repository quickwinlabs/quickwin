# qwin 的 stdout/console 初始化机制（GUI 子系统 + GetFileType 决策）

## 一句话原则

**qwin 是 GUI 子系统（`/SUBSYSTEM:WINDOWS`）进程，不会自动关联控制台；stdout 接什么完全取决于启动方式。判断标准是 `GetFileType`——拿到可用句柄就"绝不动"，拿不到才尝试 `AttachConsole` + `freopen("CONOUT$")`。**

对应代码：`main.c`（`WinMain` 开头，当前约 L146-175）。这段代码不能"优化"掉，删掉就是重复历史上三个大坑（见 §4）。

## 1. 背景

qwin 编译时是 GUI 子系统二进制。Windows 不会给这样的进程自动关联控制台，`stdout`/`stderr` 的内容取决于父进程怎么派生它：

- 控制台程序的 `printf` 天然接自己的控制台（CONOUT$）；
- GUI 进程的 `printf` 只有继承到了父进程传入的句柄才有意义，否则就是"丢进黑箱"。

xp 上观察到的"控制台能看到输出，但 exec_server / /exec 拿不到"、“反过来 exec_server 能拿到但控制台看不到”——根子都在这一层。

## 2. 三种启动场景与 GetFileType 判定

`GetFileType(GetStdHandle(STD_OUTPUT_HANDLE))` 能区分句柄到底可不可用（只认返回值 `1/2/3`）：

| 场景 | `GetFileType` | 含义 | 处理 |
|---|---|---|---|
| XP 经 exec_server / winpty agent 派生 | `3`（pipe） | 句柄可用，CRT 已把它装到 fd 1 | **什么都不做** |
| 从 cmd 重定向到文件 | `1`（disk） | 句柄可用 | **什么都不做** |
| Win7 GUI 未附着父控制台 | `0` | 句柄存在但无效 | `AttachConsole` + `freopen("CONOUT$")` |
| 从 explorer 双击 / 无句柄 | `0xffffffff`（`INVALID_HANDLE_VALUE`） | 压根没有句柄 | `AttachConsole`，失败则保持原样 |

> 注意 0 和 `0xffffffff` 是两种不同情况：Win7 未附着时 `GetFileType` 返回 **0**（句柄值是继承下来的，但无效），没有句柄时才返回 `-1`。

## 3. 最终代码与决策树

```c
DWORD fOut0 = GetFileType(GetStdHandle(STD_OUTPUT_HANDLE));
int haveStd = (fOut0 == 1 || fOut0 == 2 || fOut0 == 3);

if (!haveStd && AttachConsole(ATTACH_PARENT_PROCESS)) {
    freopen("CONOUT$", "w", stdout);
    freopen("CONOUT$", "w", stderr);
}
setvbuf(stdout, NULL, _IONBF, 0);
setvbuf(stderr, NULL, _IONBF, 0);
```

决策树：

```
GetFileType(STD_OUTPUT_HANDLE)
 ├─ 1/2/3（disk/char/pipe）→ 句柄可用，不动 stdio（CRT 已装好）→ 直接 printf
 └─ 0（Win7 无效句柄）/ 0xffffffff（无句柄）
     ├─ AttachConsole 成功 → freopen("CONOUT$")（stderr 同样处理）
     └─ 失败（父进程非控制台应用，explorer 场景）→ 保持原状，与历史行为一致
最后无条件 setvbuf(_IONBF) 关缓冲
```

`-o CON` / `-o 文件` 两个选项仍走它们自己的 `freopen`（`main.c` 后面 ~L230-241），这段开机代码只在"C 层 stdio 就绪之前"生效，二者不冲突。

## 4. 为什么"可用句柄绝不能动"

三条路全部用 Xp（ia32）实测否决过，各有硬证据：

### 4.1 `AttachConsole` 会使继承句柄失效（头号元凶）

XP 上继承来的是 pipe 句柄，`AttachConsole(ATTACH_PARENT_PROCESS)` 一旦成功，**同一进程里那个句柄就废了**：

- attach 前：`GetFileType`=3（pipe）、`WriteFile` 写 8 字节成功；
- attach 后：`GetFileType`=0、`WriteFile` 返回 0、`fOut0` 判定不可用。

而 `WinMain` 入口的 `stdout` 在启动时已经被 CRT 初始化过（见 §4.4），我们曾经办的"先 attach 再 `freopen("CONOUT$")`"恰恰把 XP 那条"本来还能用"的 pipe 打死了——**这正是历史上 XP 输出全丢的根因**。

### 4.2 `_close(1)` + `_open_osfhandle` → `EMFILE`(0x9)

曾尝试"关掉 fd 1、再用 `_open_osfhandle` 重新打开继承句柄"。结果 `_open_osfhandle` 直接失败（`fd=-1, errno=0x9`），追加 `_O_BINARY` 也没用。**更糟的是它会殃及整个 C 流层**：改完再做普通的 `> out.txt 2> err.txt` 文件重定向都不再工作——stdio 被彻底搅乱。

### 4.3 `_dup2` 对 `_open_osfhandle` 派生的 fd 恒失败

另一个尝试：`_open_osfhandle(...)` 拿到 `fdOut=3` 后再 `_dup2(3, 1)`，结果 `dupOut=-1`、目标 fd 上 `_get_osfhandle` 仍返回 `-1`。MinGW/mingw CRT 对 `_open_osfhandle` 创建的 fd 没有对应的 `_osdata` 槽，`_dup2` 无从复制——这条路从设计上就不通。

### 4.4 CRT 启动时已经把继承句柄装到 fd 1

不动任何东西直接查：`_get_osfhandle(1) == (intptr_t)GetStdHandle(STD_OUTPUT_HANDLE)`，两值一致（XP 上实测 fd 1 = 0x170 = 继承句柄）。也就是说 mingw 的启动代码在我介入之前已经完成了 `fd 1 ↔ 继承句柄` 的绑定，`printf` 天然可用。**"可用句柄"的默认状态就是对的。**

### 4.5 `freopen` 只换句柄、不更新 `_outband_[]`

`freopen("CONOUT$", ...)` 只替换文件句柄，CRT 内部按 fd 索引的 `_outband_[]`（决定输出模式）并不随 `freopen` 更新。只有 attach 场景走 `freopen`，所以文档开头那段代码在分支**外**统一 `setvbuf(_IONBF, 0)` 关缓冲——否则写向新句柄的输出要等进程退出才 flush。

## 5. 排查弯路记录（防再犯）

- **`GetCommNameA` 不存在**：想用"从句柄反推设备名"来区分 pipe/console，`GetProcAddress("kernel32.dll","GetCommNameA")` 在 XP 和 Win7 都返回 `NULL`；直接 `#pragma comment(lib, kernel32)` 外部引用会让 exe 加载失败（导入表找不到该导出）。放弃。
- **`SetConsoleActiveScreenBuffer` 在 XP 上用不了**：它要求传入的句柄是 console screen buffer；XP 继承的是 pipe，调用直接失败（`sb0=0`）。Win7 上可成功但对结果无影响。没有它迭代过一轮，白跑。
- **SMB 缓存导致"旧 exe"陷阱**：编译产物覆盖到共享目录后，VM 仍可能吃到旧映像（且 `qwin-x86.exe`/`qwin.exe` 同名覆盖时奇偶 bug 极难排查）。**换一个新文件名立即生效**；`http_test.sh` 内部多次编译后的 smoke 测试要留意。
- **VM 实际读 `_build/l.bat`，不是 `docker/ci_share/l.bat`**：`docker/ci_share/quickwin` 是 `_build` 的 symlink，`Z:\quickwin` 经 SMB 映射到 `_build`，VM 里 `cmd /c l.bat` 的工作目录就是 `_build`。探针脚本写错位置会看着"没生效"。
- **批处理文件记得 `unix2dos`（CRLF）、循环变量写 `%%F`**：LF 行尾的 `.bat` 会被 cmd 异常解析，`for %%F` 写成 `%F` 直接终止脚本。探针 `l.bat` 一律 `printf` 时保持 CRLF 或末尾用 `unix2dos`。
- **`.agents` 目录下的探针产物不要留在 `_build/`**：`_build/` 是 gitignore 的，但 `docker/ci_share/*.bat` 曾误留过 `j l m` 等探针文件（已清理）。

## 6. 遗留差异：XP 攒批 vs Win7 逐行（与 main.c 无关）

同样的 `/exec` 定时打印脚本（每 700ms 一行，共 6 行）：

- **Win7**：逐行到达——客户端在 `0.31s / 0.93s / 1.54s / 2.46s / 3.08s / 3.69s` 各收到一行（每行 3 字节 CRLF），实时流式。
- **XP**：约 4s 一次性吐出，6 行齐全（`x-exit-code: 0`，无 hang），但**不流式**。

成因：攒批发生在 **winpty agent 的 CONOUT 转发** 这一层（XP 上 agent 给 cmd 的是 pipe，agent→worker 转发循环攒批；Win7 上 agent 用 console screen buffer，读粒度细）。**2026-09 探针实测：绕开 agent、直接用 `CreateProcess + CreatePipe` 时，XP 同样逐行实时到达**（见 §7.5）——证明攒批完全在 agent 中转，与 `main.c` 无关，管道方案反而能绕掉它。

## 7. CreateProcess + CreatePipe（已替代 winpty，2026-09 双系统验证）

worker 一开始用 winpty 是因为它给子进程"真控制台语义"，但当前 `/exec` 从不交互、只捕获输出，winpty 的看家本领（`WriteConsole`/屏幕缓冲/键盘回灌）其实没用到。**已在 `exec_server_worker.ts` 落地替换：直接 `CreateProcess + CreatePipe`，完全不用动事件循环，XP 流式还优于 winpty（§7.5）。**

验证方式：`make exec_server` → 容器 `docker/run.sh <vm> --restart`（VM 读 `_build/exec_server.exe`）→ `docker/http_test.sh`：XP 547/548（failed=1 打印机容忍）、Win7 553/553 全过；冒烟 `print('你好')` 输出 `e4 bd a0 e5 a5 bd`（UTF-8）判定新 worker（旧 winpty 会是 GBK `c4 e3 ba c3`）。

### 7.1 为什么不需要碰事件循环

worker 的读循环**本来就是同步阻塞的**（`exec_server_worker.ts` L128-138）：

```ts
for (;;) {
    if (K.readFile(hOut, buf.buffer, 4096, nRead, 0)) {
        const n = ...
        if (n === 0) break
        parent.postMessage({ type: 'data', chunk: ... })
    } else break
}
```

管道方案下**这一行都不用改**，只把句柄来源从 `CreateFile(conout)` 换成 `CreatePipe()` 的读端。`ReadFile` 阻塞在独立 worker 线程里自转，主线程事件循环不受影响；换句话说不做 overlapped IO 就不需要把句柄挂进 qwin 的 `js_event`，那才是真正需要动事件循环的路。

### 7.2 与 winpty 的差异（代价）

| | winpty | CreateProcess+pipe |
|---|---|---|
| 子进程看到的 stdout | 真 console screen buffer | pipe |
| `printf`/cmd 内部命令 | ✓ | ✓ |
| `WriteConsole`/`CONOUT$` | ✓ | ✗（`color`/`cls`/`title`、REPL 会退化） |
| 交互输入 | ✓ | ✗（当前不用） |
| 编码 | console 代码页字节 | 各程序原生编码（qwin= UTF-8、cmd= GBK，见 §7.5） |
| 流式 | Win7 逐行 / XP 攒批 | **XP 也逐行实时**（实测 §7.5，优于 agent 中转） |
| FFI 面 | config/spawn/error 全套 | `CreatePipe`+`CreateProcessW`+`STARTUPINFO` 更省 |

**可用边界**：凡依赖"自己在真控制台里"的程序行为都会因 stdout 是 pipe 而降级或失效。`/exec` 的候选命令要是 `cmd 内建 + qwin 脚本 + 普通 exe`（均在 XP 实证的可用范围），这个方案就是干净的替代。

### 7.3 句柄继承设置（否则莫名卡死）

EOF 语义变化是入坑点：**管道 EOF = 所有写端句柄都关闭**（不是 winpty 的"agent 退出断 CONOUT"）。

1. 子进程要继承**写端**：`CreatePipe(&hRead,&hWrite,NULL,0)` 后 `SetHandleInformation(hWrite, HANDLE_FLAG_INHERIT(0x1), 0x1)`；
2. **读端必须不可继承**：`SetHandleInformation(hRead, 0x1, 0x0)`——否则子进程继承读端，EOF 的引用计数永不归零，`ReadFile` 永远等不到 `ERROR_BROKEN_PIPE`，读循环永久阻塞（且 XP/Vista 无 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 可用）；
3. `STARTUPINFO.dwFlags |= STARTF_USESTDHANDLES(0x100)`，`hStdOutput = hStdError = hWrite`；
4. `CreateProcessW(..., bInheritHandles=TRUE, ...)`；
5. **父进程立刻关闭自己的 hWrite 副本**——不然父侧也持有写端，EOF 同样不触发；
6. 收尾 `CloseHandle(hThread)`，结束 `WAIT` + `GetExitCodeProcess`，关 `hRead`/`hProc`。

### 7.4 EOF 与退出码语义

- winpty：agent 在子进程退出后关 CONOUT → 读端断 → 循环收尾；
- 管道：只要**进程树里还有任何进程持有写端**，读端就等下去。所以 `cmd /c qwin-x86.exe ...` 里 cmd 提前退出没关系——qwin 继承了写端，EOF 会推迟到 qwin 真正退出，输出反而不会丢（这也顺带解释了为何 `/exec` 现在用 winpty 时也是全量输出）。
- 退出码：`CreateProcessW` 直接返回进程句柄（`PROCESS_INFORMATION.hProcess`），`WaitForSingleObject(INFINITE)` 或读完后 `GetExitCodeProcess` 同步取，比 winpty 拿 pid 更省事；超时 `taskkill /T /PID` 机制不变。

### 7.5 实测结果（2026-09，ia32 探针 `probe3.js`，XP + Win7 结果一致）

全部用例 `CreateProcessW + CreatePipe` 捕获成功：EOF= `ERROR_BROKEN_PIPE`(109) 正常收尾、退出码正确（无 hang、无需超时兜底时即拿到 exit）。

- [x] **qwin 继承管道**：`cmd /c qwin-x86.exe -e "print(123)"` → 输出全量捕获，exit=0
- [x] **cmd 中文**：`echo 你好` → **GBK** `C4 E3 BA C3`（系统代码页）
- [x] **qwin 中文**：`print('你好')` → **UTF-8** `E4 BD A0 E5 A5 BD`（QuickJS `print` 直接写 UTF-8）
- [x] **流式粒度**：cmd `for`+`ping` → 双系统均 t=0/1s/2s/3s/4s 逐行到达；qwin 定时 print（500ms×5）→ t=31/531/1031/… ms 逐行到达。**XP 不攒批**，直接管道优于 winpty agent 中转
- [x] **编码差异（与 winpty 的关键不同）**：管道无统一代码页转换，各程序输出自己的原生编码——qwin=UTF-8、系统命令=GBK，客户端需分别解码（`http_test.sh` 中文断言回归时留意）
- [x] 行尾：双系统均为 `\r\n`（qwin 继承 cmd 文本模式 stdout，与 winpty 输出一致）
- [x] 失败教训：一开始 `cmd.exe` 无全路径、靠 PATH 查找 **失败**（err 267 `ERROR_DIRECTORY`/123 `ERROR_INVALID_NAME`）→ 用 `GetSystemDirectoryW` 拼全路径即解决。CreateProcess 的 PATH 解析在本环境不可依赖

## 8. 验证入口

- `docker/http_test.sh xp` → XP（`qwin-x86.exe`，ia32），结果 `547/548 (failed=1)` PASS（该 1 例是 http_test.sh 注释认可的 printer ffi 已知差异）
- `docker/http_test.sh win7` → Win7（`qwin.exe`，x64），结果 `553/553` PASS
- 冒烟：宿主机 `curl POST /exec` 到 `http://127.0.0.1:8005`（XP）/ `8007`（Win7），XP 控制台与 `> out.txt` 都应看到输出。