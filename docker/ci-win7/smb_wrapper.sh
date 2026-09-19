#!/bin/bash
# QEMU guestfwd SMB wrapper - 启动支持 wide links 的 smbd
# 用法: guestfwd=tcp:10.0.2.4:445-cmd:./smb_wrapper.sh
#
# 为什么需要它：QEMU `-netdev user,smb=` 会在 /tmp/qemu-smb.* 生成临时 smb.conf，
# 且无任何参数可配置（不能加 wide links），导致 SMB 无法跟随指向共享外的符号链接。
# 用 guestfwd 把 guest 的 10.0.2.4:445 交给这个 wrapper 自管 smbd，conf 完全可控。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHARE_DIR="$SCRIPT_DIR/ci_share"
TMPDIR=$(mktemp -d /tmp/qemu-smb.XXXXXX)
trap "rm -rf $TMPDIR" EXIT

USER=$(whoami)

cat > "$TMPDIR/smb.conf" << EOF
[global]
private dir=$TMPDIR
interfaces=127.0.0.1
bind interfaces only=yes
pid directory=$TMPDIR
lock directory=$TMPDIR
state directory=$TMPDIR
cache directory=$TMPDIR
ncalrpc dir=$TMPDIR/ncalrpc
log file=$TMPDIR/log.smbd
smb passwd file=$TMPDIR/smbpasswd
security = user
map to guest = Bad User
load printers = no
printing = bsd
disable spoolss = yes
usershare max shares = 0
# 允许符号链接指向共享目录之外的目标（如 ci_share/quickwin -> /workspace/_build）
# 注意: smbd 4.24 默认 unix extensions = yes，与 wide links 互斥，会把 wide links 静默禁用。
# 必须显式关掉 unix extensions 才能让 wide links 生效（Win7 用 SMB2，不受影响）。
unix extensions = no
follow symlinks = yes
wide links = yes
[qemu]
path=$SHARE_DIR
read only=no
guest ok=yes
force user=$USER
EOF

exec /usr/sbin/smbd -l "$TMPDIR" -s "$TMPDIR/smb.conf"
