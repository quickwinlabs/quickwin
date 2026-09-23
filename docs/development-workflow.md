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
| `make wat` / `make wasm` | WAT → WASM fixtures |
| `make test` | 运行测试 |
| `BUILD=fast\|small\|debug` | 构建 flavor，默认 fast |

### 关键坑：32/64 静态库路径共享

`Makefile` 中 32/64 位共用同一批静态库路径：

- `deps/wamr/lib/libiwasm.a`
- `deps/wolfssl/lib/libwolfssl.a`
- `deps/brotli/lib/*.a`
- `deps/libffi/lib/libffi.a`

**混架构后链接必挂**（未定义符号 / 架构不匹配）。切位宽前先清对应依赖：

```bash
rm -rf deps/wamr/{build,lib} deps/wolfssl/{build,lib}
rm -rf deps/brotli/build-* deps/brotli/lib
rm -rf deps/libffi/build-* deps/libffi/lib
make cc64    # 或 make cc32
```

**不要单独跑 `make wamr`**：不带 `CROSS=1` 会用本机 gcc 建错架构的 `.a`，之后 `cc32` 发现 `.a` 比源文件新就跳过重建，链接必挂。WAMR/WolfSSL/Brotli/libffi 由 `cc64`/`cc32` 目标自动按正确架构构建。

XP 32 位另有子模块 patch（`patches/*-xp-compat.patch`），构建前由 Makefile 自动 apply，详见 AGENTS.md「Windows XP 兼容性状态」。

## QEMU VM 验证

原理与实现细节见 [qemu-xp-automated-testing.md](qemu-xp-automated-testing.md)。日常只需：

### 一次性装机

```bash
cd docker
./setup-win7.sh    # → snapshots/win7_ready.qcow2
./setup-xp.sh       # → snapshots/xp_ready.qcow2
```

- XP：提取 ISO → 注入 `WINNT.SIF` + `$OEM$`（`.bat` 经 `unix2dos` 转 CRLF）→ 重建 ISO → 无人值守安装（约 5–6 分钟）
- Win7：直接用原始 ISO 安装；软盘里的 `install.bat`/`bootstrap.bat` 同样 `unix2dos` 转 CRLF（中文 cmd + LF 会吞行尾）
- 安装脚本会自动清理残留 pid / 旧盘；QEMU 干净关机后脚本轮询退出

### 每次测试

```bash
# 容器内先起测试 HTTP 服务（18923/18924，dual-stack）
node tools/serve_test.ts 18923 &

cd docker
./run.sh win7 --fresh    # 或 ./run.sh xp --fresh
# … 等待 Summary: N/M passed 与 Done …

./run.sh win7 --stop     # ACPI 关机，超时 60s 自动 kill
```

流程：杀旧 QEMU → 重建 overlay（`*_test.qcow2`，写时复制，保护 ready 快照）→ `ln -s` `_build` 到 `ci_share/quickwin` → `unix2dos` run.bat → 启动 → 等 `ci_share/run-<vm>.log` 的 Done。

Win7 用 `qwin.exe`（64 位），XP 用 `qwin-x86.exe`（32 位），`run.bat` 按 `ver` 自动选择。

### 常见故障

| 症状 | 原因 / 处理 |
|------|-------------|
| XP 卡在产品密钥页 | `floppy-xp/WINNT.SIF` 的 `ProductKey` 与 ISO 不匹配（中文 VL 盘用 `MRX3F-...`） |
| VM 内挂不上 Z: | XP 仅 SMB1：须走 `smb_wrapper.sh`（guestfwd + `server min protocol = NT1`），不能用 QEMU `-smb` |
| `net use` 成功但不跑 run.bat | `.bat` 必须 CRLF：仓库根 `.gitattributes` 已 `eol=crlf`（checkout 即 CRLF），`run.sh` 每次再 `unix2dos` 作双保险 |
| 网络测试连不上宿主 | guest `portproxy` 18923/18924 + 容器内 `serve_test` 必须都在；`--fresh` 会丢 overlay 里的 portproxy，由 run.bat 每次重建 |
| 关机/等待死循环 | 不能用 `kill -0` 判 QEMU（容器 PID1 不回收僵尸）；看 pid **文件是否还存在**（QEMU 退出时自行 unlink） |
| 需要看 VM 画面 | XP：monitor `screendump`（`setup-xp.sh` 无 VNC）；Win7/XP 测试态可 `./start-novnc.sh` 后浏览器开 `:6080` |
| 残留 QEMU | `./run.sh <vm> --stop`；pid 文件残留用 `kill -9 $(cat qemu-<vm>.pid) \|\| true` |

## CI（ci-qemu.yml）

- **镜像**：仅 `Dockerfile.dev` 变更或 GHCR 无镜像时重建，否则复用 `ghcr.io/xna00/quickwin-dev:latest`
- **matrix**：`win7`（`cc64` + qwin.exe）/ `xp`（`cc32` + qwin-x86.exe），`fail-fast: false`
- **缓存**：ready 快照（cache miss 才现场 `setup-*.sh`，约 40min）；交叉编译依赖 `.a`（key 含 Makefile/patches/deps hash）
- **编译**：`make <deps> BUILD=small` → nowasm → `make js wasm` → 上传 artifact
- **测试**：容器内 `serve_test` + `run.sh <vm>`，解析 Summary，**失败 ≤1 视为通过**（XP 无打印机导致 `ffi/EnumPrintersW` 环境差异）
- **发布**：`v*` tag 且测试过 → `make npm-pkg` 发 npm

本地跑同一套 = 提前发现 CI 问题。

## 提交规范

1. **先展示再提交**：宿主跑 `git diff`，写出拟用 commit message，**用户明确同意后**才 `git add` / `commit` / `push`
2. **message 依据 diff**：不凭文件名猜；风格对齐 `git log`（如 `feat(docker): ...`、`fix: ...`）
3. **Windows 常量**：禁止手写数值，必须在 `tools/gen_const.c` 用 `DEC(...)` 定义 → `make const` → TS 里用 `gui.EnumName.MEMBER`
4. 中文 ISO、子模块 patch 等大文件/policy 见 AGENTS.md 对应章节

## 排错索引

| 资料 | 用途 |
|------|------|
| `AGENTS.md` | 构建命令、WAMR/XP patch、已知问题、http import 实现 |
| `docs/qemu-xp-automated-testing.md` | QEMU 无人值守安装 + SMB + bootstrap 原理 |
| `.agents/QEMU_NET_SUITE_TEST.md` | 逐 suite 网络测试与 ipv6/portproxy 历史 |
| `docker/run.sh` / `setup-*.sh` | 测试与装机脚本内注释（pid、CRLF、overlay 等坑） |
| `make debug` + `-o LOG` | bridge 调用日志；release 构建会编译掉 `DEBUG_PRINTF` |
| monitor `screendump` / noVNC | VM 卡界面时截图或实时查看 |
