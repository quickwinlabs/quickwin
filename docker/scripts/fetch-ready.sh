#!/bin/bash
set -euo pipefail

# ============================================================
#  拉取预装系统盘：quickwinlabs/assets 的 win-images-* release
#  用法: ./fetch-ready.sh <win7|xp|win11>
#
#  盘由 assets 仓 build-image.yml 现场装机 → qcow2 原生压缩簇 → 分卷发布。
#  拼回后的文件名与 run.sh 期待的 *_ready.qcow2 一致；压缩簇是只读形态、
#  需要 qemu >= 5.4，run.sh 本来就会叠 overlay，直接可用。
#  装机逻辑的唯一维护地是 assets 的 images/setup-*.sh（本仓已无装机脚本）。
#
#  SHA256SUMS.txt 兼作 manifest：既列分卷名又列整盘 sha，故无需探测分卷数；
#  已就绪且校验通过的盘跳过下载（省 0.8–10 GB）。
# ============================================================

TYPE="${1:-}"
case "$TYPE" in
    win7)  TAG="win-images-win7";  SNAP="win7_ready.qcow2" ;;
    xp)    TAG="win-images-xp";    SNAP="xp_ready.qcow2" ;;
    win11) TAG="win-images-win11"; SNAP="win11_ready.qcow2" ;;
    "")    echo "用法: $0 <win7|xp|win11>" >&2
           echo "  win11core 无预装盘（assets 未发布该变体）" >&2
           exit 1 ;;
    *)     echo "未知类型: $TYPE（可选 win7|xp|win11）" >&2
           exit 1 ;;
esac

# 资产前缀可覆盖：大陆直连 GitHub release 常只有 ~0.5 MiB/s，可指向 ghproxy 类镜像前缀
# （ghproxy 形如 https://<node>/https://github.com/quickwinlabs/assets/releases/download）。
ASSETS_BASE="${ASSETS_BASE:-https://github.com/quickwinlabs/assets/releases/download}"
BASE="$ASSETS_BASE/$TAG"
HERE="$(cd "$(dirname "$0")/.." && pwd)"       # docker/
SNAPDIR="$HERE/snapshots"
DEST="$SNAPDIR/$SNAP"
WORK="$SNAPDIR/.parts/$TYPE"                   # 分卷暂存（snapshots/ 已 gitignore）

# 注意：release 资产下载**不带** Authorization 头。带 token 会被转发到对象存储后
# 拒绝（实测 HTTP 000），公开 release 无需鉴权即可下。
for c in curl sha256sum; do
    command -v "$c" >/dev/null || { echo "需要安装: $c" >&2; exit 1; }
done

cleanup() { rm -rf "$WORK"; rmdir "$SNAPDIR/.parts" 2>/dev/null || true; }
trap cleanup EXIT
# EXIT 陷阱在 SIGTERM 下不保证执行，需一并挂信号，否则 Ctrl-C 会留下半成品分卷
trap cleanup TERM INT HUP
mkdir -p "$WORK"

echo "[1/4] 取 manifest ($TAG)..."
curl -sfL --retry 4 --retry-delay 2 -o "$WORK/SHA256SUMS.txt" "$BASE/SHA256SUMS.txt" || {
    echo "拉不到 $TAG 的 SHA256SUMS.txt——release 未发布？检查 assets 仓" >&2
    exit 1
}

# 已就绪且校验通过 → 跳过
WANT="$(awk -v s="$SNAP" '$2==s {print $1}' "$WORK/SHA256SUMS.txt")"
if [ -n "$WANT" ] && [ -f "$DEST" ] && \
   [ "$(sha256sum "$DEST" | cut -d' ' -f1)" = "$WANT" ]; then
    echo "已就绪且校验通过: $DEST（跳过）"
    exit 0
fi

echo "[2/4] 拉分卷..."
awk '$2 ~ /\.part/ {print $2}' "$WORK/SHA256SUMS.txt" | sort -V > "$WORK/parts.txt"
[ -s "$WORK/parts.txt" ] || { echo "manifest 里没有任何 .part 分卷" >&2; exit 1; }
while IFS= read -r p; do
    echo "  $p"
    curl -sfL --retry 3 --retry-delay 2 -C - \
        -o "$WORK/$p" "$BASE/$p" || { echo "下载失败: $p" >&2; exit 1; }
done < "$WORK/parts.txt"

echo "[3/4] 校验分卷"
( cd "$WORK" && sha256sum -c --ignore-missing SHA256SUMS.txt ) || {
    echo "分卷校验失败" >&2; exit 1
}

echo "[4/4] 拼盘 + 校验整盘"
( cd "$WORK" && cat $(cat parts.txt) > "$SNAP" )
( cd "$WORK" && sha256sum -c --ignore-missing SHA256SUMS.txt ) || {
    echo "整盘校验失败" >&2; exit 1
}

mv "$WORK/$SNAP" "$DEST"
echo "就绪: $DEST ($(ls -lh "$DEST" | awk '{print $5}'))"
