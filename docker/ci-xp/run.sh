#!/bin/bash
set -e
cd "$(dirname "$0")"

# ============================================================
#  Bare QEMU XP CI — 测试阶段
#  从 snapshot 启动，bootstrap.bat 自动挂载 SMB 并运行 run.bat
#  用法: ./run.sh [--fresh] [--stop]
#
#  验证: run.bat 检测 Z:\quickwin\qwin.exe 是否存在（via SMB symlink），
#  结果写到 ci_share/run.log。文件出现即说明链路已通。
#  注意: qwin.exe 目前不支持 XP，所以 run.bat 只做存在性检测，不启动 exec_server。
#  依赖: qemu-system-x86_64, qemu-img, socat
# ============================================================

START_TIME=$(date +%s)
SNAPSHOT="$(pwd)/snapshots/xp_ready.qcow2"
OVERLAY="$(pwd)/snapshots/xp_test.qcow2"
SHARE_DIR="${SHARE_DIR:-/workspace/_build}"
LINK=ci_share/quickwin

FRESH=false; STOP=false
for a in "$@"; do
    case "$a" in
        --fresh) FRESH=true ;;
        --stop) STOP=true ;;
        *) echo "未知参数: $a"; exit 1 ;;
    esac
done

# ── 依赖检查 ──
for c in qemu-system-x86_64 qemu-img socat; do
    command -v "$c" >/dev/null || { echo "需要安装: $c"; exit 1; }
done
[ -f "$SNAPSHOT" ] || { echo "找不到 snapshot: $SNAPSHOT，请先运行 ./setup.sh"; exit 1; }
[ -e /dev/kvm ] && KVM="-accel kvm"

# ── --stop: ACPI 关机 ──
if $STOP; then
    [ -f qemu.pid ] || { echo "找不到 qemu.pid，VM 可能未运行"; exit 1; }
    QEMU_PID=$(cat qemu.pid)
    kill -0 "$QEMU_PID" 2>/dev/null || { echo "QEMU (PID=$QEMU_PID) 未运行"; exit 1; }
    echo "system_powerdown" | socat - UNIX-CONNECT:/tmp/qemu-monitor-xp.sock
    for i in $(seq 1 30); do
        sleep 2
        kill -0 "$QEMU_PID" 2>/dev/null || { echo "VM 已关机（$((i*2))s）"; rm -f qemu.pid; exit 0; }
    done
    echo "关机超时（60s），强制 kill"
    kill -9 "$QEMU_PID"; rm -f qemu.pid
    exit 0
fi

# ── 杀旧 QEMU + 清理 ──
[ -f qemu.pid ] && { kill -9 "$(cat qemu.pid)" 2>/dev/null; sleep 1; }
rm -f qemu.pid ci_share/run.log

# ── 创建 overlay ──
if $FRESH || [ ! -f "$OVERLAY" ]; then
    rm -f "$OVERLAY"
    echo "创建 overlay..."
    qemu-img create -f qcow2 -b "$SNAPSHOT" -F qcow2 "$OVERLAY" >/dev/null
fi

# ── 链接 _build 到 ci_share/quickwin（symlink，需 smbd wide links = yes）──
rm -rf "$LINK" && ln -s "$SHARE_DIR" "$LINK"

# ── 启动 QEMU ──
qemu-system-x86_64 \
    $KVM \
    -machine pc-i440fx-5.2 -cpu qemu32 \
    -device VGA,vgamem_mb=64 \
    -hda "$OVERLAY" -m 1024 -smp 1 \
    -netdev user,id=net0,guestfwd=tcp:10.0.2.4:445-cmd:"$(pwd)/smb_wrapper.sh" \
    -device rtl8139,netdev=net0 \
    -vnc 0.0.0.0:1 -pidfile qemu.pid \
    -monitor unix:/tmp/qemu-monitor-xp.sock,server,nowait \
    -daemonize

echo "QEMU 已启动 (PID=$(cat qemu.pid))，等待 run.bat..."

# ── 等待 run.log（run.bat 首行 echo 即创建）──
for i in $(seq 1 24); do
    sleep 5
    [ -e ci_share/run.log ] && break
    printf "\r  已等待 %ds..." $((i*5))
done
echo ""

if [ -e ci_share/run.log ]; then
    echo "run.bat 已启动（耗时 $(( $(date +%s) - START_TIME ))s）"
    # ── 等待 run.bat 完成（run.log 出现 "Done" 行）──
    echo "等待 run.bat 完成..."
    for i in $(seq 1 120); do
        if grep -q "Done" ci_share/run.log 2>/dev/null; then
            break
        fi
        if ! kill -0 "$(cat qemu.pid)" 2>/dev/null; then
            echo "VM 已退出"
            break
        fi
        sleep 5
        printf "\r  测试进行中 %ds..." $((i*5))
    done
    echo ""
    echo "--- run.log ---"
    cat ci_share/run.log
    echo
    echo "停止: ./run.sh --stop"
else
    echo "等待超时（120s），run.log 未生成"
    echo "调试: cat ci_share/run.log"
    exit 1
fi
