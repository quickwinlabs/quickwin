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

一次性命令：

```bash
podman exec quickwin-dev bash -lc 'cd /workspace && make cc64'
```

> CI（`.github/workflows/ci-qemu.yml`）用同一镜像 `ghcr.io/xna00/quickwin-dev`，本地与 CI 行为一致。项目已不使用 MSYS2 原生编译路径。

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

以下命令**全部在容器内**执行。

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
| `make exec_server` | 打包 `examples/exec_server.ts` 并 Brotli 内嵌进 `_build/exec_server.exe` |
| `make wat` / `make wasm` | WAT → WASM fixtures |
| `make test` | 运行测试 |
| `BUILD=fast\|small\|debug` | 构建 flavor，默认 fast |

### 中间产物布局（arch 隔离）

所有中间产物都在 `_build/` 下，按 arch × native/cross 隔离，**切 32/64 无需手动清 deps**：

```
_build/
  obj/{x64,ia32}-{cross,native}/   # .o .d libquickjs.a
  deps/{x64,ia32}-{cross,native}/  # libiwasm.a libwolfssl.a libbrotli*.a libffi.a + cmake build/
  version.h                        # 由 package.json 生成
  gen_const.exe                    # make gen-const 产物（在 VM 里运行以重生成 d.ts）
  *.exe                            # 最终目标
```

`make clean`（= `distclean`）清掉整个 `_build/`；源码树 `deps/` 下不再产生任何构建产物。

**不要单独跑 `make wamr`**（native 路径）：不带 `CROSS=1` 会用本机 gcc 建 ELF `.a`，之后 `cc64` 发现 `.a` 比源文件新就跳过重建，链接必挂（已按 `VARIANT=x64-native` 与 `x64-cross` 隔离，不会覆盖交叉产物，但对 cross 无用）。WAMR/WolfSSL/Brotli/libffi 由 `cc64`/`cc32` 目标自动按正确架构构建。

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
./setup-win7.sh    # → snapshots/win7_ready.qcow2
./setup-xp.sh       # → snapshots/xp_ready.qcow2
```

- XP：提取 ISO → 注入 `WINNT.SIF` + `$OEM$`（`.bat` 经 `unix2dos` 转 CRLF）→ 重建 ISO → 无人值守安装（约 5–6 分钟）
- Win7：直接用原始 ISO 安装；软盘里的 `install.bat`/`bootstrap.bat` 同样 `unix2dos` 转 CRLF（中文 cmd + LF 会吞行尾）
- 安装脚本会自动清理残留 pid / 旧盘；QEMU 干净关机后脚本轮询退出

### 每次测试（常驻模式）

VM 开机只起 `exec_server`（不跑测试）；测试经 `http_test.sh` HTTP 下发，可反复执行：

```bash
# 容器内
cd docker
./run.sh win7              # 已在跑则只做健康检查；首启等 /health（~30–60s）
# 或 ./run.sh xp
# 需要干净 overlay 时: ./run.sh win7 --fresh

./http_test.sh win7        # POST /exec 跑 test/run.js，解析 Summary，failed≤1 → PASS
./http_test.sh xp -net     # filter 透传（跳过 net suites 等）
./http_test.sh xp basic    # 只跑指定 suite

./run.sh win7 --stop       # ACPI 关机，超时 60s 自动 kill
./run.sh win7 --restart    # 停再起
```

流程：`run.sh` 杀旧 QEMU（`--fresh` 时重建 overlay）→ `ln -s` `_build` 到 `ci_share/quickwin` → `unix2dos` run.bat → 启动 → 等 `/health`。  
`run.bat` 只做防火墙/portproxy + `start exec_server`；`http_test.sh` 内部确保容器 `serve_test :18923`。

Win7 用 `qwin.exe`（64 位），XP 用 `qwin-x86.exe`（32 位），`http_test.sh` 按 VM 参数选 exe；`run.bat` 按 `ver` 选日志文件名。

> hostfwd 端口（win7:**8007** / xp:**8005**）只在容器网络里，宿主直连不通；本地须 `podman exec quickwin-dev` 进容器跑上述脚本。CI 在容器内直接跑，无此问题。

### 常见故障

| 症状 | 原因 / 处理 |
|------|-------------|
| XP 卡在产品密钥页 | `floppy-xp/WINNT.SIF` 的 `ProductKey` 与 ISO 不匹配（中文 VL 盘用 `MRX3F-...`） |
| VM 内挂不上 Z: | XP 仅 SMB1：须走 `smb_wrapper.sh`（guestfwd + `server min protocol = NT1`），不能用 QEMU `-smb` |
| `net use` 成功但不跑 run.bat | `.bat` 必须 CRLF：仓库根 `.gitattributes` 已 `eol=crlf`（checkout 即 CRLF），`run.sh` 每次再 `unix2dos` 作双保险 |
| 网络测试连不上宿主 | guest `portproxy` 18923/18924 + 容器内 `serve_test` 必须都在；`--fresh` 会丢 overlay 里的 portproxy，由 run.bat 每次重建；`http_test.sh` 会自动拉起 serve_test |
| `/exec` 超时 | `popen` 在 Worker 里跑，主循环不阻塞；默认 60s，`http_test.sh` 给 300s。真挂死用 `./run.sh <vm> --restart` |
| 关机/等待死循环 | 不能用 `kill -0` 判 QEMU（容器 PID1 不回收僵尸）；看 pid **文件是否还存在**（QEMU 退出时自行 unlink） |
| 需要看 VM 画面 | 容器内 `./start-novnc.sh` 后浏览器开 XP `:6005` / Win7 `:6007`（宿主已映射）；或 monitor `screendump` 截图 |
| 残留 QEMU | `./run.sh <vm> --stop`；pid 文件残留用 `kill -9 $(cat qemu-<vm>.pid) \|\| true` |
| 改过 C/`qwin*.exe` 后 guest 仍像旧代码 | Windows SMB **按路径**缓存 exe：覆盖写/inode 变了仍可能跑旧映像（新文件名立刻生效）。`./run.sh <vm> --restart` 清会话；或临时拷到 `%TEMP%` 换名再跑 |

## CI（ci-qemu.yml）

- **镜像**：仅 `Dockerfile.dev` 变更或 GHCR 无镜像时重建，否则复用 `ghcr.io/xna00/quickwin-dev:latest`
- **matrix**：`win7`（`cc64` + qwin.exe）/ `xp`（`cc32` + qwin-x86.exe），`fail-fast: false`
- **缓存**：ready 快照（cache miss 才现场 `setup-*.sh`，约 40min）；交叉编译依赖 `.a`（key 含 Makefile/patches/deps hash）
- **编译**：`make <deps> BUILD=small` → nowasm → `make js wasm` → `make exec_server` → 上传 artifact
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
| `--` | 结束选项解析，后续参数作为脚本文件 |

注意：`-o LOG` 日志在 exe 所在目录（非当前工作目录）；`--` 可防止 `-e 'code'` 被当作选项捕获。完整说明见 README「CLI」与「内嵌脚本」。

## 提交规范

1. **先展示再提交**：宿主跑 `git diff`，写出拟用 commit message，**用户明确同意后**才 `git add` / `commit` / `push`
2. **message 依据 diff**：不凭文件名猜；风格对齐 `git log`（如 `feat(docker): ...`、`fix: ...`）
3. **Windows 常量**：禁止手写数值，必须在 `tools/gen_const.c` 用 `DEC(...)` 定义 → `make gen-const` → 在 VM 跑 `gen_const.exe` → TS 里用 `gui.EnumName.MEMBER`
4. 大文件不直接提交：中文 ISO 放 `docker/iso/`（本地/CI 缓存，不入库）；子模块改动走 `patches/`（见上「XP 兼容 patch」）

### Windows 常量（gen_const）

所有 Windows API 常量（窗口样式、消息号、通知码等）必须通过 `tools/gen_const.c` 的 `DEC(TS_NAME, SDK_MACRO)` 宏从 SDK 头文件获取，不得在 TS 代码中手写数值。流程：

1. 在 `tools/gen_const.c` `print_enums()` 添加 `DEC(TS_NAME, SDK_MACRO)` 行
2. `make gen-const` 交叉编译 `_build/gen_const.exe`，在 Windows/VM 里运行该 exe 重新生成 `quickwin_const.d.ts`
3. 在 TS 代码中通过 `gui.EnumName.MEMBER` 使用

## 排错索引

| 资料 | 用途 |
|------|------|
| 本文档 | 构建/测试命令、CLI、WAMR flag、XP patch、已知问题 |
| `../docs/qemu-xp-automated-testing.md` | QEMU 无人值守安装 + SMB + bootstrap 原理 |
| `.agents/QEMU_NET_SUITE_TEST.md` | 逐 suite 网络测试与 ipv6/portproxy 历史 |
| `docker/run.sh` / `http_test.sh` / `setup-*.sh` | 常驻启停、HTTP 下发测试、装机脚本内注释 |
| `make debug` + `-o LOG` | bridge 调用日志；release 构建会编译掉 `DEBUG_PRINTF` |
| monitor `screendump` / noVNC | VM 卡界面时截图或实时查看 |
