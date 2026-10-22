# Win11 镜像的 Defender（标准 tiny11 / tiny11 core）

对应实现：`docker/run.sh`（变体）、`docker/setup-win11.sh`（装机 + 软盘）、
`docker/floppy-win11/deftweak-pe.cmd`（PE 阶段离线关 TP）、`docker/ci_share/run.bat`（Win11 开机默认关实时保护）。
2026-10-16 在标准盘上逐项实测。

## 1. 两套镜像

| 变体 | 母盘 | 说明 |
|------|------|------|
| `./run.sh win11` | `snapshots/win11_ready.qcow2` | **标准 tiny11 25H2**，自带 Defender、可服务化（WU 可用） |
| `./run.sh win11core` | `snapshots/win11_ready-core.qcow2` | **tiny11 core**，Defender 已剥离（旧基线） |

端口同为 **8011**（Win11 = 8000+11），同一时刻只跑一台。core 快照需先 `./setup-win11.sh win11core` 生成（标准盘同理 `./setup-win11.sh win11`）。

> **无 TPM / Secure Boot**（2026-10-17 起）：装机与运行都用普通 4M OVMF（pflash），硬件检查在
> WinPE 阶段由 `Autounattend.xml` 的 `LabConfig` 绕过。原有配置的 TPM/SB 从未被依赖
> （BitLocker=Off、TPM 状态与 VARS 每轮重建），去掉后行为不变。这一层与 Defender 无关。

> **两份构建，别混**：`win11_ready.qcow2` 是用 `docker/iso/win11/Tiny11-25H2-26200.8037-English-Pro-2026-08-23.iso`
> （SourceForge，kelexine/tiny11-automated 构建，5.1GB）装的，**本文所有实测都在这份构建上做的**；
> 而权威发布源是 assets 仓 `win-isos-tiny11-std`（CI 从 archive.org 的 NTDEV `tiny11_25H2_Nov25.iso`
> 发布，5.3GB）——**两份是不同字节**。本环境到不了 archive.org，故 Nov25 上未复测；
> TP/开关/定义库/不干扰回归这些结论预期一致，换盘时值得重跑 §4 冒烟与 §6 全量。
> 取盘与发布流程见 `.agents/skills/workflow/SKILL.md`「测试镜像（ISO）来源与发布」。

## 2. 开关：为什么运行期能切实时保护

前提是 **Tamper Protection（TP）先关掉**。TP 开着时运行期 `Set-MpPreference` 一律被拒（WdFilter + ACL），
而 TP 只能在**装机 PE 阶段离线改 hive**：

- `deftweak-pe.cmd`（WinPE，`Autounattend.xml` 的 `RunSynchronous` 起）轮询等目标卷出现，`reg load` 离线
  SOFTWARE hive，写 **`TamperProtection=4` + `TamperProtectionSource=2`**。
  ⚠️ **`0` 是 Win10 的值**，Win11 视为无效、首次启动会回落成 1/5——必须写 4/2。
- 运行期切换：`Set-MpPreference -DisableRealtimeMonitoring $true/$false`，`Get-MpComputerStatus.RealTimeProtectionEnabled`
  随即反映状态（实测双向即时生效）。
- 开机默认安静：`run.bat` 对 `10.0.*` 每次开机 `Set-MpPreference -DisableRealtimeMonitoring $true`（回归不受干扰）；
  要测 Defender 再用 execd 一条命令开回来。
- 落地实测量：`IsTamperProtected=False`、`AMRunningMode=Normal`、live hive `TamperProtection=4` / `TamperProtectionSource=2`。

## 3. 定义库：镜像自带的是旧的，但开机约 2 分钟后自动变最新

| 时点 | 定义库 | 引擎 | 状态 |
|------|--------|------|------|
| 装机自带 | **1.437.1.0**（2025-09-16） | 1.1.25080.5 | `AntivirusSignatureAge=394`、`DefenderSignaturesOutOfDate=True` |
| 开机 ~2 分钟后 | **1.461.43.0**（= 当天 WU 发布的最新） | 1.1.26100.4 | `AntivirusSignatureAge=0`、`OOD=False` |

- 标准 tiny11 可服务化：`wuauserv` RUNNING，开机后 Windows Update 自动装 **KB2267602**（Security Intelligence
  Update），事件见 `Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WindowsUpdateClient'}`（ID 19 = 安装成功）。
- **手动 `MpCmdRun.exe -SignatureUpdate` 会撞车**：WU 正在装东西时它秒失败 `hr=0x80070652`（= `ERROR_INSTALL_ALREADY_RUNNING`），
  **不是网络问题**（实测 `www.microsoft.com:443` 与 DNS 均通）——避开开机头几分钟或重试即可。
- **更新不落盘**：`run.sh` 每次重建 overlay（`snapshots/win11_test.qcow2`），运行期更新随 overlay 丢弃。
  要"每轮都钉住某个库版本"且不依赖 guest 出网：容器里下 `mpam-fe.exe`（x64，`https://go.microsoft.com/fwlink/?LinkID=121721&arch=x64`）
  → 放共享 → guest 里 `Start-Process -RedirectStandardOutput <日志>` 装（**尚未落地**）。
- core 盘没有 Defender，以上都不适用。

## 4. 冒烟实测（EICAR 标准测试串）

EICAR 68 字节、sha256 `275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f`。
用 base64 注入写文件，避开 cmd 对 `% ^ ) !` 的转义：

```
powershell -NoProfile -Command "[IO.File]::WriteAllBytes('C:\qwtmp\eicar.com',[Convert]::FromBase64String('WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo='))"
```

| 操作 | 结果 |
|------|------|
| 实时保护**关** → 写 EICAR | 写入成功、**无检出**（关了真不扫） |
| 实时保护**开** → 读 / 再写 | **`read=blocked`**（访问被拦），随后文件被删；`Get-MpThreat` = `Virus:DOS/EICAR_Test_File` / ThreatID 2147519003 |
| 实时保护**关** + `MpCmdRun.exe -Scan -ScanType 3 -File <绝对路径>` | `found 1 threats` → `Cleaning started/finished` → 文件消失（**关着实时保护也能按需扫描**） |
| 对照：扫正常 exe 的本地副本 | `found no threats`（不误报） |

> `-File` 必须给**绝对路径**；相对路径（含先 `cd` 再传裸文件名）实测报 `hr=0x80508023`。

**全开跑回归**：实时保护全开时 `./http_test.sh win11` → 与基线逐条一致（2026-10-16 时点 `1331/1336`；
suite 集会变，以 `http_test.sh` failed≤1 与基线逐条对照为准：窗口枚举×2、printer RAW×2、
UNC exe path 为既有失败）→ **Defender 全开不干扰正常 exe 与测试流程**。

## 5. 坑（都是这轮实测踩到的）

- `MpCmdRun -SignatureUpdate` 撞 WU → `0x80070652`（§3）。
- **别用 execd 去验 `deftweak-pe.cmd`**：它是为 PE 窗口写的（探测条件 = 目标卷存在 `SOFTWARE` **且**有 `.LOG1`，
  而 `.LOG1` 只在装机 PE 期间存在），且运行期 execd 是 32 位——WOW64 把 `C:\Windows\System32\config` 重定向到
  `SysWOW64\config`（访问真 hive 要走 `Sysnative`）。要验它的效果只能看装机 PE 的 `deftweak-pe.log`。
- **guest 里起后台任务别用 `start "" /min <script>`**：孙进程持有 execd 的管道写端 → `/exec` 不返回
  （机制见 `.agents/CONSOLE_STDOUT_MECHANISM.md` §7.6）。用 `... > C:\qwtmp\x.log 2>&1` 或 `Start-Process -RedirectStandardOutput <file>`。

## 6. 验证入口

```bash
# 容器内
cd docker
./run.sh win11                    # 起 VM（首启 ~50s，等 execd 健康）

# 查库状态（execd 在 :8011；body 可选 "timeout":毫秒，不给则无上限，见 CONSOLE_STDOUT_MECHANISM.md §7.6）
curl -sS -X POST http://127.0.0.1:8011/exec -H 'Content-Type: application/json' \
  --data '{"cmd":"powershell -NoProfile -Command \"(Get-MpComputerStatus).AntivirusSignatureVersion\"","timeout":60000}'

# 切实时保护（$false 开 / $true 关）
curl -sS -X POST http://127.0.0.1:8011/exec -H 'Content-Type: application/json' \
  --data '{"cmd":"powershell -NoProfile -Command \"Set-MpPreference -DisableRealtimeMonitoring $false\""}'

./http_test.sh win11              # 实时保护全开时也应 1331/1336
./run.sh win11 --stop
```
