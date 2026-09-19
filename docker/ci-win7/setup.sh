#!/bin/bash
set -e
cd "$(dirname "$0")"

# ============================================================
#  Bare QEMU Win7 CI — 安装阶段
#  安装 Win7 → 关机后打 snapshot → 之后用 run.sh 测试
#  用法: ./setup.sh
#
#  安装阶段完全离线（无网卡）：install.bat 只注册开机自启后关机。
#  ci_share 的链接由 run.sh 负责。
# ============================================================

START_TIME=$(date +%s)
DISK=snapshots/win7_install.qcow2
SNAPSHOT=snapshots/win7_ready.qcow2

# ── 依赖检查 ──
for c in qemu-system-x86_64 qemu-img mcopy mkfs.vfat; do
    command -v "$c" >/dev/null || { echo "需要安装: $c"; exit 1; }
done
if [ -e /dev/kvm ]; then KVM="-accel kvm"; else echo "WARNING: KVM 不可用，将使用 TCG（很慢）"; fi

# ── ISO ──
ISO="$(ls iso/*.iso 2>/dev/null | head -1)"
if [ -z "$ISO" ]; then
    echo "ISO 不存在，尝试自动下载..."
    ../scripts/download-iso.sh 7u iso
    ISO="$(ls iso/*.iso 2>/dev/null | head -1)"
fi
[ -n "$ISO" ] || { echo "找不到 ISO: iso/*.iso"; exit 1; }

mkdir -p snapshots

# ── 清理旧产物 ──
[ -f qemu.pid ] && { kill -9 "$(cat qemu.pid)" 2>/dev/null; sleep 1; }
rm -f floppy.img qemu.pid snapshots/*.qcow2

# ── Step 1: 创建软盘镜像 ──
dd if=/dev/zero of=floppy.img bs=512 count=2880 status=none
mkfs.vfat -F 12 floppy.img >/dev/null
mmd   -i floppy.img '::/$OEM$' '::/$OEM$/$1' '::/$OEM$/$1/OEM'
mcopy -i floppy.img floppy/Autounattend.xml ::/Autounattend.xml
mcopy -i floppy.img floppy/install.bat floppy/bootstrap.bat '::/$OEM$/$1/OEM/'

# ── Step 2: 创建虚拟磁盘 ──
qemu-img create -f qcow2 "$DISK" 30G >/dev/null

# ── Step 3: 启动 QEMU 安装 ──
qemu-system-x86_64 \
    $KVM \
    -hda "$DISK" -m 4096 -smp 4 \
    -cdrom "$ISO" -fda floppy.img -boot order=dc \
    -display none -pidfile qemu.pid \
    -monitor unix:/tmp/qemu-monitor-win7.sock,server,nowait \
    -daemonize

QEMU_PID=$(cat qemu.pid)
echo "QEMU 已启动 (PID=$QEMU_PID)，等待安装完成..."

# ── Step 4: 等待安装完成（每 10s 轮询磁盘大小）──
while kill -0 "$QEMU_PID" 2>/dev/null; do
    sleep 10
    printf "\r  [%s] %ds  disk=%s" "$(date +%H:%M:%S)" \
        "$(( $(date +%s) - START_TIME ))" "$(ls -lh "$DISK" 2>/dev/null | awk '{print $5}')"
done
echo ""

# ── Step 5: 安装盘 → ready 盘 ──
mv "$DISK" "$SNAPSHOT"
echo "安装完成，耗时 $(( $(date +%s) - START_TIME ))s"
echo "Ready disk: $SNAPSHOT"
echo "用 run.sh 启动测试: ./run.sh [--fresh]"
