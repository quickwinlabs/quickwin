#!/bin/bash
set -e
cd "$(dirname "$0")"

# ============================================================
#  Bare QEMU XP CI — 安装阶段
#  安装 Windows XP → 重命名为 ready 盘
#  用法: ./setup-xp.sh
#
#  XP 需要在安装前修改 ISO（注入 WINNT.SIF + $OEM$ 自动安装脚本），
#  所以有 ISO 提取/重建步骤。Win7 不需要（直接用原始 ISO）。
#  安装阶段完全离线（无网卡），ci_share 的链接由 run.sh 负责。
# ============================================================

START_TIME=$(date +%s)
DISK=snapshots/xp_install.qcow2
SNAPSHOT=snapshots/xp_ready.qcow2
DISK_SIZE=20G
FLOPPY_DIR=floppy-xp

# ── 依赖检查 ──
for c in qemu-system-x86_64 qemu-img genisoimage 7z unix2dos isoinfo python3; do
    command -v "$c" >/dev/null || { echo "需要安装: $c"; exit 1; }
done
if [ -e /dev/kvm ]; then KVM="-accel kvm"; else echo "WARNING: KVM 不可用，将使用 TCG（很慢）"; fi

# ── ISO ──
ISO="$(ls iso/xp/*.iso 2>/dev/null | head -1)"
if [ -z "$ISO" ]; then
    echo "ISO 不存在，尝试自动下载..."
    scripts/download-iso.sh xp iso/xp
    ISO="$(ls iso/xp/*.iso 2>/dev/null | head -1)"
fi
[ -n "$ISO" ] || { echo "找不到 ISO: iso/xp/*.iso"; exit 1; }

mkdir -p snapshots

# ── 清理旧产物 ──
[ -f qemu-xp.pid ] && { kill -9 "$(cat qemu-xp.pid)" 2>/dev/null; sleep 1; }
rm -f snapshots/*.qcow2 xp_modified.iso qemu-xp.pid ci_share/run-*.log
rm -rf _iso_extract

# ── Step 1: 提取 ISO ──
mkdir -p _iso_extract
7z x -o_iso_extract "$ISO" -y >/dev/null
if   [ -d _iso_extract/I386 ];  then TARGET=_iso_extract/I386
elif [ -d _iso_extract/AMD64 ]; then TARGET=_iso_extract/AMD64
else echo "找不到 I386 或 AMD64 目录"; exit 1; fi
echo "目标目录: $TARGET"

# ── Step 2: 注入 WINNT.SIF + $OEM$ ──
unix2dos < "$FLOPPY_DIR/WINNT.SIF" > "$TARGET/WINNT.SIF"
OEM_DIR="_iso_extract/\$OEM\$/\$1/OEM"
mkdir -p "$OEM_DIR"
unix2dos < "$FLOPPY_DIR/install.bat"   > "$OEM_DIR/install.bat"
unix2dos < "$FLOPPY_DIR/bootstrap.bat" > "$OEM_DIR/bootstrap.bat"

# ── Step 3: 重建 ISO（subshell 内 cd，避免污染外层）──
(
  cd _iso_extract
  dd if="../$ISO" of=boot.cat bs=2048 skip=19 count=1 status=none
  VOLID=$(isoinfo -d -i "../$ISO" 2>/dev/null | grep "Volume id:" | sed 's/Volume id: //' || echo "GRTMPFPP_EN")
  # XP: 从 boot catalog 读取 Nsect (offset 39), 即 boot load size
  BOOT_LOAD_SIZE=$(python3 -c "
with open('boot.cat', 'rb') as f:
    catalog = f.read(64)
    print(ord(catalog[39:40]) or 4)")
  echo "Boot load size: $BOOT_LOAD_SIZE sectors"
  genisoimage \
      -o ../xp_modified.iso \
      -b "[BOOT]/Boot-NoEmul.img" \
      -c boot.cat -no-emul-boot \
      -boot-load-size "$BOOT_LOAD_SIZE" -boot-load-seg 0 \
      -iso-level 2 -J -l -D -N -joliet-long -relaxed-filenames \
      -V "$VOLID" . 2>&1 | tail -3
)
echo "修改后的 ISO: xp_modified.iso ($(du -h xp_modified.iso | cut -f1))"

# ── Step 4: 创建虚拟磁盘 ──
qemu-img create -f qcow2 "$DISK" "$DISK_SIZE" >/dev/null

# ── Step 5: 启动 QEMU 安装 ──
qemu-system-x86_64 \
    $KVM \
    -machine pc-i440fx-5.2 -cpu qemu32 \
    -hda "$DISK" -m 1024 -smp 1 \
    -cdrom xp_modified.iso -boot order=d \
    -display none -pidfile qemu-xp.pid \
    -monitor unix:/tmp/qemu-monitor-xp.sock,server,nowait \
    -daemonize

QEMU_PID=$(cat qemu-xp.pid)
echo "QEMU 已启动 (PID=$QEMU_PID)，等待安装完成..."

# ── Step 6: 等待安装完成（每 10s 轮询磁盘大小）──
# 用 qemu.pid 是否存在判断退出（QEMU 干净退出时会自己 unlink），不能用 kill -0：
# 它对僵尸进程也返回 0，而 -daemonize 后 QEMU 被 reparent 到 PID 1，
# 容器里 PID 1 是 shell（不回收孤儿僵尸）→ kill -0 恒为 0 → 无限等待。
while [ -f qemu-xp.pid ]; do
    sleep 10
    printf "\r  [%s] %ds  disk=%s" "$(date +%H:%M:%S)" \
        "$(( $(date +%s) - START_TIME ))" "$(ls -lh "$DISK" 2>/dev/null | awk '{print $5}')"
done
echo ""

# ── Step 7: 安装盘 → ready 盘 ──
mv "$DISK" "$SNAPSHOT"
rm -rf _iso_extract xp_modified.iso
echo "安装完成，耗时 $(( $(date +%s) - START_TIME ))s"
echo "Ready disk: $SNAPSHOT"
echo "用 run.sh 启动测试: ./run.sh xp [--fresh]"
