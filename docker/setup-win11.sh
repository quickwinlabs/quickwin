#!/bin/bash
set -e
cd "$(dirname "$0")"

# ============================================================
#  Bare QEMU Win11 CI — 安装阶段（UEFI，无 Secure Boot / TPM）
#  安装 Win11 → 关机后打 snapshot → 之后用 run.sh 测试
#  用法: ./setup-win11.sh [变体名] [ISO 片段]
#    变体名: 留空|win11|std = 标准 tiny11(带 Defender) → win11_ready.qcow2，即 run.sh win11;
#            win11core|core = tiny11 core → win11_ready-core.qcow2，即 run.sh win11core
#    ISO 片段: 匹配 iso/win11/*<片段>*.iso —— 覆盖内置映射，免去挪动 ISO 文件
#
#  硬件检查: 由 Autounattend 的 RunSynchronous 写 LabConfig 绕过（BypassTPMCheck 等 5 项：
#            TPM/SecureBoot/RAM/CPU/Storage），因此 q35 + 普通 OVMF(pflash) 即可，不需要 swtpm / tpm-tis。
#  安装阶段完全离线（无网卡）：install.bat 只注册开机自启后关机。
#  ci_share 的链接由 run.sh 负责。
# ============================================================

START_TIME=$(date +%s)
# 变体名 → 产物后缀 + 内置选盘。留空/win11 = 标准 tiny11(带 Defender)，即 run.sh win11 的默认盘;
# win11core/core = 精简 tiny11 core(Defender 已剥离)，即 run.sh win11core。
TAG="${1:-}"
case "$TAG" in
    ""|win11|std)   SFX="";      ISO_HINT="${2:-Tiny11-25H2-}" ;;  # 标准 tiny11(25H2,可服务,带 Defender)
    win11core|core) SFX="-core"; ISO_HINT="${2:-Tiny11Core}"   ;;  # tiny11 core(Defender 已禁用)
    *)              echo "未知变体: $TAG（可选 win11|std|win11core|core，留空 = win11）"; exit 1 ;;
esac
DISK=snapshots/win11_install$SFX.qcow2
SNAPSHOT=snapshots/win11_ready$SFX.qcow2
VARS=snapshots/win11_VARS$SFX.qcow2
FLOPPY_DIR=floppy-win11
# 4M 版 OVMF 是 code/vars 分离（qcow2 镜像），必须搭配一份可写 VARS（见下方 cp）。
OVMF_CODE=/usr/share/edk2/ovmf/OVMF_CODE_4M.qcow2
OVMF_VARS=/usr/share/edk2/ovmf/OVMF_VARS_4M.qcow2
MONITOR=/tmp/qemu-monitor-win11$SFX.sock
PIDFILE=qemu-win11$SFX.pid

# ── 依赖检查 ──
for c in qemu-system-x86_64 qemu-img mcopy mkfs.vfat unix2dos; do
    command -v "$c" >/dev/null || { echo "需要安装: $c"; exit 1; }
done
[ -f "$OVMF_CODE" ] || { echo "缺少 OVMF 固件: $OVMF_CODE"; exit 1; }
[ -f "$OVMF_VARS" ] || { echo "缺少 OVMF VARS 模板: $OVMF_VARS"; exit 1; }
if [ -e /dev/kvm ]; then
    KVM="-accel kvm"; CPU=(-cpu host)
else
    echo "WARNING: KVM 不可用，将使用 TCG（很慢）"
    CPU=(-cpu max)
fi

# ── ISO ──
# ISO_HINT 为空 = 目录里第一张；非空则按片段 glob（选盘不靠挪文件，忽略大小写）
shopt -s nocaseglob
ISO="$(ls iso/win11/*${ISO_HINT}*.iso 2>/dev/null | head -1)"
if [ -z "$ISO" ]; then
    # 按变体选盘自动下载: std = 标准 tiny11(可服务化,带 Defender)，core = tiny11 core
    echo "ISO 不存在，尝试自动下载..."
    case "$TAG" in
        ""|win11|std) scripts/download-iso.sh tiny11std iso/win11 ;;
        *)            scripts/download-iso.sh tiny11    iso/win11 ;;
    esac
    ISO="$(ls iso/win11/*${ISO_HINT}*.iso 2>/dev/null | head -1)"
fi
shopt -u nocaseglob
[ -n "$ISO" ] || { echo "找不到 ISO: iso/win11/*${ISO_HINT}*.iso"; exit 1; }
echo "使用 ISO: $ISO"

mkdir -p snapshots

# ── 清理旧产物 ──
# pid 文件可能残留已死进程：kill 失败不能让 set -e 中断脚本
if [ -f "$PIDFILE" ]; then
    kill -9 "$(cat "$PIDFILE")" 2>/dev/null || true
    sleep 1
fi
rm -f floppy.img "$PIDFILE" "$DISK" "$SNAPSHOT" "$VARS"
rm -rf _oem_crlf

# ── Step 1: 创建软盘镜像 ──
dd if=/dev/zero of=floppy.img bs=512 count=2880 status=none
mkfs.vfat -F 12 floppy.img >/dev/null
mmd   -i floppy.img '::/$OEM$' '::/$OEM$/$1' '::/$OEM$/$1/OEM'
mcopy -i floppy.img "$FLOPPY_DIR/Autounattend.xml" ::/Autounattend.xml
# .bat/.cmd 必须 CRLF（与 setup-win7.sh 一致）：cmd.exe 对 LF-only 批处理的
# if(...) 块 / goto / :label 解析会失败。
mkdir -p _oem_crlf
unix2dos < "$FLOPPY_DIR/install.bat"            > _oem_crlf/install.bat
unix2dos < "$FLOPPY_DIR/bootstrap.bat"          > _oem_crlf/bootstrap.bat
unix2dos < "$FLOPPY_DIR/deftweak-pe.cmd"        > _oem_crlf/deftweak-pe.cmd
# deftweak-pe.cmd 放软盘根：它在 WinPE 阶段被 Autounattend 的 RunSynchronous 起成后台任务，
# 轮询等镜像写入目标卷后 reg load 离线 SOFTWARE hive 关 Tamper Protection（见文件头注释）。
mcopy -i floppy.img "_oem_crlf/deftweak-pe.cmd" ::/deftweak-pe.cmd
mcopy -i floppy.img "_oem_crlf/install.bat" "_oem_crlf/bootstrap.bat" '::/$OEM$/$1/OEM/'
rm -rf _oem_crlf

# ── Step 2: 创建虚拟磁盘 + OVMF VARS 独立副本 ──
qemu-img create -f qcow2 "$DISK" 64G >/dev/null
cp "$OVMF_VARS" "$VARS"

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
    -hda "$DISK" -m 8192 -smp 4 \
    -cdrom "$ISO" -fda floppy.img -boot order=dc \
    -vga std \
    -display none -pidfile "$PIDFILE" \
    -monitor unix:"$MONITOR",server,nowait \
    -daemonize

QEMU_PID=$(cat "$PIDFILE")
echo "QEMU 已启动 (PID=$QEMU_PID)，模拟按键以通过 'Press any key to boot from CD'..."
(
    for i in $(seq 1 20); do
        sleep 1
        printf "sendkey ret\n" | socat - UNIX-CONNECT:"$MONITOR" >/dev/null 2>&1
    done
) &
KEY_PID=$!

echo "等待安装完成..."

# ── Step 4: 等待安装完成（每 10s 轮询磁盘大小）──
# 用 $PIDFILE 是否存在判断退出（QEMU 干净退出时会自己 unlink）。
while [ -f "$PIDFILE" ]; do
    sleep 10
    printf "\r  [%s] %ds  disk=%s" "$(date +%H:%M:%S)" \
        "$(( $(date +%s) - START_TIME ))" "$(ls -lh "$DISK" 2>/dev/null | awk '{print $5}')"
done
echo ""

# ── Step 5: 安装盘 → ready 盘 ──
kill "$KEY_PID" 2>/dev/null || true
mv "$DISK" "$SNAPSHOT"
echo "安装完成，耗时 $(( $(date +%s) - START_TIME ))s"
echo "Ready disk: $SNAPSHOT"
echo "用 run.sh 启动测试: ./run.sh win11$SFX"