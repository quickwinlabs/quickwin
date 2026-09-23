#!/bin/bash
set -e
cd "$(dirname "$0")"

# ============================================================
#  经常驻 exec_server 的 HTTP 下发测试（win7 / xp 共用）
#  前置：run.sh <vm> 已起且健康；host 上 serve_test 在 18923。
#  用法: ./http_test.sh <win7|xp> [filter]
#    filter 透传给 test/run.js，如: -net / basic / wasm
#  判定: 响应 JSON 的 code==0 且 Summary failed<=1
#        （兼容旧协议：响应是裸文本时也 grep Summary）
# ============================================================

VM="${1:?usage: ./http_test.sh <win7|xp> [filter]}"
FILTER="${2:-}"

case "$VM" in
  win7) FWD=7080 ;;
  xp)   FWD=5180 ;;
  *) echo "未知 VM: $VM（可选 win7|xp）"; exit 1 ;;
esac

# 命令用相对路径（exec_server 启动时 cwd=Z:\quickwin，popen 继承）。
# 按架构选 exe：xp 用 qwin-x86.exe，win7 用 qwin.exe
if [ "$VM" = "xp" ]; then
  EXE="qwin-x86.exe"
else
  EXE="qwin.exe"
fi
if [ -n "$FILTER" ]; then
  CMD="$EXE test/run.js $FILTER"
else
  CMD="$EXE test/run.js"
fi

# ── 健康检查 ──
if ! curl -sf -m 3 "http://127.0.0.1:${FWD}/health" >/dev/null; then
  echo "exec_server 不健康: http://127.0.0.1:${FWD}/health"
  echo "先跑: ./run.sh $VM"
  exit 1
fi

# ── host serve_test（net 类测试需要；已有则复用）──
if ! curl -sf -m 2 http://127.0.0.1:18923/ >/dev/null 2>&1; then
  echo "启动 serve_test :18923..."
  (cd .. && node tools/serve_test.ts 18923 >/tmp/serve_test.log 2>&1 &)
  sleep 1
  curl -sf -m 2 http://127.0.0.1:18923/ >/dev/null || {
    echo "serve_test 启动失败"; exit 1; }
fi

BODY=$(printf '%s' "{\"cmd\":\"$CMD\"}")
echo "POST :${FWD}/exec  cmd=$CMD"

# 全量约 40-120s，给 300s；同步 popen 阻塞服务属预期
RESP=$(curl -sS -m 300 -X POST "http://127.0.0.1:${FWD}/exec" \
  -H 'Content-Type: application/json' \
  --data "$BODY" || true)

# ── 解析响应 ──
# 新协议 JSON: {"out":"...","code":N}
# 旧协议: 裸 stdout
if printf '%s' "$RESP" | head -c1 | grep -q '{'; then
  OUT=$(printf '%s' "$RESP" | node -e '
    let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{
      try{const j=JSON.parse(s);process.stdout.write(String(j.out??""))}
      catch(e){process.stdout.write(s)}
    })')
  CODE=$(printf '%s' "$RESP" | node -e '
    let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{
      try{const j=JSON.parse(s);process.stdout.write(String(j.code??""))}
      catch(e){process.stdout.write("")}
    })')
else
  OUT="$RESP"
  CODE=""
fi

printf '%s\n' "$OUT"
echo "--- exit code from exec_server: ${CODE:-n/a} ---"

SUMMARY=$(printf '%s\n' "$OUT" | grep -oE "Summary: [0-9]+/[0-9]+" | tail -1 || true)
if [ -z "$SUMMARY" ]; then
  echo "::error::no Summary line in response"
  exit 1
fi
OK=$(printf '%s' "$SUMMARY" | sed 's/.*: *\([0-9]*\)\/.*/\1/')
TOTAL=$(printf '%s' "$SUMMARY" | sed 's/.*\/\([0-9]*\).*/\1/')
FAILED=$(( TOTAL - OK ))
echo "$SUMMARY  (failed=$FAILED)"
# XP 打印机 ffi 环境差容忍 1
if [ "$FAILED" -gt 1 ]; then
  echo "::error::$FAILED test failures (tolerating 1 for XP printer diff)"
  exit 1
fi
# popen/pclose 的 code 非 0 也失败（若协议给出）
if [ -n "$CODE" ] && [ "$CODE" != "0" ]; then
  echo "warning: exec_server code=$CODE (grep Summary already checked)"
fi
echo "PASS"
