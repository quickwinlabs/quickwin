#!/bin/bash
# QEMU guestfwd SMB wrapper - 启动支持 SMB1 的 smbd
# 用法: guestfwd=tcp:10.0.2.4:445-cmd:./smb_wrapper.sh
#
# 为什么需要它：XP 只支持 SMB1，而 Samba 4.11+ 默认禁用 SMB1。QEMU `-netdev user,smb=`
# 生成的临时 smb.conf 没有任何参数可配置，因此改用 guestfwd 自管 smbd，conf 完全可控。

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
# XP 用 SMB1，但 wide links 是 Samba 通用配置（不限协议）。
# smbd 4.24 会因 unix extensions 默认 yes 而静默禁用 wide links，必须显式关闭。
unix extensions = no
follow symlinks = yes
wide links = yes
server min protocol = NT1
[qemu]
path=$SHARE_DIR
read only=no
guest ok=yes
force user=$USER
EOF

exec /usr/sbin/smbd -l "$TMPDIR" -s "$TMPDIR/smb.conf"
