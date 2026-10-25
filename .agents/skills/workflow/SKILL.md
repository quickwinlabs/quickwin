---
name: workflow
description: 在 quickwin 仓库执行构建（make）、测试、QEMU VM 启停与验证、排错、CI 对照、execd 打包、gen_const、镜像取盘等流程操作时加载。含容器内黄金命令、构建速查、常驻测试模式与常见故障表。
---

# QuickWin 开发流程

## 环境

| 环境 | 职责 |
|------|------|
| **宿主** | git、编辑器、文档、opencode。不编译、不跑测试 |
| **容器** `quickwin-dev` | `make`、`make test`、QEMU 装机与测试。改动经挂载同步，提交仍在宿主 |

容器 = `docker/Dockerfile.dev`（Fedora + posix mingw + QEMU + Samba），仓库挂 `/workspace`。
宿主侧命令一律用 `docker/qc` 包一层（规则见 AGENTS.md），复合命令
`./docker/qc bash -c 'make js && cd docker && ./run.sh win7'`；CI 本身在容器内，不用 qc。
首次准备 `git submodule update --init --recursive`（宿主或容器均可）；取预装盘见「镜像获取」。

**路径与端口映射**（宿主 ↔ 容器 ↔ guest）：

| 宿主 | 容器 | guest |
|------|------|-------|
| 仓库根 `.` | `/workspace`（compose `..:/workspace:Z` + working_dir） | — |
| `docker/snapshots/` | `/workspace/docker/snapshots/` | — |
| `_build/` | `/workspace/_build/` | `Z:\quickwin`（symlink，smbd `wide links = yes`） |
| `docker/ci_share/` | `/workspace/docker/ci_share/` | `Z:\`（SMB 共享根） |
| `/dev/kvm` | `/dev/kvm`（device 直通） | — |

`run.sh` 开头 `cd "$(dirname "$0")"`，故其内**相对路径** `snapshots/x.qcow2` 在容器解析为
`/workspace/docker/snapshots/x.qcow2`、在宿主即 `docker/snapshots/x.qcow2`——同一文件，
两侧都能读写与校验。改成绝对路径会破坏这一性质。

端口三段：宿主↔容器 noVNC `6005`(XP) / `6007`(Win7) / `6011`(Win11)；
容器↔guest `hostfwd` `8005`(XP) / `8007`(Win7) / `8011`(Win11) → guest `:8080`（execd）；
guest↔容器 `guestfwd` `10.0.2.4:445` → `smb_wrapper.sh` 自管 smbd（SMB1 + wide links）。
guest 内测试服务器 `18923`/`18924` 由 `run.bat` 用 portproxy 转到宿主侧 `serve_test`。

## 日常开发循环

### 编译

```bash
make cc64              # 64 位 → _build/qwin.exe（默认 BUILD=fast）
make cc32              # 32 位/XP → _build/qwin-x86.exe
make cc64 BUILD=small  # -Os + LTO，发行体积（CI 用）
make js                # TypeScript → JS（改 .ts 后必跑）
make debug             # -DDEBUG 打开 bridge 日志
```

### 自测

```bash
make test TEST=-net    # 跳过网络测试（日常推荐）
make test TEST=wasm    # 只跑 WASM
make test              # 全量（含外网，慢）
```

### 其他构建目标

| 目标 | 说明 |
|------|------|
| `cc64-nowasm` / `cc32-nowasm` | 不含 WASM/WAMR |
| `execd` | 打包 `examples/execd/main.tsx`，Brotli 内嵌进 `_build/execd.exe` |
| `wat` / `wasm` | WAT → WASM fixtures |
| `BUILD=fast\|small\|debug` | 构建 flavor，默认 fast |

### 中间产物（arch × native/cross 隔离）

```
_build/
  obj/{x64,ia32}-{cross,native}-{fast,small,debug}[-nowasm]/  # .o .d libquickjs.a
  deps/{x64,ia32}-{cross,native}/   # libiwasm.a libwolfssl.a libbrotli*.a + cmake build/
  version.h                         # 由 package.json 生成
  gen_const.exe · *.exe
```

切 32/64 无需手动清 deps；`make clean` 清掉整个 `_build/`，源码树不再产生构建产物。

**不要单独 `make wamr`**：不带 `CROSS=1` 会用本机 gcc 建 ELF `.a`，之后 `cc64` 发现 `.a`
比源新就跳过重建，链接必挂。WAMR/WolfSSL/Brotli 由 `cc64`/`cc32` 按正确架构自动构建。

WAMR 关键 flag（改前先确认）：`WAMR_DISABLE_HW_BOUND_CHECK=1`（工具链不支持 MSVC `__try`/`__except`）、
`WAMR_BUILD_INVOKE_NATIVE_GENERAL=1`（纯 C 版 invokeNative，否则编译 MSVC `.asm` 后链接未定义）、
`WAMR_BUILD_EXCE_HANDLING=0`（开着时 `WASMModule` 结构体偏移易错位，读字段得垃圾值）。

WASM 导出到 JS 用 `JS_NewCFunctionData`（`magic` 传函数 ID）；`JSClassDef.call` 方案无效，
设置导出属性后不要 `JS_FreeValue`。

XP 32 位有子模块 patch（`patches/*-xp-compat.patch`、`patches/quickjs-export-from-base64.patch`），
构建前由 Makefile 幂等 apply。**子模块改动不直接提交**，一律走 patch 文件。

## QEMU VM 验证

原理见 `docs/qemu-xp-automated-testing.md`。日常只需：

### 镜像获取

```bash
./docker/scripts/fetch-ready.sh <win7|xp|win11>   # → docker/snapshots/<vm>_ready.qcow2
```

本仓**不装机**：盘由 `quickwinlabs/assets` 的 `win-images-*` release 供给（现场装机 → qcow2
压缩簇 → 分卷，`SHA256SUMS.txt` 兼作 manifest），装机逻辑的唯一维护地是 assets 仓。
压缩簇是**只读形态、需 qemu >= 5.4**；`run.sh` 本来就会叠 overlay，直接可用。
校验流程与 `ASSETS_BASE`（大陆直连仅 ~0.5 MiB/s 时指 ghproxy 前缀，或改用
`github-release-download` skill，实测 6–14 MiB/s）见脚本头注释。

### 每次测试（常驻模式）

VM 开机只起 `execd`；测试经 `http_test.sh` HTTP 下发，可反复执行：

```bash
cd docker
./run.sh win7              # 已在跑则只查健康；首启等就绪（`/` 返 usage 200，~30–60s）
./run.sh xp
./http_test.sh win7        # POST /exec 跑 test/run.js，解析 Summary，failed≤1 → PASS
./http_test.sh win7 ffi    # 只跑 suite 名含 ffi 的（-net / -wasm 则是排除该 tag）
./run.sh win7 --stop       # ACPI 关机，超时 60s 自动 kill
./run.sh win7 --restart    # 停再起
```

`filter` 是 guest 的 `scriptArgs[0]`（运行时把脚本槽之后的一切原样透传）；匹配 0 个 suite 记为失败
（Summary 0/1），不会假绿。overlay 每轮无条件重建（不吃旧脏状态）。

流程：`run.sh` 杀旧 QEMU → 重建 overlay → `ln -s` `_build` 到 `ci_share/quickwin` →
`unix2dos` run.bat → 启动 → 等 `/`（usage 页 200）。`run.bat` 只做防火墙/portproxy + `start execd`；
`http_test.sh` 内部确保容器 `serve_test :18923`。

只跑 FFI 子集（改 `lib/ffi` 的快速回归）：`make js` 后在 `_build/` 放 `ffi_only.js`——
顺序 `import("./test/" + n + ".js")` 枚举 7 个 `test_ffi_*.js`（套件名见 `test/` 目录），
`new Tester()` 跑 `mod.suite.run(t)` 并汇总 ok/fail/skip，`std.exit(fail ? 1 : 0)`。
POST `{"cmd":"qwin.exe ffi_only.js","timeout":600000}`；XP 换 `qwin-x86.exe`。
期望值见 ffi-dev skill（随用例增减会漂移，不在本文档写）。

> **改了 `examples/execd/` 或其 lib 依赖后，只跑 `make js` 不生效**——guest 跑的 `execd.exe`
> 内嵌的是 brotli 打包的旧 JS。顺序：`make js` → `make execd` → `./run.sh <vm> --restart`
> （原文见 `.agents/EXEC_D.md`）。

### execd（VM 内命令执行面）

接口**自描述**：`curl http://127.0.0.1:8007/`（任意非 API 路径）即返全部端点与参数，用前随手一取，勿凭记忆。
宿主侧唯一要记的：**输出编码** cmd 内置=UTF-16LE、外部程序原生（qwin=UTF-8、中文工具=GBK），
按来源 `iconv` 转；`/u` 决策与有损条件见 `.agents/CMD_ENCODING_ACP_NLS.md`。

### VM 画面验证（视觉回归）

- **execd 端点**（最轻）：`GET /screenshot`——不带 hwnd = 整屏 BitBlt；带 hwnd 默认 `mode=print`
  让窗口自绘（遮挡/最小化/超屏也拿完整像素）；`?area=window|client&mode=screen|print`，返 BMP + `X-Dimensions`
- **`GET /window_list`**：顶层窗口 JSON 含 `minimized`，可直接断言"窗口最小化"
- **monitor socket**（VM 卡界面时）：容器内 `/tmp/qemu-monitor-<vm>.sock` → `screendump <ppm>`
- **noVNC**（实时看）：容器 `./start-novnc.sh`，宿主浏览器开 XP `:6005` / Win7 `:6007`

截图后处理用容器内 `convert`（ImageMagick），两种来源都支持——execd `/screenshot` 的 BMP、
monitor `screendump` 的 PPM：`./docker/qc convert a.ppm -crop 170x55+470+100 a.png`。

### 常见故障

| 症状 | 原因 / 处理 |
|------|-------------|
| VM 内挂不上 Z: | XP 仅 SMB1：须走 `smb_wrapper.sh`（guestfwd + `server min protocol = NT1`），不能用 `-smb` |
| `net use` 成功但不跑 run.bat | `.bat` 必须 CRLF：`.gitattributes` 已 `eol=crlf`，`run.sh` 每次再 `unix2dos` 双保险 |
| 网络测试连不上宿主 | guest `portproxy` 18923/18924 + 容器内 `serve_test` 须都在；由 `run.bat` 每次重建；`http_test.sh` 会自动拉 serve_test |
| `/exec` 超时/不返回 | **无默认上限**：连接活着就一直跑，客户端断连或 body 传 `"timeout"` 毫秒才 kill。实现是 `CreatePipe` + `CreateProcessW` 读循环，**不是 popen**（唯一 popen 是超时后 `taskkill /T` helper）；后代进程持管道写端也会拖住，见 `.agents/CONSOLE_STDOUT_MECHANISM.md` §7.6。真挂死 `./run.sh <vm> --restart` |
| 手写 `/exec` 喂错架构 exe | XP 只认 32 位：喂 x64 会弹"不是有效的 Win32 应用程序"模态框，**无人点时 queue 堵死、后续 /exec 全超时**（像卡死） |
| 按窗口坐标点击/判断落空 | `/window_list` 的 rect 是窗口自身矩形，**不等于屏幕上可见位置**（可能被 execd 自己的 GUI 压着）。先 `/screenshot` 转 PNG 目检再操作 |
| 容器里 `ps`/`pkill` 不存在 | 精简镜像无 procps：自己扫 `/proc/*/cmdline` 再 `kill`，匹配用 `[c]url` 方括号防误杀自己 |
| `/exec` JSON body 命令被截断 | 别用 heredoc 写 body：`\\` 被上层先解码一次，JSON 再把 `\n` 解成换行，cmd 收到断成两截的命令。body 落文件再 `curl --data @file`，发前 `python3 -c "import json;print(json.load(open(f))['cmd'])"` 验一遍 |
| 关机/等待死循环 | 不能用 `kill -0` 判 QEMU（容器 PID1 不回收僵尸）；看 pid **文件是否还在**（QEMU 退出时自行 unlink） |
| 残留 QEMU | `./run.sh <vm> --stop`；pid 残留用 `kill -9 $(cat qemu-<vm>.pid) \|\| true` |
| 改过 C/`qwin*.exe` 后 guest 仍像旧代码 | 已根治：`smb_wrapper.sh` 加 `oplocks = no` + `smb2 leases = no`，覆盖写同路径立即可见（`--restart` 加载新 conf 后生效） |

## CI（ci-qemu.yml）

- **镜像**：仅 `Dockerfile.dev` 变更或 GHCR 无镜像时重建，否则复用 `ghcr.io/quickwinlabs/quickwin-dev:latest`
- **matrix**：`win7`（cc64 + qwin.exe）/ `xp`（cc32 + qwin-x86.exe），`fail-fast: false`
- **缓存**：ready 快照（miss 才 `fetch-ready.sh` 拉 assets 预装盘）；交叉编译 `.a`（key 含 Makefile/patches/deps hash）
- **编译**：`make <deps> BUILD=small` → nowasm → `make js wasm` → `make execd` → 上传 artifact
- **测试**：`run.sh <vm>` 等健康 → `http_test.sh <vm>`（内含 serve_test + POST /exec + Summary 断言，**失败 ≤1 视为通过**）→ `--stop if: always()`
- **发布**：`v*` tag 且测试过 → `make npm-pkg` 发 npm

## CLI 参数（运行时）

```
qwin.exe [options] [script.js]   # 运行 JS
qwin.exe -e <expr>               # 运行表达式（优先于脚本文件）
```

`-d` HTTP 调试日志（stderr）；`-o CON` 输出到控制台（AllocConsole）；`-o LOG` 输出到自动生成的
`log_YYYY_MM_DD_HH_MM_SS.txt`；`-o <file>` 指定文件（stdout + stderr）。

`-o LOG` 的日志在 **exe 所在目录**（非 cwd）。选项按固定槽位 `[-d] [-o 目标] [-e code | 脚本]` 解析，
槽位之后全部原样传给脚本。完整说明见 README「CLI」与「内嵌脚本」。

## Windows 常量（gen_const）

禁止手写数值。流程：在 `tools/gen_const.c` 的 `print_enums()` 加 `DEC(TS_NAME, SDK_MACRO)` →
`make gen-const` 交叉编译 `_build/gen_const.exe` → 在 Windows/VM 里跑它重新生成 `constants.ts` →
TS 里 `import { EnumName } from 'quickwin/constants'` 用 `EnumName.MEMBER`。

`constants.ts` 是真实单文件（tsc/esbuild 均可内联），末尾 `EnumMap` 预填段（`'u32@Name'` 值域表）
由同批输出，无需后处理。enum 名全局唯一，改名前先全局搜。

## 排错索引

| 资料 | 用途 |
|------|------|
| ffi-dev skill | FFI 绑定：签名 token、五条不变式、不支持清单、VM 回归期望值 |
| `docs/qemu-xp-automated-testing.md` | QEMU VM + SMB + bootstrap 原理 |
| `.agents/QEMU_NET_SUITE_TEST.md` | 逐 suite 网络测试与 ipv6/portproxy 历史 |
| `.agents/WIN11_DEFENDER.md` | Win11 两套镜像、TP/实时保护、定义库更新与 EICAR 冒烟 |
| `.agents/EXEC_D.md` · `CMD_ENCODING_ACP_NLS.md` · `CONSOLE_STDOUT_MECHANISM.md` | execd 接口、`/exec` 编码、stdout 管道机制 |
| `docker/run.sh` · `http_test.sh` · `scripts/fetch-ready.sh` | 脚本内注释 |
