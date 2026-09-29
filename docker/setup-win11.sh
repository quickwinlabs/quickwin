#!/bin/bash
set -e
cd "$(dirname "$0")"

# ============================================================
#  Bare QEMU Win11 CI — 安装阶段（UEFI + Secure Boot + TPM 2.0)
#  安装 Win11 → 关机后打 snapshot → 之后用 run.sh 测试
#  用法: ./setup-win11.sh
#
#  硬件合规: q35 + OVMF_secboot(pflash) + swtpm(tpm-tis)
#  安装阶段完全离线（无网卡）：install.bat 只注册开机自启后关机。
#  ci_share 的链接由 run.sh 负责。
# ============================================================

START_TIME=$(date +%s)
DISK=snapshots/win11_install.qcow2
SNAPSHOT=snapshots/win11_ready.qcow2
VARS=snapshots/win11_VARS.qcow2
FLOPPY_DIR=floppy-win11
# 注意: 新版 edk2-ovmf 的 2M 版 OVMF（OVMF_CODE.secboot.fd）为塞尺寸剔除了
#       TPM 支持，Windows 11 会报 "必须支持 TPM 2.0"；必须用 4M 版（qcow2 镜像）。
OVMF_CODE=/usr/share/edk2/ovmf/OVMF_CODE_4M.secboot.qcow2
OVMF_VARS=/usr/share/edk2/ovmf/OVMF_VARS_4M.secboot.qcow2
TPM_DIR=/tmp/tpm-win11
TPM_SOCK=/tmp/swtpm-win11.sock
TPM_PID=/tmp/swtpm-win11.pid

# ── 依赖检查 ──
for c in qemu-system-x86_64 qemu-img mcopy mkfs.vfat unix2dos swtpm; do
    command -v "$c" >/dev/null || { echo "需要安装: $c"; exit 1; }
done
[ -f "$OVMF_CODE" ] || { echo "缺少 OVMF 安全启动固件: $OVMF_CODE"; exit 1; }
[ -f "$OVMF_VARS" ] || { echo "缺少 OVMF VARS 模板: $OVMF_VARS"; exit 1; }
if [ -e /dev/kvm ]; then
    KVM="-accel kvm"; CPU=(-cpu host)
else
    echo "WARNING: KVM 不可用，将使用 TCG（很慢）"
    CPU=(-cpu max)
fi

# ── ISO ──
ISO="$(ls iso/win11/*.iso 2>/dev/null | head -1)"
if [ -z "$ISO" ]; then
    echo "ISO 不存在，尝试自动下载..."
    scripts/download-iso.sh tiny11 iso/win11
    ISO="$(ls iso/win11/*.iso 2>/dev/null | head -1)"
fi
[ -n "$ISO" ] || { echo "找不到 ISO: iso/win11/*.iso"; exit 1; }
echo "使用 ISO: $ISO"

mkdir -p snapshots

# ── 清理旧产物 ──
# pid 文件可能残留已死进程：kill 失败不能让 set -e 中断脚本
if [ -f qemu-win11.pid ]; then
    kill -9 "$(cat qemu-win11.pid)" 2>/dev/null || true
    sleep 1
fi
rm -f floppy.img qemu-win11.pid "$TPM_PID" \
      snapshots/win11_install.qcow2 snapshots/win11_ready.qcow2 "$VARS"
rm -rf _oem_crlf "$TPM_DIR"

# ── Step 1: 创建软盘镜像 ──
dd if=/dev/zero of=floppy.img bs=512 count=2880 status=none
mkfs.vfat -F 12 floppy.img >/dev/null
mmd   -i floppy.img '::/$OEM$' '::/$OEM$/$1' '::/$OEM$/$1/OEM' \
      '::/$OEM$/$1/Setup' '::/$OEM$/$1/Setup/Scripts'
mcopy -i floppy.img "$FLOPPY_DIR/Autounattend.xml" ::/Autounattend.xml
# .bat/.cmd 必须 CRLF（与 setup-win7.sh 一致）：cmd.exe 对 LF-only 批处理的
# if(...) 块 / goto / :label 解析会失败。
mkdir -p _oem_crlf
unix2dos < "$FLOPPY_DIR/install.bat"        > _oem_crlf/install.bat
unix2dos < "$FLOPPY_DIR/bootstrap.bat"      > _oem_crlf/bootstrap.bat
unix2dos < "$FLOPPY_DIR/SetupComplete.cmd"  > _oem_crlf/SetupComplete.cmd
mcopy -i floppy.img "_oem_crlf/install.bat" "_oem_crlf/bootstrap.bat" '::/$OEM$/$1/OEM/'
mcopy -i floppy.img "_oem_crlf/SetupComplete.cmd" '::/$OEM$/$1/Setup/Scripts/'
rm -rf _oem_crlf

# ── Step 2: 创建虚拟磁盘 + OVMF VARS 独立副本 ──
qemu-img create -f qcow2 "$DISK" 64G >/dev/null
cp "$OVMF_VARS" "$VARS"

# ── Step 2b: 启动 swtpm（TPM 2.0）──
# 老 swtpm 可能还占着 $TPM_SOCK，先杀掉并清 socket，否则新 daemon 绑不上、
# qemu 会连上陈旧实例导致 Windows 报 "必须支持 TPM 2.0"。
rm -rf "$TPM_DIR" "$TPM_SOCK"
for p in /proc/[0-9]*/cmdline; do
    if tr '\0' ' ' < "$p" 2>/dev/null | grep -q "swtpm.*$TPM_SOCK"; then
        pid=${p#/proc/}; pid=${pid%/cmdline}
        kill -9 "$pid" 2>/dev/null || true
    fi
done
sleep 1
mkdir -p "$TPM_DIR"
swtpm socket \
    --tpmstate dir="$TPM_DIR" \
    --ctrl type=unixio,path="$TPM_SOCK" \
    --tpm2 \
    --pid file="$TPM_PID" \
    --daemon
echo "swtpm 已启动 (PID=$(cat "$TPM_PID"))"

# ── QEMU 启动安装 ──
# 注1: OVMF 只能用「光学」介质引导 ISO；USB-storage 会被认成硬盘、SATA CD
#       直接附 as -cdrom。
# 注2: Windows 安装镜像的 bootmgr 会等 "Press any key to boot from CD or DVD"，
#       OVMF 下不按键会超时跳到 PXE/Shell —— 启动后必须立刻模拟按键。
qemu-system-x86_64 \
    $KVM \
    -machine q35 \
    "${CPU[@]}" \
    -drive if=pflash,format=qcow2,readonly=on,file="$OVMF_CODE" \
    -drive if=pflash,format=qcow2,file="$VARS" \
    -chardev socket,id=chrtpm,path="$TPM_SOCK" \
    -tpmdev emulator,id=tpm0,chardev=chrtpm \
    -device tpm-tis,tpmdev=tpm0 \
    -hda "$DISK" -m 8192 -smp 4 \
    -cdrom "$ISO" -fda floppy.img -boot order=dc \
    -vga std \
    -display none -pidfile qemu-win11.pid \
    -monitor unix:/tmp/qemu-monitor-win11.sock,server,nowait \
    -daemonize

QEMU_PID=$(cat qemu-win11.pid)
echo "QEMU 已启动 (PID=$QEMU_PID)，模拟按键以通过 'Press any key to boot from CD'..."
(
    for i in $(seq 1 20); do
        sleep 1
        printf "sendkey ret\n" | socat - UNIX-CONNECT:/tmp/qemu-monitor-win11.sock >/dev/null 2>&1
    done
) &
KEY_PID=$!

echo "等待安装完成..."

# ── Step 4: 等待安装完成（每 10s 轮询磁盘大小）──
# 用 qemu-win11.pid 是否存在判断退出（QEMU 干净退出时会自己 unlink）。
while [ -f qemu-win11.pid ]; do
    sleep 10
    printf "\r  [%s] %ds  disk=%s" "$(date +%H:%M:%S)" \
        "$(( $(date +%s) - START_TIME ))" "$(ls -lh "$DISK" 2>/dev/null | awk '{print $5}')"
done
echo ""

# ── Step 5: 清理 swtpm + 安装盘 → ready 盘 ──
kill "$KEY_PID" 2>/dev/null || true
kill "$(cat "$TPM_PID" 2>/dev/null)" 2>/dev/null || true
rm -f "$TPM_PID"
mv "$DISK" "$SNAPSHOT"
echo "安装完成，耗时 $(( $(date +%s) - START_TIME ))s"
echo "Ready disk: $SNAPSHOT"
echo "用 run.sh 启动测试: ./run.sh win11 [--fresh]"