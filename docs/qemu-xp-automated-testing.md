# 用 QEMU 搭建 Windows XP 自动化测试环境

> 本文内容参考了 [dockur/windows](https://github.com/dockur/windows)。

[QuickWin](https://github.com/quickwinlabs/quickwin) 的目标是支持 Windows XP+，因此必须验证它能否在真实的 XP 系统上运行。同时为了配合 AI 开发，需要让整个验证过程自动化——所以选用 QEMU 来运行 Windows XP 虚拟机。

总体流程：

1. 装机 → 注入 `bootstrap.bat` → 打快照：在 `quickwinlabs/assets` 仓做一次，产出预装盘（本仓不含安装脚本）
2. 改 `run.bat`（`docker/ci_share/`）
3. 从快照启动 Windows

每次编译出可执行文件后，从快照启动 Windows 就能自动测试（启动 + 测试约 30s）。

---

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
# run.sh 里替换 -smb（FWD 按 VM：win7=8007，xp=8005，win11=8011 → guest 8080）：
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

QEMU 以 `-daemonize` 后台运行、`-display none` 隐藏窗口，测试全程无人值守。当流程卡住或安装异常时，看不到屏幕很难排查——此时需要在浏览器里直观看到 guest 界面。QEMU 的 VNC 是裸协议，浏览器无法直接访问，所以用 noVNC 把它桥接成 WebSocket：

| VM | QEMU VNC | 容器/宿主 noVNC | 浏览器 |
|----|----------|-----------------|--------|
| XP | `:1` → 5901 | 6005 | `http://<host>:6005/vnc.html` |
| Win7 | `:2` → 5902 | 6007 | `http://<host>:6007/vnc.html` |

```bash
./start-novnc.sh
# 容器内起两路 websockify；宿主 compose 已映射 6005/6007
```

### execd

主要目的是**持续测试**：VM 内常驻一个 HTTP 服务，宿主机随时可以提交命令执行，不用每次测试都重启虚拟机，节约时间。

实现：在 VM 内启动 `execd`（VM 内 HTTP 8080），宿主机经 hostfwd 远程执行命令。宿主侧端口按系统区分，一眼可读：

| VM | 容器内 hostfwd | 助记 |
|----|----------------|------|
| Win7 | **8007** → guest 8080 | 800x + 7 = Win7 |
| XP | **8005** → guest 8080 | 800x + 5 = XP |
| Win11 | **8011** → guest 8080 | 800x + 11 = Win11 |

```bash
# Win7
curl -X POST http://localhost:8007/exec \
    -H "Content-Type: application/json" \
    -d '{"cmd":"dir"}'

# XP
curl -X POST http://localhost:8005/exec \
    -H "Content-Type: application/json" \
    -d '{"cmd":"dir"}'
```

响应：
- **200** → body = 命令原始字节（cmd 内置=UTF-16LE、外部程序原生如 GBK），退出码在 `X-Exit-Code`
- **非 200** → body = JSON `{"error":"..."}`（500=内部错误，504=exec 超时）

`/exec` 在 Worker 线程执行（`CreateProcess` + `CreatePipe` 读循环，**不是 `popen`**），非 API 路径（usage 页）在长命令期间仍可响应。

---

完整实现代码见 [quickwin/docker](https://github.com/quickwinlabs/quickwin/tree/main/docker)。
