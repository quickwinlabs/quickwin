#!/bin/bash
set -e
cd "$(dirname "$0")"

# ============================================================
#  Bare QEMU CI — 测试阶段（win7 / xp 共用）
#  从 snapshot 启动，bootstrap.bat 自动挂载 SMB 并运行 run.bat。
#  run.bat 在 VM 内直接跑完整测试套件，写完 Summary 后输出 Done。
#  用法: ./run.sh <win7|xp> [--fresh] [--stop]
#
#  验证: run.bat 首行 echo 到 ci_share/run-$VM.log，文件出现即链路已通。
# ============================================================

START_TIME=$(date +%s)
VM="${1:?usage: ./run.sh <win7|xp> [--fresh] [--stop]}"
shift

case "$VM" in
  win7)
    SNAPSHOT="$(pwd)/snapshots/win7_ready.qcow2"
    OVERLAY="$(pwd)/snapshots/win7_test.qcow2"
    MONITOR=/tmp/qemu-monitor-win7.sock
    MEM=4096; SMP=4; NETDEV=e1000; FWD=8080
    EXTRA=()
    ;;
  xp)
    SNAPSHOT="$(pwd)/snapshots/xp_ready.qcow2"
    OVERLAY="$(pwd)/snapshots/xp_test.qcow2"
    MONITOR=/tmp/qemu-monitor-xp.sock
    MEM=1024; SMP=1; NETDEV=rtl8139; FWD=8081
    EXTRA=(-machine pc-i440fx-5.2 -cpu qemu32 -device VGA,vgamem_mb=64 -vnc 0.0.0.0:1)
    ;;
  *) echo "未知 VM: $VM（可选 win7|xp）"; exit 1 ;;
esac

SHARE_DIR="${SHARE_DIR:-/workspace/_build}"
LINK=ci_share/quickwin
LOGFILE=ci_share/run-$VM.log

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
[ -f "$SNAPSHOT" ] || { echo "找不到 snapshot: $SNAPSHOT，请先运行 ./setup-${VM}.sh"; exit 1; }
[ -e /dev/kvm ] && KVM="-accel kvm"

# ── --stop: ACPI 关机 ──
# 用 qemu-${VM}.pid 是否存在判断退出（QEMU 退出时会自己 unlink），不能用 kill -0：
# 它对僵尸进程也返回 0，容器里 PID 1 不回收孤儿僵尸 → 恒为 0。
if $STOP; then
    [ -f qemu-$VM.pid ] || { echo "找不到 qemu-$VM.pid，VM 可能未运行"; exit 1; }
    QEMU_PID=$(cat qemu-$VM.pid)
    echo "system_powerdown" | socat - UNIX-CONNECT:"$MONITOR"
    for i in $(seq 1 30); do
        sleep 2
        [ -f qemu-$VM.pid ] || { echo "VM 已关机（$((i*2))s）"; exit 0; }
    done
    echo "关机超时（60s），强制 kill"
    kill -9 "$QEMU_PID"; rm -f qemu-$VM.pid
    exit 0
fi

# ── 杀旧 QEMU + 清理 ──
[ -f qemu-$VM.pid ] && { kill -9 "$(cat qemu-$VM.pid)" 2>/dev/null; sleep 1; }
rm -f qemu-$VM.pid "$LOGFILE"

# ── 创建 overlay ──
if $FRESH || [ ! -f "$OVERLAY" ]; then
    rm -f "$OVERLAY"
    echo "创建 overlay..."
    qemu-img create -f qcow2 -b "$SNAPSHOT" -F qcow2 "$OVERLAY" >/dev/null
fi

# ── 链接 _build 到 ci_share/quickwin（symlink，需 smbd wide links = yes）──
rm -rf "$LINK" && ln -s "$SHARE_DIR" "$LINK"

# ── 启动 QEMU ──
# win7/xp 硬件差异在 case 中已配置（内存/CPU/网卡/端口/machine），
# EXTRA 为空时不展开（win7 不需要 -machine 参数）。
qemu-system-x86_64 \
    $KVM \
    "${EXTRA[@]}" \
    -hda "$OVERLAY" -m "$MEM" -smp "$SMP" \
    -netdev user,id=net0,guestfwd=tcp:10.0.2.4:445-cmd:"$(pwd)/smb_wrapper.sh",hostfwd=tcp::"$FWD"-:8080 \
    -device "$NETDEV",netdev=net0 \
    -display none -pidfile qemu-$VM.pid \
    -monitor unix:"$MONITOR",server,nowait \
    -daemonize

echo "QEMU 已启动 (PID=$(cat qemu-$VM.pid))，等待 run.bat..."

# ── 等待 run.log（run.bat 首行 echo 即创建）──
for i in $(seq 1 24); do
    sleep 5
    [ -e "$LOGFILE" ] && break
    printf "\r  已等待 %ds..." $((i*5))
done
echo ""

if [ -e "$LOGFILE" ]; then
    echo "run.bat 已启动（耗时 $(( $(date +%s) - START_TIME ))s）"
    # ── 等待 run.bat 完成（run.log 出现 "Done" 行）──
    echo "等待 run.bat 完成..."
    for i in $(seq 1 120); do
        if grep -q "Done" "$LOGFILE" 2>/dev/null; then
            break
        fi
        if [ ! -f qemu-$VM.pid ]; then
            echo "VM 已退出"
            break
        fi
        sleep 5
        printf "\r  测试进行中 %ds..." $((i*5))
    done
    echo ""
    echo "--- run.log ---"
    cat "$LOGFILE"
    echo
    echo "停止: ./run.sh $VM --stop"
else
    echo "等待超时（120s），run.log 未生成"
    echo "调试: cat $LOGFILE"
    exit 1
fi