#!/bin/bash
set -e

# ============================================================
#  自动下载 Windows ISO
#  用法: ./download-iso.sh <xp|7u|10|11> [目标目录]
#
#  镜像源: archive.org, dl.bobpony.com, files.dog
#  下载后自动校验 SHA256
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
    echo "  xp   - Windows XP Professional SP3 (590MB)"
    echo "  7u   - Windows 7 Ultimate SP1 x64 (3.1GB)"
    echo "  10   - Windows 10 22H2 x64 (5.7GB)"
    echo "  11   - Windows 11 25H2 x64 (7.9GB)"
    exit 1
fi

# ── 检查依赖 ──
command -v wget >/dev/null 2>&1 || error "需要安装 wget"
command -v sha256sum >/dev/null 2>&1 || error "需要安装 sha256sum"

# ── ISO 定义 ──
# 从 dockur/windows define.sh 提取的镜像源和校验值
get_iso_info() {
    local version="$1"

    case "${version,,}" in
        "xp" )
            FILE="en_windows_xp_professional_with_service_pack_3_x86_cd_x14-80428.iso"
            SIZE="617756672"
            SHA="62b6c91563bad6cd12a352aa018627c314cfc5162d8e9f8af0756a642e602a46"
            # 镜像源列表（按优先级排序）
            URLS=(
                "https://archive.org/download/en_windows_xp_professional_with_service_pack_3_x86_cd_x14-80428/en_windows_xp_professional_with_service_pack_3_x86_cd_x14-80428.iso"
                "https://dl.bobpony.com/windows/xp/professional/en_windows_xp_professional_with_service_pack_3_x86_cd_x14-80428.iso"
                "https://files.dog/MSDN/Windows%20XP/en_windows_xp_professional_with_service_pack_3_x86_cd_x14-80428.iso"
            )
            ;;
        "7u" | "7" )
            FILE="Win7_Ult_SP1_English_x64.iso"
            SIZE="3320903680"
            SHA="36f4fa2416d0982697ab106e3a72d2e120dbcdb6cc54fd3906d06120d0653808"
            URLS=(
                "https://archive.org/download/win7-ult-sp1-english/Win7_Ult_SP1_English_x64.iso"
                "https://dl.bobpony.com/windows/7/en_windows_7_with_sp1_x64.iso"
                "https://files.dog/MSDN/Windows%207/en_windows_7_ultimate_with_sp1_x64_dvd_u_677332.iso"
            )
            ;;
        "10" )
            FILE="en-us_windows_10_22h2_x64.iso"
            SIZE="6140975104"
            SHA="a6f470ca6d331eb353b815c043e327a347f594f37ff525f17764738fe812852e"
            URLS=(
                "https://archive.org/download/en-us_windows_10_22h2_x64/en-us_windows_10_22h2_x64.iso"
                "https://dl.bobpony.com/windows/10/en-us_windows_10_22h2_x64.iso"
            )
            ;;
        "11" )
            FILE="en-us_windows_11_25h2_x64.iso"
            SIZE="7736125440"
            SHA="d141f6030fed50f75e2b03e1eb2e53646c4b21e5386047cb860af5223f102a32"
            URLS=(
                "https://archive.org/download/en-us_windows_11_25h2_x64/en-us_windows_11_25h2_x64.iso"
                "https://dl.bobpony.com/windows/11/en-us_windows_11_25h2_x64.iso"
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

# 检查是否已存在
if [ -f "$OUTPUT" ]; then
    info "文件已存在: $OUTPUT"
    if echo "$SHA  $OUTPUT" | sha256sum -q -c - 2>/dev/null; then
        info "SHA256 校验通过，跳过下载"
        exit 0
    else
        warn "SHA256 校验失败，重新下载"
        rm -f "$OUTPUT"
    fi
fi

# 尝试所有镜像源
SUCCESS=false
for URL in "${URLS[@]}"; do
    info "尝试下载: $URL"
    if wget -q --show-progress --timeout=30 --tries=3 -O "$OUTPUT" "$URL"; then
        SUCCESS=true
        break
    else
        warn "下载失败: $URL"
        rm -f "$OUTPUT"
    fi
done

if [ "$SUCCESS" = false ]; then
    error "所有镜像源均下载失败"
fi

# 校验 SHA256
info "校验 SHA256..."
if echo "$SHA  $OUTPUT" | sha256sum -q -c -; then
    info "下载完成: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
else
    error "SHA256 校验失败！文件可能已损坏"
fi
