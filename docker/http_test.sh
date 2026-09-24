#!/bin/bash
set -e
cd "$(dirname "$0")"

# ============================================================
#  经常驻 exec_server 的 HTTP 下发测试（win7 / xp 共用）
#  前置：run.sh <vm> 已起且健康；host 上 serve_test 在 18923。
#  用法: ./http_test.sh <win7|xp> [filter]
#    filter 透传给 test/run.js，如: -net / basic / wasm
#  协议:
#    200 → body = popen 原始字节（可为 GBK），退出码在 X-Exit-Code
#    非 200 → body = JSON {"error":"..."}
#  判定: Summary failed<=1（XP 打印机 ffi 容忍 1）
# ============================================================

VM="${1:?usage: ./http_test.sh <win7|xp> [filter]}"
FILTER="${2:-}"

case "$VM" in
  win7) FWD=8007 ;;
  xp)   FWD=8005 ;;
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

# 全量约 40-120s，给 300s；worker 里 popen，主循环不阻塞
HDR=$(mktemp)
BODY_FILE=$(mktemp)
trap 'rm -f "$HDR" "$BODY_FILE"' EXIT

HTTP_CODE=$(curl -sS -m 300 -o "$BODY_FILE" -D "$HDR" -w '%{http_code}' \
  -X POST "http://127.0.0.1:${FWD}/exec" \
  -H 'Content-Type: application/json' \
  --data "$BODY" || echo 000)

# ── 错误路径：JSON {"error"} ──
if [ "$HTTP_CODE" != "200" ]; then
  ERR=$(node -e '
    try {
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
      process.stdout.write(String(j.error || ""))
    } catch {
      process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))
    }' "$BODY_FILE")
  echo "::error::exec failed status=$HTTP_CODE error=$ERR"
  echo "--- body ---"
  cat "$BODY_FILE"
  echo
  exit 1
fi

# ── 成功：原始字节 + X-Exit-Code ──
CODE=$(tr -d '\r' < "$HDR" | awk 'tolower($1)=="x-exit-code:"{print $2}')
echo "--- exit code from exec_server: ${CODE:-n/a} ---"

# Summary 在原始字节上 grep（测试输出为 UTF-8/ASCII，不受 GBK 影响）
SUMMARY=$(grep -oE "Summary: [0-9]+/[0-9]+" "$BODY_FILE" | tail -1 || true)
if [ -z "$SUMMARY" ]; then
  echo "::error::no Summary line in response"
  echo "--- first 2KB of body ---"
  head -c 2048 "$BODY_FILE" || true
  echo
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
# popen/pclose 的 code 非 0 也提示（Summary 已主判）
if [ -n "$CODE" ] && [ "$CODE" != "0" ]; then
  echo "warning: exec_server code=$CODE (grep Summary already checked)"
fi
echo "PASS"
