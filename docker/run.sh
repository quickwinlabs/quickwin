#!/bin/bash
set -e
cd "$(dirname "$0")"

# ============================================================
#  Bare QEMU — 常驻模式（win7 / xp 共用）
#  从 snapshot 启动，bootstrap.bat 挂 SMB 并跑 run.bat；
#  run.bat 只做防火墙/portproxy + 启动 exec_server，不跑测试。
#  测试经 hostfwd HTTP 下发（win7:7080 / xp:5180 → guest:8080）。
#
#  用法: ./run.sh <win7|xp> [--fresh] [--stop] [--restart]
#    默认：已在跑则只做健康检查后退出（真常驻）
#    --restart：先停再起
#    --fresh：重建 overlay 后启动
#    --stop：ACPI 关机
# ============================================================

START_TIME=$(date +%s)
VM="${1:?usage: ./run.sh <win7|xp> [--fresh] [--stop] [--restart]}"
shift

case "$VM" in
  win7)
    SNAPSHOT="$(pwd)/snapshots/win7_ready.qcow2"
    OVERLAY="$(pwd)/snapshots/win7_test.qcow2"
    MONITOR=/tmp/qemu-monitor-win7.sock
    MEM=4096; SMP=4; NETDEV=e1000; FWD=7080
    EXTRA=()
    ;;
  xp)
    SNAPSHOT="$(pwd)/snapshots/xp_ready.qcow2"
    OVERLAY="$(pwd)/snapshots/xp_test.qcow2"
    MONITOR=/tmp/qemu-monitor-xp.sock
    MEM=1024; SMP=1; NETDEV=rtl8139; FWD=5180
    EXTRA=(-machine pc-i440fx-5.2 -cpu qemu32 -device VGA,vgamem_mb=64 -vnc 0.0.0.0:1)
    ;;
  *) echo "未知 VM: $VM（可选 win7|xp）"; exit 1 ;;
esac

SHARE_DIR="${SHARE_DIR:-/workspace/_build}"
LINK=ci_share/quickwin
LOGFILE=ci_share/run-$VM.log

FRESH=false; STOP=false; RESTART=false
for a in "$@"; do
    case "$a" in
        --fresh) FRESH=true ;;
        --stop) STOP=true ;;
        --restart) RESTART=true ;;
        *) echo "未知参数: $a"; exit 1 ;;
    esac
done

# ── 依赖检查 ──
for c in qemu-system-x86_64 qemu-img socat unix2dos; do
    command -v "$c" >/dev/null || { echo "需要安装: $c"; exit 1; }
done
[ -f "$SNAPSHOT" ] || { echo "找不到 snapshot: $SNAPSHOT，请先运行 ./setup-${VM}.sh"; exit 1; }
[ -e /dev/kvm ] && KVM="-accel kvm"

health() {
    curl -sf -m 3 "http://127.0.0.1:${FWD}/health" >/dev/null 2>&1
}

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

# ── 已在跑：不杀，只报健康状态（常驻语义）──
# --restart / --fresh 才强制重启。
if [ -f qemu-$VM.pid ] && ! $RESTART && ! $FRESH; then
    echo "VM 已在运行 (PID=$(cat qemu-$VM.pid))，检查健康..."
    for i in $(seq 1 12); do
        if health; then
            echo "exec_server 健康 (http://127.0.0.1:${FWD}/health)  耗时 $(( $(date +%s) - START_TIME ))s"
            echo "跑测试: ./http_test.sh $VM [filter]"
            echo "停止:   ./run.sh $VM --stop"
            exit 0
        fi
        [ -f qemu-$VM.pid ] || { echo "VM 已退出"; break; }
        sleep 5
        printf "\r  等待健康 %ds..." $((i*5))
    done
    echo ""
    echo "健康检查超时（60s）——服务可能未起，尝试 --restart"
    exit 1
fi

# ── 杀旧 QEMU + 清理 ──
# pid 文件可能残留已死进程：kill 失败不能让 set -e 中断脚本
if [ -f qemu-$VM.pid ]; then
    kill -9 "$(cat qemu-$VM.pid)" 2>/dev/null || true
    sleep 1
fi
rm -f qemu-$VM.pid "$LOGFILE"

# ── 创建 overlay ──
if $FRESH || [ ! -f "$OVERLAY" ]; then
    rm -f "$OVERLAY"
    echo "创建 overlay..."
    qemu-img create -f qcow2 -b "$SNAPSHOT" -F qcow2 "$OVERLAY" >/dev/null
fi

# ── 链接 _build 到 ci_share/quickwin（symlink，需 smbd wide links = yes）──
# smb_wrapper: unix extensions=no + wide links=yes，Win7/XP 均已验证 cwd=[Z:\quickwin]。
# 已是指向 SHARE_DIR 的 symlink 则不动（避免 VM 使用中被删）；否则 rm 后重建。
if [ "$(readlink "$LINK" 2>/dev/null)" != "$SHARE_DIR" ]; then
    rm -rf "$LINK" && ln -s "$SHARE_DIR" "$LINK"
fi

# ── run.bat 转 CRLF ──
# git 里是 LF，但 cmd.exe 对 LF-only 批处理的 if(...) 块 / goto / :label 解析会失败：
# 简单命令能跑，块结构直接崩，表现为 net use 成功却永不执行 Z:\run.bat。
# 每次运行都转一遍（原地），不依赖 checkout 的行尾设置。
unix2dos -q ci_share/run.bat

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

echo "QEMU 已启动 (PID=$(cat qemu-$VM.pid))，等待 exec_server..."

# ── 等待 run.log（run.bat 首行 echo 即创建）──
for i in $(seq 1 24); do
    sleep 5
    [ -e "$LOGFILE" ] && break
    printf "\r  已等待 %ds..." $((i*5))
done
echo ""

if [ ! -e "$LOGFILE" ]; then
    echo "等待超时（120s），run.log 未生成"
    echo "调试: cat $LOGFILE"
    exit 1
fi
echo "run.bat 已启动（耗时 $(( $(date +%s) - START_TIME ))s）"

# ── 等 Ready（run.bat 写）+ 健康检查（exec_server /health）──
echo "等待 exec_server 健康..."
for i in $(seq 1 36); do
    if health; then
        echo "exec_server 健康 (http://127.0.0.1:${FWD}/health)  总耗时 $(( $(date +%s) - START_TIME ))s"
        echo "--- run.log ---"
        cat "$LOGFILE"
        echo
        echo "跑测试: ./http_test.sh $VM [filter]"
        echo "停止:   ./run.sh $VM --stop"
        exit 0
    fi
    if [ ! -f qemu-$VM.pid ]; then
        echo "VM 已退出"
        cat "$LOGFILE" 2>/dev/null || true
        exit 1
    fi
    sleep 5
    printf "\r  等待健康 %ds..." $((i*5))
done
echo ""
echo "健康检查超时（180s）"
echo "--- run.log ---"
cat "$LOGFILE"
exit 1
