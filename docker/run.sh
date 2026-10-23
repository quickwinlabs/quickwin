#!/bin/bash
set -e
cd "$(dirname "$0")"

# ============================================================
#  Bare QEMU — 常驻模式（win7 / xp / win11 共用）
#  从 snapshot 启动，bootstrap.bat 挂 SMB 并跑 run.bat；
#  run.bat 只做防火墙/portproxy + 启动 execd，不跑测试。
#  测试经 hostfwd HTTP 下发（win7:8007 / xp:8005 / win11:8011 → guest:8080）。
#  端口助记：HTTP = 8000+版本号，noVNC = 6000+版本号（8009/6009 留空，Win9 未发布）。
#
#  用法: ./run.sh <win7|xp|win11|win11core> [--restart] [--stop]
#    win11     = 标准 tiny11(带 Defender)，默认盘 win11_ready.qcow2;
#    win11core = 精简 tiny11 core，win11_ready-core.qcow2（本仓曾自产，assets 未发布该变体）
#    两者都是 UEFI 引导：普通 OVMF（非 Secure Boot、无 TPM）；盘为 GPT 装的，故必须 pflash。
#    默认：已在跑则只做健康检查后退出（真常驻）；实际启动时无条件重建
#          overlay 与 OVMF VARS（不吃旧脏状态，跨 job/会话不残留）
#    --restart：先停再起（等价默认开机路径，兼容保留）
#    --stop：ACPI 关机
# ============================================================

START_TIME=$(date +%s)
VM_ARG="${1:?usage: ./run.sh <win7|xp|win11|win11core> [--restart] [--stop]}"
shift
# win11 有两套镜像（win11 = 标准 tiny11 / win11core = 精简 core），靠产物文件名后缀区分。
# 只有 win11 用得到 $SFX（win7/xp 恒为空）；名字原样交给下面的 case，未匹配即报错（如 win11-foo）。
VM="$VM_ARG"
SFX=""
[ "$VM_ARG" = win11core ] && { VM=win11; SFX="-core"; }
PIDFILE="qemu-${VM_ARG}.pid"

case "$VM" in
  win7)
    SNAPSHOT="$(pwd)/snapshots/win7_ready.qcow2"
    OVERLAY="$(pwd)/snapshots/win7_test.qcow2"
    MONITOR=/tmp/qemu-monitor-win7.sock
    MEM=4096; SMP=4; NETDEV=e1000; FWD=8007
    EXTRA=(-vnc 0.0.0.0:2)
    ;;
  xp)
    SNAPSHOT="$(pwd)/snapshots/xp_ready.qcow2"
    OVERLAY="$(pwd)/snapshots/xp_test.qcow2"
    MONITOR=/tmp/qemu-monitor-xp.sock
    MEM=1024; SMP=1; NETDEV=rtl8139; FWD=8005
    EXTRA=(-machine pc-i440fx-5.2 -cpu qemu32 -device VGA,vgamem_mb=64 -vnc 0.0.0.0:1)
    ;;
  win11)
    SNAPSHOT="$(pwd)/snapshots/win11_ready$SFX.qcow2"
    OVERLAY="$(pwd)/snapshots/win11_test$SFX.qcow2"
    MONITOR=/tmp/qemu-monitor-win11$SFX.sock
    MEM=8192; SMP=4; NETDEV=e1000e; FWD=8011
    # UEFI（非 secboot、无 TPM）：盘是 UEFI/GPT 装的，仍必须 pflash 引导；
    # 4M 固件是 code/vars 分离，必须给一份可写 VARS（模板不带 Secure Boot 密钥）。
    # 实测该镜像 BitLocker=Off、TPM 状态与 VARS 每轮都重建 → 没有任何东西依赖 TPM/SB，
    # 去掉后行为不变（少一个常驻 swtpm 与一类 socket 陈旧 flaky）。
    OVMF_CODE=/usr/share/edk2/ovmf/OVMF_CODE_4M.qcow2
    OVMF_VARS_TEMPLATE=/usr/share/edk2/ovmf/OVMF_VARS_4M.qcow2
    VARS="$(pwd)/snapshots/win11_VARS$SFX.qcow2"
    [ -e /dev/kvm ] && CPUOPTS=(-cpu host) || CPUOPTS=(-cpu max)
    EXTRA=(-machine q35 "${CPUOPTS[@]}" \
        -drive if=pflash,format=qcow2,readonly=on,file="$OVMF_CODE" \
        -drive if=pflash,format=qcow2,file="$VARS" \
        -vga std -vnc 0.0.0.0:3)
    ;;
  *) echo "未知 VM: $VM_ARG（可选 win7|xp|win11|win11core）"; exit 1 ;;
esac

SHARE_DIR="${SHARE_DIR:-/workspace/_build}"
LINK=ci_share/quickwin
LOGFILE=ci_share/run-$VM.log

STOP=false; RESTART=false
for a in "$@"; do
    case "$a" in
        --stop) STOP=true ;;
        --restart) RESTART=true ;;
        *) echo "未知参数: $a"; exit 1 ;;
    esac
done

# ── 依赖检查 ──
for c in qemu-system-x86_64 qemu-img socat unix2dos; do
    command -v "$c" >/dev/null || { echo "需要安装: $c"; exit 1; }
done
[ -f "$SNAPSHOT" ] || { echo "找不到 snapshot: $SNAPSHOT，请先运行 docker/scripts/fetch-ready.sh ${VM}"; exit 1; }
[ -e /dev/kvm ] && KVM="-accel kvm"

health() {
    curl -sf -m 3 "http://127.0.0.1:${FWD}/" >/dev/null 2>&1
}

# ── --stop: ACPI 关机 ──
# 用 $PIDFILE 是否存在判断退出（QEMU 退出时会自己 unlink），不能用 kill -0：
# 它对僵尸进程也返回 0，容器里 PID 1 不回收孤儿僵尸 → 恒为 0。
if $STOP; then
    [ -f $PIDFILE ] || { echo "找不到 $PIDFILE，VM 可能未运行"; exit 1; }
    QEMU_PID=$(cat $PIDFILE)
    echo "system_powerdown" | socat - UNIX-CONNECT:"$MONITOR"
    for i in $(seq 1 30); do
        sleep 2
        [ -f $PIDFILE ] || { echo "VM 已关机（$((i*2))s）"; exit 0; }
    done
    echo "关机超时（60s），强制 kill"
    kill -9 "$QEMU_PID"; rm -f $PIDFILE
    exit 0
fi

# ── 已在跑：不杀，只报健康状态（常驻语义）──
# --restart 才强制重启；实际启动路径（下方）无条件重建 overlay/VARS。
if [ -f $PIDFILE ] && ! $RESTART; then
    echo "VM 已在运行 (PID=$(cat $PIDFILE))，检查健康..."
    for i in $(seq 1 12); do
        if health; then
            echo "execd 健康 (http://127.0.0.1:${FWD}/)  耗时 $(( $(date +%s) - START_TIME ))s"
            echo "跑测试: ./http_test.sh $VM [filter]"
            echo "停止:   ./run.sh $VM_ARG --stop"
            exit 0
        fi
        [ -f $PIDFILE ] || { echo "VM 已退出"; break; }
        sleep 5
        printf "\r  等待健康 %ds..." $((i*5))
    done
    echo ""
    echo "健康检查超时（60s）——服务可能未起，尝试 --restart"
    exit 1
fi

# ── 杀旧 QEMU + 清理 ──
# pid 文件可能残留已死进程：kill 失败不能让 set -e 中断脚本
if [ -f $PIDFILE ]; then
    kill -9 "$(cat $PIDFILE)" 2>/dev/null || true
    sleep 1
fi
rm -f $PIDFILE "$LOGFILE"

# ── 创建 overlay（无条件重建：不吃旧脏状态）──
# -b 用 basename 而非绝对路径：qcow2 按"相对 overlay 所在目录"存 backing 名，
# 这样宿主建的 overlay 容器内也能打开（反之亦然），qemu-img check 两侧都可用。
rm -f "$OVERLAY"
echo "创建 overlay..."
qemu-img create -f qcow2 -b "$(basename "$SNAPSHOT")" -F qcow2 "$OVERLAY" >/dev/null

# ── OVMF VARS（win11，恒重置：不吃旧脏状态）──
# 4M 固件是 code/vars 分离，必须有可写 VARS；模板本身不带 Secure Boot 密钥。
if [ -n "$VARS" ]; then
    rm -f "$VARS"
    cp "$OVMF_VARS_TEMPLATE" "$VARS"
    echo "重置 OVMF VARS: $VARS"
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
    -display none -pidfile "$PIDFILE" \
    -monitor unix:"$MONITOR",server,nowait \
    -daemonize

echo "QEMU 已启动 (PID=$(cat $PIDFILE))，等待 execd..."

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

# ── 等 Ready（run.bat 写）+ 健康检查（execd usage 页，非 API 路径 200）──
echo "等待 execd 健康..."
for i in $(seq 1 36); do
    if health; then
        echo "execd 健康 (http://127.0.0.1:${FWD}/)  总耗时 $(( $(date +%s) - START_TIME ))s"
        echo "--- run.log ---"
        cat "$LOGFILE"
        echo
        echo "跑测试: ./http_test.sh $VM [filter]"
        echo "停止:   ./run.sh $VM_ARG --stop"
        exit 0
    fi
    if [ ! -f $PIDFILE ]; then
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
