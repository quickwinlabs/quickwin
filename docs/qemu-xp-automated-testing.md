# 用 QEMU 搭建 Windows XP 自动化测试环境

> 本文内容参考了 [dockur/windows](https://github.com/dockur/windows)。

[QuickWin](https://github.com/xna00/quickwin) 的目标是支持 Windows XP+，因此必须验证它能否在真实的 XP 系统上运行。同时为了配合 AI 开发，需要让整个验证过程自动化——所以选用 QEMU 来运行 Windows XP 虚拟机。

总体流程：

1. 安装 Windows
2. 设置开机自启动脚本 `bootstrap.bat` —— 用来映射 SMB 共享目录，并运行共享目录里的一个脚本文件 `run.bat`
3. 给 `qcow2` 硬盘打上快照
4. 修改 `run.bat`
5. 从快照启动 Windows

这样，每次编译出可执行文件后，从快照启动 Windows 就能自动测试了（每次启动+测试用时约 30s）。

---

## 安装 XP 系统

正常安装 Windows 需要人工操作安装向导，而自动化测试不可能每次都人工操作，所以安装环节也必须全自动。
Windows 安装器本身就支持无人值守应答文件 `WINNT.SIF`，把安装向导要问的问题预先写好答案即可。

### 原理

XP 安装器会从系统镜像中读取应答文件 `WINNT.SIF`，并把镜像内的 `$OEM$` 目录复制到 `C:\OEM`。所以需要把我们的文件注入 ISO 再重建：

1. 用 `7z x` 提取原始 ISO
2. 注入 `WINNT.SIF` 到 `I386/` 目录
3. 注入 `$OEM$` 目录（含 `install.bat` / `bootstrap.bat`）
4. 用 `genisoimage` 重建 ISO（需从原 ISO sector 19 提取 boot catalog，`-boot-load-size` 从 catalog offset 39 读取，不能用经验值 4）

```bash
# setup.sh 核心步骤
7z x -o_iso_extract "$ISO" -y
unix2dos < floppy/WINNT.SIF   > _iso_extract/I386/WINNT.SIF
unix2dos < floppy/install.bat > "$OEM_DIR/install.bat"
unix2dos < floppy/bootstrap.bat > "$OEM_DIR/bootstrap.bat"
genisoimage -o xp_modified.iso -b "[BOOT]/Boot-NoEmul.img" \
    -c boot.cat -no-emul-boot -boot-load-size "$BOOT_LOAD_SIZE" \
    -boot-load-seg 0 -iso-level 2 -J -l -D -N -joliet-long -relaxed-filenames .
```

> **注意**：`WINNT.SIF` 必须 `unix2dos`（LF→CRLF），否则 setup 解析失败。

### 流程

挂载安装盘和修改后的镜像即可开始安装。XP 安装要经历 4 次启动：

```
Boot 1 (CD): 文本模式 -> 分区/格式化 -> 复制文件到硬盘 -> 自动重启  (~2min)
Boot 2 (CD): GUI 模式 -> 安装设备 -> 重启 (~3min)
Boot 3 (CD): setup 检测已完整安装 -> 跳转到硬盘
Boot 4 (HD): Windows 首次启动 -> [GuiRunOnce] install.bat -> shutdown -> QEMU 退出
```

### 注册开机自启动并关机

自动化的关键钩子是 `WINNT.SIF` 的 `[GuiRunOnce]`，把它设置为 `C:\OEM\install.bat`。
`[GuiRunOnce]` 段在**首次登录**执行，在 `install.bat` 中把 `C:\OEM\bootstrap.bat` 设置为开机自启动，然后运行 `shutdown` 关机。关机之后 QEMU 会自动退出，从而把"安装"和"测试"两个阶段干净隔开。

安装完成后保存安装盘为 `xp_ready.qcow2`，作为后续测试的干净起点：

```bash
mv xp_install.qcow2 xp_ready.qcow2
```

## 测试运行

### 从 xp_ready.qcow2 开机

快照 `xp_ready.qcow2` 只读；测试在 overlay `xp_test.qcow2` 上进行（写时复制），即使测试把系统搞坏也不影响快照。

```bash
qemu-img create -f qcow2 -b xp_ready.qcow2 -F qcow2 xp_test.qcow2
```

### SMB 共享

测试阶段 VM 与宿主机交换文件、跑测试全靠 SMB 共享（`Z:` 盘），但 XP 只能连 SMB1，而 QEMU 默认使用 SMB2/3，又无法通过配置修改，所以不能直接用 QEMU `-smb`。

**解决方案：guestfwd + 自定义 smbd**。用 QEMU 的 `guestfwd` 机制替代 `-smb`，启动一个支持 SMB1 的自定义 smbd：

```bash
# run.sh 里替换 -smb（FWD 按 VM：win7=7080，xp=5180 → guest 8080）：
-netdev user,id=net0,guestfwd=tcp:10.0.2.4:445-cmd:"$(pwd)/smb_wrapper.sh",hostfwd=tcp::"$FWD"-:8080 \
```

`smb_wrapper.sh` 生成完全自定义的 smb.conf，关键两行：

```ini
unix extensions = no      # smbd 4.24 会因 unix extensions=yes 静默禁用 wide links
wide links = yes          # ci_share/quickwin 是 symlink 指向 _build，必须允许
server min protocol = NT1 # 显式允许 SMB1，XP 才能连上
```

### 开机后自动运行 bootstrap.bat

每次开机，`HKLM\Run` 里的 bootstrap 自动触发，完成 SMB 映射并运行 `run.bat`：

```
bootstrap.bat (HKLM\Run 自动触发)
  -> net use Z: /delete          # 断开已存在连接，避免 error 85
  -> net use Z: \\10.0.2.4\qemu /user:guest ""
  -> call Z:\run.bat
```

映射 `Z:` 前必须先断开已有连接，否则报 `error 85`（本地设备名已在使用）。

### 运行 Z:\run.bat

`run.bat` 位于 SMB 共享目录里（`ci_share/run.bat`），挂载后由 bootstrap 调用，可以写入需要运行的命令，例如运行测试套件、执行脚本等。

## 优化

### novnc

QEMU 以 `-daemonize` 后台运行、`-display none` 隐藏窗口，测试全程无人值守。当流程卡住或安装异常时，看不到屏幕很难排查——此时需要在浏览器里直观看到 XP 界面。QEMU 的 VNC 是裸协议，浏览器无法直接访问，所以用 noVNC 把它桥接成 WebSocket：

```bash
./start-novnc.sh
# 打开 http://<host>:6080/vnc.html（websockify 桥：VNC 5901 -> WebSocket 6080）
```

### exec_server

主要目的是**持续测试**：VM 内常驻一个 HTTP 服务，宿主机随时可以提交命令执行，不用每次测试都重启虚拟机，节约时间。

实现：在 VM 内启动 `exec_server`（VM 内 HTTP 8080），宿主机经 hostfwd 远程执行命令。宿主侧端口按系统区分，一眼可读：

| VM | 容器内 hostfwd | 助记 |
|----|----------------|------|
| Win7 | **7080** → guest 8080 | 开头 7 = Win7 |
| XP | **5180** → guest 8080 | NT **5.1** = XP |

```bash
# Win7
curl -X POST http://localhost:7080/exec \
    -H "Content-Type: application/json" \
    -d '{"cmd":"dir"}'

# XP
curl -X POST http://localhost:5180/exec \
    -H "Content-Type: application/json" \
    -d '{"cmd":"dir"}'
```

响应：
- **200** → body = 命令原始字节（Windows 中文输出多为 GBK），退出码在 `X-Exit-Code`
- **非 200** → body = JSON `{"error":"..."}`（500=worker/错误，504=超时）

`popen` 在 Worker 线程执行，`/health` 在长命令期间仍可响应。

---

完整实现代码见 [quickwin/docker](https://github.com/xna00/quickwin/tree/main/docker)。
