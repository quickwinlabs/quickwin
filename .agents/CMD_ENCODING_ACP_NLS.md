# /exec 中文命令 lossy 的根因：cmd 的 ACP + NLS 依赖

相关文档：`examples/exec_server_worker.ts`（CreateProcessW 链路）、`examples/exec_server.tsx`（POST /exec）、`.agents/TODO.md` L11（旧结论待更正）。

---

## 1. 一句话结论

`/exec` 下发含中文命令时**回显**变 `?`，**不是**我们的输入编译、worker 编码、也不是 cmd 的入参/文件系统操作问题——cmd 内部全程 UTF-16 无损（磁盘真名始终是中文），丢字只发生在 **cmd 把输出文本（echo 内容、dir 列出的文件名）写入 stdout 时按代码页编码成字节** 这一步。编码结果受两处环境控制：

- `HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage` 的 `ACP` / `OEMCP` / `MACCP`
- `C:\Windows\System32\c_*.nls`（以及 SysWOW64 下 32 位对应物）码页转换表

win11 CI 镜像（Tiny11 Core 25H2，英文精简版）默认 **ACP=1252 / OEMCP=437 / MACCP=10000 且缺全部 `c_*.nls`**：中文在 1252 无映射、转换表又加载不到 → 输出编码时 best-fit 统一替换成 ASCII `3f`（`?`）。win7/xp 官方镜像 ACP/OEMCP=936 且 `c_*.nls` 齐全，同一代码路径天然正常。

> ⚠️ TODO.md L11 旧结论 "cmd /c echo %* 回显 %* ?? 证明替换发生在进 cmd 之前（输入侧）" **已被推翻**。实测 `cmd /u /c echo 你好` 输出 UTF-16LE 无损，证明输入侧（CreateProcessW 命令行）完好，坏点仅在 cmd 输出编码——**并非**执行前的 ACP 投影。
>
> ⚠️⚠️ 我此前笔记（§5/§6 旧版）曾推断"md 的执行前也被投影、建出 `????` 目录"，**同样被推翻**：未修复 Tiny11 上 `md 一` 磁盘真名是 UTF-16 `00 4e`（无损），`cd`/`rmdir` 用真正中文名全部成功；`dir /b` 显示 `qw????` 只是**回显层**把名按 1252 编码成 `?`。

---

## 2. 输出编码有损的两个必要条件

cmd 输出文本（echo/dir 等）写入 stdout 时把 UTF-16 按代码页编码成字节，要**无损**，两个条件**必须同时**成立：

- **输出代码页对**：cmd 输出编码的目标代码页取自 ACP 等（注册表 `Control\Nls\CodePage`），中文场景须为 936；
- **映射表在**：该码页有可加载的 `c_*.nls`（DBCS 码页依赖文件，表中含多字节映射）。

缺任一 → 中文编码退化为 `3f`：

| 场景 | ACP | c_*.nls | 结果 |
|---|---|---|---|
| win7/xp 官方中文镜像 | 936 | 有 | 输出 GBK 无损 |
| Tiny11 原始 | 1252 | 无 | 输出 `??` |
| 只补 NLS，ACP 仍 1252 | 1252 | 有 | 仍 `??`（1252 无中文映射） |
| 只改 ACP=936，无 NLS | 936 | 无 | 无表可查，同样退化 |

注：SBCS 码页（如 1252）转换表为 ntdll 内建，**不依赖** `c_*.nls`——所以 Tiny11 转英文/西欧正常，恰好证明缺表只影响 DBCS 中文码页。

Tiny11 同时犯两错（ACP=1252 且删光 nls），表象上"缺表"似为主凶，实为**变量耦合**。**修复必须两条件都补**（补 `c_936.nls` + 注册表 ACP/OEMCP/MACCP=936），缺一样都白修——现有运行时修复恰好两者都满足。

---

## 3. 全程字节串（`cmd /c echo 你好`）

已在 win11 实测归纳（输出编码对比：已修复 overlay ACP=936；关键 `/u`/`md` 探针在未修复环境重新验证），链路 8 阶段：

| 阶段 | 载体 | 字节串 / 说明 |
|---|---|---|
| 1. Host curl 请求体 | HTTP body（UTF-8 JSON） | `7b 22 63 6d 64 22 3a 22 ... e4 bd a0 e5 a5 bd ... 22 7d`（「你好」UTF-8 = `e4 bd a0 e5 a5 bd`） |
| 2. exec_server 解析 | JS string（内部 UTF-16） | `exec_server.tsx:434` `req.json()`，无损 |
| 3. worker 拼命令行 | JS string | `exec_server_worker.ts:147` `sysDir + "\cmd.exe /c " + cmd` |
| 4. CreateProcessW 传参 | UTF-16LE 内存 | `exec_server_worker.ts:148`（绑定 `wchar_ptr`）「你好」=`60 4f 7d 59`，**无损** |
| 5. cmd 接收 | cmd 内部 UTF-16 | 同上无损（未修复环境下 `cmd /u /c echo 你好` 探针 → 输出 `60 4f 7d 59 0d 00 0a 00`，即**内部保有 UTF-16**） |
| 6. cmd 输出编码 | 按目标码页编码成字节 | 写 stdout 时才编码：936 → `c4 e3 ba c3`（GBK）；1252+缺表 → `3f 3f` |
| 7. readFile 原样回传 | 字节流直通 | `exec_server_worker.ts:165`，零转换，连流式都不做 |
| 8. Host 收到 body | 原始字节 | 与阶段 6 相同 |

链路上游（1–5）和下游（7–8）都是**字节直通**；丢字只发生在阶段 6 的**输出编码**。注意：`cmd /u` 探针在**未修复**环境（ACP=1252+缺表）也输出 `60 4f 7d 59`，证明 cmd 从未在入参侧投影——`/u` 只是把"输出写成 UTF-16LE"绕开阶段 6，所以 `/u` 能让 echo 无损，而默认输出（按 ACP）中文就变 `??`。

---

## 4. 为什么 cmd 输出要按代码页写字节

cmd.exe 是控制台程序，stdout 默认是一个**字节流**（继承父进程句柄，或 exec 场景下是管道），不是"宽字符流"。历史上要同时伺候：

- console I/O 默认按控制台输出代码页写字节（`WriteFile`/`WriteConsoleA` 写 ACP/OEM 字节；`WriteConsoleW` 仅直接打屏路径可用）
- 下游工具（`findstr`/`more`/第三方 exe）大多为 ANSI 程序，只认 OEM/ANSI 字节
- exec_server 用管道接管进程 stdout，管道里只能按字节编码

所以 cmd 的处理管线是：**宽命令行入参（UTF-16 无损）→ 命令执行（内部命令拿到的参数仍是 UTF-16）→ 输出文本按代码页编码成字节写 stdout**。`/u` 只改最后"写出"一步的编码（强制 UTF-16LE），把阶段 6 绕过——因此 `/u` 让 `echo` 无损（未修复环境也实测无损）。但它不改磁盘/文件系统行为，因为那里本来就走宽字符 API（阶段 6 根本不参与）。

---

## 5. echo 与 md：参数无损，只有"输出"有损

**实测修正**（未修复 Tiny11，ACP=1252+缺表）：cmd 内部命令拿到的是 **UTF-16 无损参数**。区分两类命令：

```
cmd 收到命令行 ──► UTF-16 内存（无损，CreateProcessW 直通）
                        │
       ┌────────────────┴───────────────┐
       │                                │
   echo（输出方向）                  md/cd/rd（文件系统方向）
   │                                │
 把内部文本按代码页编码写 stdout    直接调 CreateDirectoryW /
 （阶段6，ACP=1252→中文变 ??）     SetCurrentDirectoryW（UTF-16，无损）
```

| | echo | md |
|---|---|---|
| 参数 | UTF-16 无损（未修复 `/u` 探针证实） | UTF-16 无损（磁盘真名中文为证） |
| 分叉点 | 写 stdout 时按代码页编码 → 中文变 `?` | 无分叉，宽字符直达 API |
| 未修复表现 | `3f 3f`（1252 输出编码） | 建出**真中文**目录（`dir /u` 读出 UTF-16LE），`dir /b` 回显才 `qw????` |
| 修复后（936） | 输出 `c4 e3 ba c3`（GBK 字节） | 依旧建真中文目录 |

两个关键修正点：

1. **md 从未建出问号目录**。之前"建出 `qw????`、rd 报 syntax error"是**误读**：当时只看了默认 `dir /b`（回显层按 1252 编码 → `?`），没看磁盘真名。用 `cmd /u /c dir /b` 读出 `71 00 77 00 2d 4e 87 65 4b 6d d5 8b`（UTF-16LE `qw中文测试`），`cd /d C:\qwt\qw中文测试` 与 `rmdir`（真名）都 RC=0 成功。SMB 共享盘宿主侧 `ls` 也显示 UTF-8 中文名。
2. **`/u` 在任何环境都无损**：未修复（ACP=1252+缺表）`cmd /u /c echo 你好` → `60 4f 7d 59`。因为 cmd 内存里本来就是 UTF-16，`/u` 只是让输出不再按代码页编码而是直接写 UTF-16LE——它绕过的是**阶段 6 输出编码**，不是"保全 cmd 内部"。同理 md 根本不需要 `/u`，它从不经过阶段 6。

结论落点：对 echo 而言 lossy 在"输出编码"（exec_server 拿到的字节不可还原，除非 `/u`）；对 md 而言**文件系统操作全程无损**，`?` 只在把所有名字重新按 ACP 回显时出现——**文件系统操作根本不是问题所在**。

---

## 6. 未修复 vs 修复实测对照（win11）

同一份代码、同一台 VM 图，仅环境不同，差异只在阶段 6（echo 的输出编码）：

| 状态 | `cmd /c echo 你好` | `cmd /u /c echo 你好` | `md 一 && cmd /u /c dir /b` |
|---|---|---|---|
| **未修复**（win11_ready 快照，ACP=1252+缺 NLS） | `3f 3f 0d 0a` = `??` | `60 4f 7d 59 0d 00 0a 00` = **UTF-16LE 无损** | 建目录成功，真名 UTF-16 `00 4e`（中文无损）；`rd 一`（真名）RC=0 成功 |
| **已修复**（overlay：补 c_936.nls 两处 + 注册表 936 + 重启） | `c4 e3 ba c3 0d 0a`（GBK）+ CRLF，`iconv GBK→UTF-8` 还原「你好」 | `60 4f 7d 59 ...`（UTF-16LE，与未修复相同） | 建/删真中文目录同样正常 |

即：修复只改变**默认输出**的编码（1252→936 字节可还原），`/u` 与文件系统方向两边本来就一致。

修复操作（运行时验证过）：
1. 从 win7 提取 `c_936.nls`（196,642 B，2009 版），拷进 win11 的 `System32` 与 `SysWOW64`
2. `reg add HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage`：`ACP`/`OEMCP`/`MACCP` 均设 `936`
3. 重启（ACP 生效需要重启）

相关已验证探针：`chcp` → 936；`echo 中文` → GBK 正确；`md 中文目录` 正常建/删（真名中文，本就不用修）；`qwin -e "print('中文测试')"` → UTF-8 正确（qwin 走 W 面，与 ACP 无关）。

---

## 7. 与右键菜单传参的关联（辨析）

用户右键菜单传中文路径"感觉是 GBK"，与 exec_server 是**同根异处**：

| | 右键菜单 `%1` | exec_server `/exec` |
|---|---|---|
| 转换发生地 | **目标进程的 ANSI 入口**（`WinMain(LPSTR)`/`main(char**)`/`GetCommandLineA`，由系统/CRT 按 ACP 转，参数本身被转换） | **cmd 输出回显**（参数无损，写 stdout 时按 ACP 编码成字节） |
| 中文系统（ACP=936） | 收到 GBK（特性，非 bug） | 输出 GBK，正常 |
| Tiny11（ACP=1252+缺 NLS） | 收到 `?`（参数侧坏了） | 输出 `??`（回显坏了，参数/文件系统仍无损） |

**统一认识**：命令行的"原生"形态是 UTF-16（`RTL_USER_PROCESS_PARAMETERS.CommandLine`）。**A 面路径**（`GetCommandLineA`/`CreateProcessA`/目标进程 ANSI 入口/右键 `%1`）在**入参方向**按 ACP 转换并受 NLS 控制，会真正毁掉参数；**W 面路径**（`GetCommandLineW`/`wWinMain`/`wmain`/`CreateProcessW` 传 `wchar_ptr`/`cmd /u`）入参无损，但 **cmd 的默认输出**仍按代码页编码成字节（exec_server 场景读到的是编码后的字节）。两条路都受 ACP+NLS 控制，只是作用点不同。

qwin 自身免疫：`main.c:164` 弃用 `WinMain` 的 `LPSTR lpCmdLine`，改走 `CommandLineToArgvW(GetCommandLineW())` + `WideCharToMultiByte(CP_UTF8)` → argv 永远 UTF-8 无损（仅 W 面入口，不涉及任何代码页）。

---

## 8. 结论已定：worker 加 `/u` 规避，不固化 NLS

**采纳方案**：`examples/exec_server_worker.ts` 用 RtlGetVersion 判 NT major≥10（win11），
拼命令行 `cmd /u /c ...`，让 cmd 内置输出直接写 UTF-16LE，**绕开 ACP 转换**（不存在
"转换 → 退化"一步，天然无损）。win7/XP（ACP=936 本就无损）保持原样，避免改变输出协议。

**验证（win11_ready 未修复快照 + 新 worker）**：
- `echo 你好` → `60 4f 7d 59 0d 00 0a 00`（UTF-16LE 无损，改造前 `3f 3f`）
- `qwin.exe test/run.js` 全量 → `Summary: 466/471`，qwin 是子进程输出 UTF-8 裸字节，
  CI `grep Summary` 不受 `/u` 影响（对照：A/B 切换 worker 复测一致，wasm 5 失败为 win11 快照固有）
- `/u` 只作用于 cmd 内置命令（echo/dir/type）；子进程自身输出编码不变

**未走 NLS 固化路线**（补 `c_936.nls` + 注册表 936 + 首启自重启约 +60s CI，曾验证有效但
成本高、改系统），相关探针脚本与 win7 提取的 `c_936.nls` 资产已随收尾删除。

**注意**：win11 下 `/exec` 的 cmd 内置输出现在是 UTF-16LE（ASCII 后带 `00`），调用方
如需还原文本需按 UTF-16LE 解码；外部程序（qwin 等）输出仍为其原生编码。

- TODO.md L11 已随之更正（原"影响 mkdir 中文目录"为误判：文件系统操作本就无损；
  真正坏点仅 cmd 内置回显，由 `/u` 规避）