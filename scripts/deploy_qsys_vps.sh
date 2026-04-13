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
#   DOCKER_NETWORK=og-qsys-net
#   GIT_REMOTE=origin
#   GIT_REF=main
#   HEALTH_RETRIES=10
#   HEALTH_DELAY_SECONDS=3
#   RELOAD_NGINX=0
#   NGINX_CONTAINER=og_nginx

APP_DIR="${APP_DIR:-/opt/og-qsys/app}"
CONTAINER_NAME="${CONTAINER_NAME:-og-qsys-app}"
IMAGE_NAME="${IMAGE_NAME:-og-qsys-app:latest}"
ENV_FILE="${ENV_FILE:-/opt/og-qsys/.env.qsys}"
DATA_DIR="${DATA_DIR:-/opt/og-qsys/data}"
DOCKER_NETWORK="${DOCKER_NETWORK:-og-qsys-net}"
HOST_PORT="${HOST_PORT:-3100}"
CONTAINER_PORT="${CONTAINER_PORT:-3100}"
HEALTH_URL="${HEALTH_URL:-https://onegourmetph.com/qsys/api/health}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_REF="${GIT_REF:-main}"
HEALTH_RETRIES="${HEALTH_RETRIES:-10}"
HEALTH_DELAY_SECONDS="${HEALTH_DELAY_SECONDS:-3}"
RELOAD_NGINX="${RELOAD_NGINX:-0}"
NGINX_CONTAINER="${NGINX_CONTAINER:-og_nginx}"

echo "==> QSYS deploy starting"
echo "APP_DIR=$APP_DIR"
echo "CONTAINER_NAME=$CONTAINER_NAME"
echo "IMAGE_NAME=$IMAGE_NAME"
echo "GIT_REMOTE=$GIT_REMOTE"
echo "GIT_REF=$GIT_REF"

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

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: VPS repo checkout is not clean. Commit, stash, or remove local changes before running automated deploys." >&2
  exit 1
fi

echo "==> Pulling latest code"
git fetch --all --prune
if git show-ref --verify --quiet "refs/heads/${GIT_REF}"; then
  git checkout --quiet "$GIT_REF"
else
  git checkout --quiet -b "$GIT_REF" "${GIT_REMOTE}/${GIT_REF}"
fi
git pull --ff-only "$GIT_REMOTE" "$GIT_REF"

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

if [ "$RELOAD_NGINX" = "1" ] && [ -n "$NGINX_CONTAINER" ]; then
  echo "==> Validating and reloading Nginx"
  docker exec "$NGINX_CONTAINER" nginx -t
  docker exec "$NGINX_CONTAINER" nginx -s reload
fi

echo "==> Container status"
docker ps --filter "name=${CONTAINER_NAME}"

echo "==> Recent logs"
docker logs "$CONTAINER_NAME" --tail 80 || true

echo "==> Health check"
attempt=1
until curl -fsS "$HEALTH_URL"; do
  if [ "$attempt" -ge "$HEALTH_RETRIES" ]; then
    echo >&2
    echo "ERROR: health check failed after ${HEALTH_RETRIES} attempts: $HEALTH_URL" >&2
    docker logs "$CONTAINER_NAME" --tail 120 || true
    exit 1
  fi
  echo
  echo "Health check attempt ${attempt}/${HEALTH_RETRIES} failed; retrying in ${HEALTH_DELAY_SECONDS}s..."
  sleep "$HEALTH_DELAY_SECONDS"
  attempt=$((attempt + 1))
done
echo

echo "==> Deploy complete"
