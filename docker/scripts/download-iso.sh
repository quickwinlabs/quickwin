#!/bin/bash
set -e

# ============================================================
#  自动下载 Windows ISO
#  用法: ./download-iso.sh <xp|7u|10|11> [目标目录]
#
#  镜像源: download.testip.xyz (主), archive.org (备); 10/11 仍用 bobpony/files.dog
#  下载完成后调用方自行确认完整性
# ============================================================

VERSION="${1:-}"
DEST="${2:-.}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ts() { date '+%H:%M:%S'; }
info()  { echo -e "${GREEN}[$(ts)] [INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[$(ts)] [WARN]${NC} $*"; }
error() { echo -e "${RED}[$(ts)] [ERROR]${NC} $*"; exit 1; }

if [ -z "$VERSION" ]; then
    echo "用法: $0 <xp|7u|10|11> [目标目录]"
    echo ""
    echo "  xp   - Windows XP Professional SP3 中文 VL (601MB)"
    echo "  7u   - Windows 7 Ultimate SP1 x64 中文 (3.2GB)"
    echo "  10   - Windows 10 22H2 x64 (5.7GB)"
    echo "  11   - Windows 11 25H2 x64 (7.9GB)"
    exit 1
fi

# ── 检查依赖 ──
command -v wget >/dev/null 2>&1 || error "需要安装 wget"

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
        * )
            error "不支持的版本: $version (支持: xp, 7u, 10, 11)"
            ;;
    esac
}

# ── 主逻辑 ──
get_iso_info "$VERSION"

mkdir -p "$DEST"
OUTPUT="$DEST/$FILE"

# 检查是否已存在（已下载过则跳过，不重复下载）
if [ -f "$OUTPUT" ]; then
    info "文件已存在: $OUTPUT"
    exit 0
fi

# 尝试所有镜像源
# 注: bobpony/files.dog 等源不带浏览器 UA 会返回 403/拒连，必须带 UA
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
SUCCESS=false
for URL in "${URLS[@]}"; do
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

info "下载完成: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
