#!/bin/bash
# Podman dev container helper (drops docker dependency, uses podman compose)
# Usage:
#   ./dev-podman.sh up        # start container (reuse local image, no rebuild)
#   ./dev-podman.sh build     # rebuild image from Dockerfile.dev
#   ./dev-podman.sh shell     # enter container bash
#   ./dev-podman.sh down      # stop container
#   ./dev-podman.sh logs      # follow container logs
set -e
cd "$(dirname "$0")"

COMPOSE="docker-compose.dev.yml"
IMAGE="localhost/quickwin-dev:latest"

cmd_compose() {
    podman compose -f "$COMPOSE" "$@"
}

build_image_fallback() {
    # docker-compose provider build may hit buildx; fall back to direct podman build
    echo ">> compose build failed, building Dockerfile directly..."
    podman build -t "$IMAGE" -f Dockerfile.dev .
}

case "${1:-up}" in
  up)
    # 默认复用本地已有镜像（compose 已写 image: + pull_policy: never）
    # 需要重建镜像时：./dev-podman.sh build
    if cmd_compose up -d --no-build 2>/dev/null; then
        :
    else
        build_image_fallback
        cmd_compose up -d --no-build
    fi
    ;;
  build)
    cmd_compose build
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
    echo "Usage: $0 {up|build|shell|down|logs}"
    exit 1
    ;;
esac