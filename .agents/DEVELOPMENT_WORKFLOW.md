# QuickWin 开发流程

本地宿主只负责**管理代码**（git、编辑、文档）；**编译、测试、QEMU 验证**全部在开发容器内完成。CI 与本地容器环境一致，消除"本地能过、CI 挂"的差异。

## 职责划分

| 环境 | 职责 | 不做 |
|------|------|------|
| **宿主** | git、编辑器、文档、opencode | 不编译、不跑测试 |
| **容器** `quickwin-dev` | `make cc64`/`cc32`、`make test`、QEMU 装机与测试 | 不直接 git 提交（改动经挂载同步，提交仍在宿主） |

容器基于 `docker/Dockerfile.dev`（Fedora + posix mingw 交叉编译器 + QEMU + Samba），仓库挂载为 `/workspace`。

进入容器：

```bash
./docker/dev-podman.sh shell
# 或
podman exec quickwin-dev bash
```

**黄金模板**（宿主发起的任何构建 / 测试 / curl 命令都套这一行。两个易错点：必须 `podman exec`、必须 `cd /workspace`——漏任一个都会失败）：

```bash
podman exec quickwin-dev bash -lc 'cd /workspace && <命令>'
```

> CI（`.github/workflows/ci-qemu.yml`）用同一镜像 `ghcr.io/quickwinlabs/quickwin-dev`，本地与 CI 行为一致。项目已不使用 MSYS2 原生编译路径。

## GitHub 操作（宿主）

需要做 GitHub 操作（创建 Release、上传资产等）时，先检查宿主是否设置了 `GH_TOKEN`
（`[ -n "$GH_TOKEN" ]`）；有则用它调用 GitHub REST API（`curl -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/...`）。
token 值严禁写入文件、日志或命令行历史。

## 环境准备

```bash
# 宿主：启动容器（复用本地镜像，不重建）
./docker/dev-podman.sh up

# 仅 Dockerfile.dev 变更时才需要
./docker/dev-podman.sh build

# 子模块（宿主或容器均可）
git submodule update --init --recursive
```

中英文 ISO 放到（或由脚本下载）：

- `docker/iso/win7/*.iso`
- `docker/iso/xp/*.iso`

容器内缺少工具时可执行 `podman build -t localhost/quickwin-dev:latest -f docker/Dockerfile.dev docker/` 重建镜像；日常 `up` 不会触发重建。

## 日常开发循环

> 以下命令**全部在容器内**执行——宿主直接跑会 `command not found` / 找不到 Makefile；
> 从宿主发起请套上面**黄金模板**（`podman exec ... cd /workspace && ...`）。

### 编译

```bash
make cc64            # 64 位 → _build/qwin.exe（默认 BUILD=fast）
make cc32            # 32 位/XP → _build/qwin-x86.exe
make cc64 BUILD=small   # -Os + LTO，发行体积（CI 用）
make js              # TypeScript → JS（改 .ts 后必跑）
make debug           # 排错用：-DDEBUG 打开 bridge 日志
```

### 快速自测

```bash
make test TEST=-net    # 跳过网络测试（日常推荐）
make test TEST=wasm    # 只跑 WASM
make test              # 全量（含外网，慢）
```

### 构建目标速查

| 目标 | 说明 |
|------|------|
| `make cc64` / `cc32` | 交叉编译 64/32 位 exe |
| `make cc64-nowasm` / `cc32-nowasm` | 不含 WASM/WAMR |
| `make js` | 编译 TS |
| `make execd` | 打包 `examples/execd/main.tsx` 并 Brotli 内嵌进 `_build/execd.exe` |
| `make wat` / `make wasm` | WAT → WASM fixtures |
| `make test` | 运行测试 |
| `BUILD=fast\|small\|debug` | 构建 flavor，默认 fast |

### 中间产物布局（arch 隔离）

所有中间产物都在 `_build/` 下，按 arch × native/cross 隔离，**切 32/64 无需手动清 deps**：

```
_build/
  obj/{x64,ia32}-{cross,native}/   # .o .d libquickjs.a
  deps/{x64,ia32}-{cross,native}/  # libiwasm.a libwolfssl.a libbrotli*.a + cmake build/
  version.h                        # 由 package.json 生成
  gen_const.exe                    # make gen-const 产物（在 VM 里运行重定向生成仓库根 constants.ts）
  *.exe                            # 最终目标
```

`make clean`（= `distclean`）清掉整个 `_build/`；源码树 `deps/` 下不再产生任何构建产物。

**不要单独跑 `make wamr`**（native 路径）：不带 `CROSS=1` 会用本机 gcc 建 ELF `.a`，之后 `cc64` 发现 `.a` 比源文件新就跳过重建，链接必挂（已按 `VARIANT=x64-native` 与 `x64-cross` 隔离，不会覆盖交叉产物，但对 cross 无用）。WAMR/WolfSSL/Brotli 由 `cc64`/`cc32` 目标自动按正确架构构建。

XP 32 位另有子模块 patch（`patches/wamr-xp-compat.patch`、`patches/wolfssl-xp-compat.patch`、`patches/quickjs-export-from-base64.patch`），构建前由 Makefile 自动调 `patches/apply-submodule-patches.sh` 幂等 apply（git apply + reverse check）。**子模块改动不直接提交**，一律以 patch 文件管理。

### WAMR 构建注意

WAMR 由 `cc64`/`cc32` 自动构建，勿单独 `make wamr`（见上）。Makefile 固定传入的关键 flag（改前先确认）：

- `WAMR_DISABLE_HW_BOUND_CHECK=1` —— 禁用 Windows SEH（`__try`/`__except`），工具链不支持 MSVC 扩展
- `WAMR_BUILD_INVOKE_NATIVE_GENERAL=1` —— 用纯 C 版 `invokeNative`；否则 cmake 对 MinGW 检测失败会编译 MSVC 汇编 `.asm`，链接时 `invokeNative` 未定义
- `WAMR_BUILD_EXCE_HANDLING=0` —— 当前关闭异常处理/TAGS。历史上开 =1 时 `WASMModule` 结构体偏移易与条件编译宏不一致而错位（直接 cast 读字段得垃圾值），需清掉 `_build/deps/*/wamr-build` CMake cache 重建

WASM 导出到 JS 的函数用 `JS_NewCFunctionData`（`magic` 传函数 ID）创建，`JSClassDef.call` 方案无效；设置导出属性后不要 `JS_FreeValue`。

## QEMU VM 验证

原理与实现细节见 [qemu-xp-automated-testing.md](../docs/qemu-xp-automated-testing.md)。日常只需：

### 一次性装机

```bash
cd docker
./setup-win7.sh                  # → snapshots/win7_ready.qcow2
./setup-xp.sh                    # → snapshots/xp_ready.qcow2
./setup-win11.sh win11           # → snapshots/win11_ready.qcow2（标准 tiny11，带 Defender）
./setup-win11.sh win11core       # → snapshots/win11_ready-core.qcow2（tiny11 core）
```

- Win11 第二参数是 `iso/win11/*<片段>*.iso` 的匹配串（可覆盖内置选盘，免去挪动 ISO）；
  变体与 Defender 细节见 `.agents/WIN11_DEFENDER.md`
- Win11 装机与运行都**不含 TPM/Secure Boot**：硬件检查由 `floppy-win11/Autounattend.xml` 的
  `LabConfig` 键（`BypassTPMCheck` 等 5 项：TPM/SecureBoot/RAM/CPU/Storage）在 WinPE 阶段绕过，
  QEMU 侧只要普通 4M OVMF（pflash，code/vars 分离）+ GPT 盘 → 不再需要 `swtpm` / `tpm-tis`
- XP：提取 ISO → 注入 `WINNT.SIF` + `$OEM$`（`.bat` 经 `unix2dos` 转 CRLF）→ 重建 ISO → 无人值守安装（约 5–6 分钟）
- Win7：直接用原始 ISO 安装；软盘里的 `install.bat`/`bootstrap.bat` 同样 `unix2dos` 转 CRLF（中文 cmd + LF 会吞行尾）
- 安装脚本会自动清理残留 pid / 旧盘；QEMU 干净关机后脚本轮询退出

### 测试镜像（ISO）来源与发布

`docker/scripts/download-iso.sh <类型> [目标目录]` 按 **自有 release → 公开镜像源** 取盘：

| 类型 | 自有 release（`quickwinlabs/assets`） | 原始文件（资产前缀） | 镜像回落 |
|------|--------------------------------------|----------------------|----------|
| `xp` | `win-isos-xp` | `zh-hans_windows_xp_...x14-74070.iso` | testip → archive.org |
| `7u` | `win-isos-win7` | `cn_windows_7_ultimate_..._677408.iso` | archive.org ×3 → testip |
| `tiny11`（core） | `win-isos-tiny11` | `tiny11core_25H2_Nov25.iso` | SourceForge → archive.org |
| `tiny11std`（标准） | `win-isos-tiny11-std` | `tiny11_25H2_Nov25.iso` | SourceForge |

- 自有 release 是**分卷**（`${OWN_FILE:-FILE}.part00..NN`，`split -b 1800m` —— GitHub 单资产 2 GiB 硬限）+ `SHA256SUMS.txt`；
  `try_own_release()` 逐卷试拉到 404 即止，拼接后过 `OWN_SIZE`/`OWN_SHA` 门禁（缺省回落 `SIZE`/`SHA`）——
  **不符只告警并软回落镜像源，不硬失败**。
- core 与标准盘用的是**两份不同构建**（archive.org 的 NTDEV Nov25 resp. SourceForge 的 kelexine 2026-08-23），
  所以 `OWN_FILE`/`OWN_SIZE`/`OWN_SHA` 与 `FILE`/`SIZE`/`SHA` 分开设、各自名实相符；
  **重跑发布换批次后要同步 `OWN_*`**（值在 release 的 `SHA256SUMS.txt`）。
- 发布在 **assets 仓**（`quickwinlabs/assets`）：`scripts/publish.sh <xp|7u|tiny11|tiny11std>`
  （下载 → 1800m 分卷 → `gh release upload --clobber`），由 `.github/workflows/build-<type>.yml` 的
  `workflow_dispatch` 手动触发（`GH_TOKEN` = 仓库自带 token）。**重跑即覆盖，`sha256` 是唯一 integrity 锚点**。
  新增类型 = 抄一个 workflow + `publish.sh` case 表一行 + `download-iso.sh` 的 ISO 定义。
- **为什么不用 SourceForge 当主源**：SF 对 GitHub runner IP 段**间歇 403**（Cloudflare 反爬；assets 仓 2026-10 的
  runner 探针实测 + 多个外部项目佐证），且其文件与 archive.org 那份**同名不同内容**；archive.org 才是 runner 可达源
  （并发多个 workflow 时撞过限流，退避重跑即可）。
- 本环境（宿主/容器）**访问 archive.org 不通**（DNS 污染 + SNI RST）→ **本机走 SF、CI 走 archive.org**，两条路各取所需。
- 换/加盘后验证自有 release 路径：`./download-iso.sh <类型> /tmp/iso-test`（会实下整盘，注意流量/时间）。

### 每次测试（常驻模式）

VM 开机只起 `execd`（不跑测试）；测试经 `http_test.sh` HTTP 下发，可反复执行：

```bash
# 容器内
cd docker
./run.sh win7              # 已在跑则只做健康检查；首启等就绪（`/` 返回 usage 200，~30–60s）
# 或 ./run.sh xp
# 需要干净 overlay 时: ./run.sh win7 --fresh

./http_test.sh win7        # POST /exec 跑 test/run.js，解析 Summary，failed≤1 → PASS
# ⚠️ filter 尾参目前到不了 guest 的 scriptArgs（2026-10-19 实测：`./http_test.sh win11 ffi`
#    实跑的是全量 1350/1355）。想要子集请另发脚本，见下方「FFI 子集」与 TODO 条目

./run.sh win7 --stop       # ACPI 关机，超时 60s 自动 kill
./run.sh win7 --restart    # 停再起
```

只跑 FFI 子集（改 `lib/ffi` 时的快速回归；win11 期望 `ok=610 fail=2 skip=2`，那 2 个失败是
已知的窗口枚举用例，XP 期望 `ok=608 fail=0 skip=3`）：`_build/ffi_only.js`（临时脚本，放 `_build/`，不进 git）
顺序 import 7 个 `test_ffi_*.js` 并跑 `suite.run(t)`：

```js
import * as std from "std"
import { Tester } from "./test/test_helper.js"
const names = ["test_ffi_bind", "test_ffi_abi", "test_ffi_struct", "test_ffi_struct_layout",
               "test_ffi_array", "test_ffi_user32", "test_ffi_windows"]
let ok = 0, fail = 0, skip = 0
for (const n of names) {
    const mod = await import("./test/" + n + ".js")
    const t = new Tester()
    try { await mod.suite.run(t) } catch (e) { std.printf("%s: SUITE THREW %s\n", n, String(e)); fail++; continue }
    std.printf("%-22s ok=%d fail=%d skip=%d\n", n, t.ok, t.fail, t.skip)
    ok += t.ok; fail += t.fail; skip += t.skip
}
std.printf("FFI TOTAL: ok=%d fail=%d skip=%d\n", ok, fail, skip)
std.exit(fail ? 1 : 0)
```

`make js` 后直接 POST（XP 换 `qwin-x86.exe`；/exec 串行，带 `timeout` 更稳）：

```bash
curl -s -X POST http://127.0.0.1:8011/exec -H "Content-Type: application/json" \
  -d '{"cmd":"qwin.exe ffi_only.js","timeout":600000}'
```

流程：`run.sh` 杀旧 QEMU（`--fresh` 时重建 overlay）→ `ln -s` `_build` 到 `ci_share/quickwin` → `unix2dos` run.bat → 启动 → 等 `/`（usage 页 200）。  
`run.bat` 只做防火墙/portproxy + `start execd`；`http_test.sh` 内部确保容器 `serve_test :18923`。

> **改了 `examples/execd/` 下源文件或其 lib 依赖后，只跑 `make js` 不生效**——guest 里跑的
> `execd.exe` 内嵌的是 brotli 打包的旧 JS。改动后构建顺序：`make js` → `make execd`
> （重新 brotli 内嵌）→ `./run.sh <vm> --restart` 加载新 exe（原文见 `.agents/EXEC_D.md`）。

Win7 用 `qwin.exe`（64 位），XP 用 `qwin-x86.exe`（32 位），`http_test.sh` 按 VM 参数选 exe；`run.bat` 按 `ver` 选日志文件名。

> hostfwd 端口（win7:**8007** / xp:**8005**）只在容器网络里，宿主直连不通；本地须 `podman exec quickwin-dev` 进容器跑上述脚本。CI 在容器内直接跑，无此问题。

### 常见故障

| 症状 | 原因 / 处理 |
|------|-------------|
| 宿主跑 `make` 报 command not found / 找不到 Makefile | 命令须在容器内：套黄金模板 `podman exec quickwin-dev bash -lc 'cd /workspace && ...'`（漏 `cd /workspace` 同样找不到 Makefile） |
| 宿主 `curl :8007/:8005/:18923` 连接被拒 | hostfwd / serve_test 端口只在容器网络，进容器再 curl |
| XP 卡在产品密钥页 | `floppy-xp/WINNT.SIF` 的 `ProductKey` 与 ISO 不匹配（中文 VL 盘用 `MRX3F-...`） |
| VM 内挂不上 Z: | XP 仅 SMB1：须走 `smb_wrapper.sh`（guestfwd + `server min protocol = NT1`），不能用 QEMU `-smb` |
| `net use` 成功但不跑 run.bat | `.bat` 必须 CRLF：仓库根 `.gitattributes` 已 `eol=crlf`（checkout 即 CRLF），`run.sh` 每次再 `unix2dos` 作双保险 |
| 网络测试连不上宿主 | guest `portproxy` 18923/18924 + 容器内 `serve_test` 必须都在；`--fresh` 会丢 overlay 里的 portproxy，由 run.bat 每次重建；`http_test.sh` 会自动拉起 serve_test |
| `/exec` 超时/不返回 | **无默认上限**：连接活着就一直跑，客户端断连或 body 传 `"timeout"` 毫秒才 kill（代码是 `CreatePipe` + `CreateProcessW` 的读循环，**不是 popen**——唯一 popen 是超时后 `taskkill /T` 那个 helper）。后代进程持有管道写端也会拖住请求，见 `.agents/CONSOLE_STDOUT_MECHANISM.md` §7.6。真挂死用 `./run.sh <vm> --restart` |
| 关机/等待死循环 | 不能用 `kill -0` 判 QEMU（容器 PID1 不回收僵尸）；看 pid **文件是否还存在**（QEMU 退出时自行 unlink） |
| 需要看 VM 画面 | 容器内 `./start-novnc.sh` 后浏览器开 XP `:6005` / Win7 `:6007`（宿主已映射）；或 monitor `screendump` 截图 |
| 残留 QEMU | `./run.sh <vm> --stop`；pid 文件残留用 `kill -9 $(cat qemu-<vm>.pid) \|\| true` |
| 改过 C/`qwin*.exe` 后 guest 仍像旧代码 | 已根治：`smb_wrapper.sh` 加 `oplocks = no` + `smb2 leases = no`，不再授予读缓存，覆盖写同路径立即可见（`--restart` 加载新 conf 后生效）。若仍出现，先 `--restart` 确保 smbd 读了新 conf |

## CI（ci-qemu.yml）

- **镜像**：仅 `Dockerfile.dev` 变更或 GHCR 无镜像时重建，否则复用 `ghcr.io/quickwinlabs/quickwin-dev:latest`
- **matrix**：`win7`（`cc64` + qwin.exe）/ `xp`（`cc32` + qwin-x86.exe），`fail-fast: false`
- **缓存**：ready 快照（cache miss 才现场 `setup-*.sh`，约 40min）；交叉编译依赖 `.a`（key 含 Makefile/patches/deps hash）
- **编译**：`make <deps> BUILD=small` → nowasm → `make js wasm` → `make execd` → 上传 artifact
- **测试**：`run.sh <vm>` 等健康 → `http_test.sh <vm>`（内含 serve_test + POST /exec + Summary 断言，**失败 ≤1 视为通过**）→ `--stop if: always()`
- **发布**：`v*` tag 且测试过 → `make npm-pkg` 发 npm

本地跑同一套 = 提前发现 CI 问题。

## CLI 参数（运行时）

```
qwin.exe [options] [script.js]    # 运行 JS 脚本
qwin.exe -e <expression>          # 运行表达式（优先于脚本文件）
qwin.exe [options]                # 无参数时加载 main.js 或内嵌 JS
```

| 参数 | 说明 |
|------|------|
| `-d` | 开启 HTTP 调试日志（输出到 stderr） |
| `-o CON` | 输出重定向到控制台（AllocConsole） |
| `-o LOG` | 输出重定向到自动生成的日志文件 `log_YYYY_MM_DD_HH_MM_SS.txt`（exe 同目录） |
| `-o <file>` | 输出重定向到指定文件（stdout + stderr） |

注意：`-o LOG` 日志在 exe 所在目录（非当前工作目录）；选项按固定槽位 `[-d] [-o 目标] [-e code | 脚本]` 解析，槽位之后的参数全部原样传给脚本。完整说明见 README「CLI」与「内嵌脚本」。

## 提交规范

1. **先展示再提交**：宿主跑 `git diff`，写出拟用 commit message，**用户明确同意后**才 `git add` / `commit` / `push`
2. **message 依据 diff**：不凭文件名猜；风格对齐 `git log`（如 `feat(docker): ...`、`fix: ...`）
3. **Windows 常量**：禁止手写数值，必须在 `tools/gen_const.c` 用 `DEC(...)` 定义 → `make gen-const` → 在 VM 跑 `gen_const.exe` → TS 里 `import { EnumName } from 'quickwin/constants'`（仓库内相对路径）用 `EnumName.MEMBER`
4. 大文件不直接提交：中文 ISO 放 `docker/iso/`（本地/CI 缓存，不入库）；子模块改动走 `patches/`（见上「XP 兼容 patch」）

### Windows 常量（gen_const）

所有 Windows API 常量（窗口样式、消息号、通知码等）必须通过 `tools/gen_const.c` 的 `DEC(TS_NAME, SDK_MACRO)` 宏从 SDK 头文件获取，不得在 TS 代码中手写数值。流程：

1. 在 `tools/gen_const.c` `print_enums()` 添加 `DEC(TS_NAME, SDK_MACRO)` 行
2. `make gen-const` 交叉编译 `_build/gen_const.exe`，在 Windows/VM 里运行该 exe 重新生成 `constants.ts`（真实 .ts 平铺单文件，tsc/esbuild 均可内联；enum 名全局唯一，改名前先全局搜）
   - 文件末尾的 `EnumMap` 预填段（`declare global`，token 标注 `'u32@Name'` 的值域表）也由该 exe 同批输出（`ENUM()` 宏记录枚举名 + `print_enum_map()`），无需后处理；增删枚举后重跑本步即可
3. 在 TS 代码中通过 `gui.EnumName.MEMBER` 使用

## 排错索引

| 资料 | 用途 |
|------|------|
| 本文档 | 构建/测试命令、CLI、WAMR flag、XP patch、已知问题 |
| `../docs/qemu-xp-automated-testing.md` | QEMU 无人值守安装 + SMB + bootstrap 原理 |
| `.agents/QEMU_NET_SUITE_TEST.md` | 逐 suite 网络测试与 ipv6/portproxy 历史 |
| `.agents/WIN11_DEFENDER.md` | Win11 两套镜像、TP/实时保护开关、定义库更新与 EICAR 冒烟实测 |
| `docker/run.sh` / `http_test.sh` / `setup-*.sh` | 常驻启停、HTTP 下发测试、装机脚本内注释 |
| `make debug` + `-o LOG` | bridge 调用日志；release 构建会编译掉 `DEBUG_PRINTF` |
| monitor `screendump` / noVNC | VM 卡界面时截图或实时查看 |
