#!/bin/bash
# Start noVNC websockify bridges (one per VM)
#   XP:   host/container 6005 -> QEMU VNC 5901 (display :1)
#   Win7: host/container 6007 -> QEMU VNC 5902 (display :2)
#   Win11: host/container 6011 -> QEMU VNC 5903 (display :3)
# 端口助记：noVNC = 6000+版本号（6006/6008/6010 预留）。
# Usage: start-novnc.sh

echo "Starting noVNC websockify bridges..."
echo "  XP:   6005 -> 127.0.0.1:5901"
echo "  Win7: 6007 -> 127.0.0.1:5902"
echo "  Win11: 6011 -> 127.0.0.1:5903"

# 清理旧 bridge：精简镜像无 pkill/ps（procps 未装，历史 pkill 方案从未生效），
# 用 bash 直扫 /proc。匹配绝对路径形态 "/usr/sbin/websockify "（主进程 cmdline 与
# forkserver -c 内嵌 argv 均含此形态）——比裸词 websockify 收紧，避免误杀
# cmdline 恰好带 websockify 字样的无关进程（含调用方 shell）
for p in /proc/[0-9]*; do
    c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null) || continue
    case "$c" in */usr/sbin/websockify\ *) kill "${p##*/}" 2>/dev/null;; esac
done
sleep 1

# 目标地址用 127.0.0.1 而非 localhost：QEMU -vnc 0.0.0.0:N 只监听 IPv4，
# 而 localhost 会先解析到 ::1 导致连接失败。
nohup /usr/sbin/websockify --log - \
    --web /usr/share/novnc \
    0.0.0.0:6005 \
    127.0.0.1:5901 > /tmp/websockify-xp.log 2>&1 &
XP_PID=$!

nohup /usr/sbin/websockify --log - \
    --web /usr/share/novnc \
    0.0.0.0:6007 \
    127.0.0.1:5902 > /tmp/websockify-win7.log 2>&1 &
W7_PID=$!

nohup /usr/sbin/websockify --log - \
    --web /usr/share/novnc \
    0.0.0.0:6011 \
    127.0.0.1:5903 > /tmp/websockify-win11.log 2>&1 &
W11_PID=$!

echo "websockify XP PID: $XP_PID"
echo "websockify Win7 PID: $W7_PID"
echo "websockify Win11 PID: $W11_PID"
echo "Access XP:   http://localhost:6005/vnc.html"
echo "Access Win7: http://localhost:6007/vnc.html"
echo "Access Win11: http://localhost:6011/vnc.html"
