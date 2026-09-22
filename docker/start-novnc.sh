#!/bin/bash
# Start noVNC websockify bridge (VNC 5901 -> WebSocket 6080)
# Usage: start-novnc.sh

echo "Starting noVNC websockify bridge..."
echo "  VNC: 5901 (QEMU)"
echo "  WebSocket: 6080 (browser)"

# Kill existing websockify if running
pkill -x websockify 2>/dev/null && sleep 1

# Start websockify: listen on 0.0.0.0:6080, forward to VNC localhost:5901
nohup /usr/sbin/websockify --log - \
    --web /usr/share/novnc \
    0.0.0.0:6080 \
    localhost:5901 > /tmp/websockify.log 2>&1 &

WEB_PID=$!
echo "websockify PID: $WEB_PID"
echo "Access: http://localhost:6080/vnc.html"
echo "  (or http://<host-ip>:6080/vnc.html from another machine)"
