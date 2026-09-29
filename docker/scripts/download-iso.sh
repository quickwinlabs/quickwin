#!/bin/bash
set -e

# ============================================================
#  自动下载 Windows ISO
#  用法: ./download-iso.sh <xp|7u|10|11|tiny11> [目标目录]
#
#  镜像源: download.testip.xyz (主), archive.org (备); 10/11 仍用 bobpony/files.dog
#           tiny11 走 SourceForge (主), archive.org 备源
#  下载完成后校验 SHA256
# ============================================================

VERSION="${1:-}"
DEST="${2:-.}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ts() { date '+%H:%M:%S'; }
info()  { echo -e "${GREEN}[$(ts)] [INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[$(ts)] [WARN]${NC} $*"; }
error() { echo -e "${RED}[$(ts)] [ERROR]${NC} $*"; exit 1; }

if [ -z "$VERSION" ]; then
    echo "用法: $0 <xp|7u|10|11|tiny11> [目标目录]"
    echo ""
    echo "  xp     - Windows XP Professional SP3 中文 VL (601MB)"
    echo "  7u     - Windows 7 Ultimate SP1 x64 中文 (3.2GB)"
    echo "  10     - Windows 10 22H2 x64 (5.7GB)"
    echo "  11     - Windows 11 25H2 x64 (7.9GB)"
    echo "  tiny11 - Tiny11 Core 25H2 Pro x64 英文 (2.96GB, 不可服务化精简版)"
    exit 1
fi

# ── 检查依赖 ──
command -v wget >/dev/null 2>&1 || error "需要安装 wget"
command -v curl >/dev/null 2>&1 || error "需要安装 curl"
command -v sha256sum >/dev/null 2>&1 || error "需要安装 coreutils (sha256sum)"

# ── ISO 定义 ──
# 从 dockur/windows define.sh 提取的镜像源和校验值
get_iso_info() {
    local version="$1"

    case "${version,,}" in
        "xp" )
            FILE="zh-hans_windows_xp_professional_with_service_pack_3_x86_cd_vl_x14-74070.iso"
            SIZE="630237184"
            SHA="39430c2b8dd5c21bbd5af9116573f8c574ae896ce31d47280914ef268f01e33f"
            # 镜像源：testip 直链（约 17MB/s），archive.org 备源
            URLS=(
                "https://download.testip.xyz/windows/zh-hans_windows_xp_professional_with_service_pack_3_x86_cd_vl_x14-74070.iso"
                "https://archive.org/download/zh-hans_windows_xp_professional_with_service_pack_3_x86_cd_vl_x14-74070/zh-hans_windows_xp_professional_with_service_pack_3_x86_cd_vl_x14-74070.iso"
            )
            ;;
        "7u" | "7" )
            FILE="cn_windows_7_ultimate_with_sp1_x64_dvd_u_677408.iso"
            SIZE="3420557312"
            SHA="70cdfb0cdcbeb2659163e9417d5c242b37ae564da810e7da21dac5c8492ab72f"
            # 镜像源列表（按优先级排序）
            URLS=(
                "https://download.testip.xyz/windows/cn_windows_7_ultimate_with_sp1_x64_dvd_u_677408.iso"
                "https://archive.org/download/cn_windows_7_ultimate_with_sp1_x64_dvd_u_677408/cn_windows_7_ultimate_with_sp1_x64_dvd_u_677408.iso"
            )
            ;;
        "10" )
            FILE="en-us_windows_10_22h2_x64.iso"
            SIZE="6140975104"
            SHA="a6f470ca6d331eb353b815c043e327a347f594f37ff525f17764738fe812852e"
            URLS=(
                "https://dl.bobpony.com/windows/10/en-us_windows_10_22h2_x64.iso"
                "https://files.dog/MSDN/Windows%2010/en-us_windows_10_22h2_x64.iso"
                "https://archive.org/download/en-us_windows_10_22h2_x64/en-us_windows_10_22h2_x64.iso"
            )
            ;;
        "11" )
            FILE="en-us_windows_11_25h2_x64.iso"
            SIZE="7736125440"
            SHA="d141f6030fed50f75e2b03e1eb2e53646c4b21e5386047cb860af5223f102a32"
            URLS=(
                "https://dl.bobpony.com/windows/11/en-us_windows_11_25h2_x64.iso"
                "https://files.dog/MSDN/Windows%2011/en-us_windows_11_25h2_x64.iso"
                "https://archive.org/download/en-us_windows_11_25h2_x64/en-us_windows_11_25h2_x64.iso"
            )
            ;;
        "tiny11" )
            FILE="Tiny11Core-25H2-26200.8037-English-Pro-2026-08-23.iso"
            SIZE=""
            SHA=""
            # SourceForge 对所有镜像主机都先回一张 HTML 中转页，真实地址藏在
            # <noscript> 的 meta refresh 里（带时效签名 ts=）。必须靠 resolve_url 解析。
            # 注意: SF 对数据中心 IP（如 GitHub runner）会被 Cloudflare bot 防护拦，
            # 故备源为 archive.org 上的 NTDEV 官方镜像（文件名/校验不同，跳过 SHA）。
            URLS=(
                "https://downloads.sourceforge.net/project/tiny-11-releases/Tiny11Core-Pro-25H2/${FILE}"
                "https://archive.org/download/tiny11_25H2/tiny11core_25H2_Nov25.iso"
            )
            ;;
        * )
            error "不支持的版本: $version (支持: xp, 7u, 10, 11, tiny11)"
            ;;
    esac
}

# ── 校验 ──
verify_sha() {
    local f="$1" expect="$2" actual
    [ -z "$expect" ] && return 0
    actual=$(sha256sum "$f" | awk '{print $1}')
    if [ "$actual" != "$expect" ]; then
        rm -f "$f"
        error "SHA256 校验失败: $f
  期望: $expect
  实际: $actual
  （文件已删除）"
    fi
    info "SHA256 校验通过: $actual"
}

# ── SourceForge 中转页解析 ──
# SourceForge 对所有镜像主机（含 <mirror>.dl.sourceforge.net 和 use_mirror=xxx）
# 都先回一张 text/html 的中转页，真实地址在其 <noscript> 的 meta refresh 里，
# 且带时效签名 ts=。直接 wget 那个 URL 只会存下一个 HTML 文件。
resolve_url() {
    local url="$1" ctype resolved
    ctype=$(curl -sIL -A "$UA" --connect-timeout=20 --max-time=30 \
                 -o /dev/null -w '%{content_type}' "$url" 2>/dev/null)
    case "$ctype" in
        text/html*)
            resolved=$(curl -sL -A "$UA" --connect-timeout=20 --max-time=30 "$url" 2>/dev/null \
                | grep -o 'http-equiv="refresh" content="[^"]*url=[^"]*"' \
                | head -1 | sed 's/.*url=//; s/"$//; s/&amp;/\&/g')
            if [ -n "$resolved" ]; then
                # 注意：本函数结果会被 $(...) 捕获，日志必须走 stderr，否则会被混进 URL
                info "已解析 SourceForge 签名直链" >&2
                echo "$resolved"
                return 0
            fi
            warn "中转页里没找到签名直链，回退到原始 URL" >&2
            ;;
    esac
    echo "$url"
}

# ── 主逻辑 ──
get_iso_info "$VERSION"

mkdir -p "$DEST"
OUTPUT="$DEST/$FILE"

# 已存在则不重复下载，但仍校验完整性（否则跳过就成了完整性盲区）
if [ -f "$OUTPUT" ]; then
    info "文件已存在，校验完整性: $OUTPUT"
    verify_sha "$OUTPUT" "$SHA"
    exit 0
fi

# 尝试所有镜像源
# 注: bobpony/files.dog 等源不带浏览器 UA 会返回 403/拒连，必须带 UA
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
SUCCESS=false
for URL in "${URLS[@]}"; do
    URL=$(resolve_url "$URL")
    info "尝试下载: $URL"
    wget -q -U "$UA" --connect-timeout=20 --timeout=120 --tries=2 \
         -O "$OUTPUT" "$URL" &
    WGET_PID=$!
    # 后台运行 wget，主循环每 10 秒打印一次进度，避免 --show-progress 刷屏
    while kill -0 "$WGET_PID" 2>/dev/null; do
        sleep 10
        if [ -f "$OUTPUT" ]; then
            sz=$(du -h "$OUTPUT" 2>/dev/null | cut -f1)
            [ -n "$sz" ] && info "已下载: $sz"
        fi
    done
    # set -e 下 wait 遇到非零子进程会直接终止脚本（退出码=子进程退出码），
    # 下面的 fallback 判断永远执行不到。必须用 || 捕获退出码。
    RC=0
    wait "$WGET_PID" || RC=$?
    if [ "$RC" -eq 0 ]; then
        SUCCESS=true
        break
    else
        warn "下载失败 (wget 退出码 $RC): $URL"
        rm -f "$OUTPUT"
    fi
done

if [ "$SUCCESS" = false ]; then
    error "所有镜像源均下载失败"
fi

# 大小不符先报出来，便于区分"下到 HTML 中转页"和"真的下全了"
ACTUAL_SIZE=$(stat -c%s "$OUTPUT" 2>/dev/null || echo 0)
if [ -n "$SIZE" ] && [ "$ACTUAL_SIZE" != "$SIZE" ]; then
    rm -f "$OUTPUT"
    error "大小不符: 期望 $SIZE 字节，实际 $ACTUAL_SIZE 字节（文件已删除）"
fi

verify_sha "$OUTPUT" "$SHA"

info "下载完成: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
