#!/bin/bash
# Start noVNC websockify bridges (one per VM)
#   XP:   host/container 6005 -> QEMU VNC 5901 (display :1)
#   Win7: host/container 6007 -> QEMU VNC 5902 (display :2)
# Usage: start-novnc.sh

echo "Starting noVNC websockify bridges..."
echo "  XP:   6005 -> localhost:5901"
echo "  Win7: 6007 -> localhost:5902"

pkill -x websockify 2>/dev/null && sleep 1

nohup /usr/sbin/websockify --log - \
    --web /usr/share/novnc \
    0.0.0.0:6005 \
    localhost:5901 > /tmp/websockify-xp.log 2>&1 &
XP_PID=$!

nohup /usr/sbin/websockify --log - \
    --web /usr/share/novnc \
    0.0.0.0:6007 \
    localhost:5902 > /tmp/websockify-win7.log 2>&1 &
W7_PID=$!

echo "websockify XP PID: $XP_PID"
echo "websockify Win7 PID: $W7_PID"
echo "Access XP:   http://localhost:6005/vnc.html"
echo "Access Win7: http://localhost:6007/vnc.html"
