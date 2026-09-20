#!/bin/bash
# Podman dev container helper (drops docker dependency, uses podman compose)
# Usage:
#   ./dev-podman.sh up        # build + start container
#   ./dev-podman.sh shell     # enter container bash
#   ./dev-podman.sh down      # stop container
#   ./dev-podman.sh logs      # follow container logs
set -e
cd "$(dirname "$0")"

COMPOSE="docker/docker-compose.dev.yml"
IMAGE="quickwin-dev"

cmd_compose() {
    podman compose -f "$COMPOSE" "$@"
}

build_image_fallback() {
    # docker-compose provider build may hit buildx; fall back to direct podman build
    echo ">> compose build failed, building Dockerfile directly..."
    podman build -t "$IMAGE" \
        -f "$(dirname "$COMPOSE")/Dockerfile.dev" \
        "$(dirname "$COMPOSE")"
}

case "${1:-up}" in
  up)
    if cmd_compose up -d --build 2>/dev/null; then
        :
    else
        build_image_fallback
        cmd_compose up -d
    fi
    ;;
  shell)
    exec podman exec -it quickwin-dev bash
    ;;
  down)
    cmd_compose down
    ;;
  logs)
    exec podman logs -f quickwin-dev
    ;;
  *)
    echo "Usage: $0 {up|shell|down|logs}"
    exit 1
    ;;
esac