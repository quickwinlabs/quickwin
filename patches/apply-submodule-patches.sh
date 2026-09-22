#!/bin/sh
# Apply XP compatibility patches to git submodules (WAMR, wolfSSL).
# Idempotent: detects already-applied patches via reverse check.

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

apply_patch() {
    SUBDIR="$1"
    PATCH="$2"

    [ -d "$ROOT/$SUBDIR" ] || { echo "  ERROR: $SUBDIR not found"; return 1; }
    [ -f "$ROOT/$PATCH" ] || { echo "  ERROR: patch $PATCH not found"; return 1; }

    # Reverse check succeeds = patch already applied
    if (cd "$ROOT/$SUBDIR" && git apply --reverse --check "$ROOT/$PATCH" 2>/dev/null); then
        echo "  $SUBDIR: already applied"
        return 0
    fi

    # Forward check must succeed before applying
    if ! (cd "$ROOT/$SUBDIR" && git apply --check "$ROOT/$PATCH" 2>/dev/null); then
        # Windows runners default core.autocrlf=true, which checks out files with
        # CRLF while the patch has LF endings, so git apply fails even though the
        # content matches. Normalize to LF (re-checkout only files the patch touches)
        # and retry before giving up.
        echo "  $SUBDIR: initial check failed, normalizing line endings..."
        FILES=$(grep '^diff --git ' "$ROOT/$PATCH" | sed 's|.* b/||')
        if (cd "$ROOT/$SUBDIR" && git config core.autocrlf false \
            && git checkout HEAD -- $FILES \
            && git apply --check "$ROOT/$PATCH" 2>/dev/null); then
            :
        else
            echo "  ERROR: $SUBDIR patch cannot be applied" >&2
            echo "  Run: git submodule update --init $SUBDIR" >&2
            return 1
        fi
    fi

    (cd "$ROOT/$SUBDIR" && git apply "$ROOT/$PATCH")
    echo "  $SUBDIR: applied"
}

echo "Applying submodule patches..."
apply_patch "deps/wamr"    "patches/wamr-xp-compat.patch"
apply_patch "deps/wolfssl" "patches/wolfssl-xp-compat.patch"
