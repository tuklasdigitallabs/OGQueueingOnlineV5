#!/usr/bin/env bash
set -euo pipefail

# QSYS VPS deploy script
#
# Run this ON the VPS after your latest code is available in the repo checkout.
# Default layout is based on QSYS_VPS_NGINX_SETUP.md.
#
# Example:
#   bash scripts/deploy_qsys_vps.sh
#
# Optional overrides:
#   APP_DIR=/opt/og-qsys/app
#   CONTAINER_NAME=og-qsys-app
#   IMAGE_NAME=og-qsys-app:latest
#   ENV_FILE=/opt/og-qsys/.env.qsys
#   DATA_DIR=/opt/og-qsys/data
#   DOCKER_NETWORK=og-inventory_default

APP_DIR="${APP_DIR:-/opt/og-qsys/app}"
CONTAINER_NAME="${CONTAINER_NAME:-og-qsys-app}"
IMAGE_NAME="${IMAGE_NAME:-og-qsys-app:latest}"
ENV_FILE="${ENV_FILE:-/opt/og-qsys/.env.qsys}"
DATA_DIR="${DATA_DIR:-/opt/og-qsys/data}"
DOCKER_NETWORK="${DOCKER_NETWORK:-}"
HOST_PORT="${HOST_PORT:-3100}"
CONTAINER_PORT="${CONTAINER_PORT:-3100}"
HEALTH_URL="${HEALTH_URL:-https://onegourmetph.com/qsys/api/health}"

echo "==> QSYS deploy starting"
echo "APP_DIR=$APP_DIR"
echo "CONTAINER_NAME=$CONTAINER_NAME"
echo "IMAGE_NAME=$IMAGE_NAME"

if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: APP_DIR does not exist: $APP_DIR" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: ENV_FILE does not exist: $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$DATA_DIR"

cd "$APP_DIR"

echo "==> Git status"
git status --short || true

echo "==> Pulling latest code"
git fetch --all --prune
git pull --ff-only

echo "==> Building Docker image"
docker build -t "$IMAGE_NAME" -f Dockerfile.qsys .

echo "==> Stopping old container if present"
if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
  docker rm -f "$CONTAINER_NAME"
fi

RUN_ARGS=(
  -d
  --name "$CONTAINER_NAME"
  --restart unless-stopped
  --env-file "$ENV_FILE"
  -p "${HOST_PORT}:${CONTAINER_PORT}"
  -v "${DATA_DIR}:/var/lib/qsys"
)

if [ -n "$DOCKER_NETWORK" ]; then
  RUN_ARGS+=(--network "$DOCKER_NETWORK")
fi

echo "==> Starting new container"
docker run "${RUN_ARGS[@]}" "$IMAGE_NAME"

echo "==> Container status"
docker ps --filter "name=${CONTAINER_NAME}"

echo "==> Recent logs"
docker logs "$CONTAINER_NAME" --tail 80 || true

echo "==> Health check"
sleep 3
curl -fsS "$HEALTH_URL"
echo

echo "==> Deploy complete"
