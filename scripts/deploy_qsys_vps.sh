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
#   DEPLOY_SUBDOMAINS=auto
#   SUBDOMAIN_CONTAINER_NAME=og-qsys-subdomains
#   SUBDOMAIN_ENV_FILE=/opt/og-qsys/.env.qsys-subdomains
#   SUBDOMAIN_HOST_PORT=3101
#   SUBDOMAIN_CONTAINER_PORT=3101
#   SUBDOMAIN_HEALTH_URL=http://127.0.0.1:3101/api/health

APP_DIR="${APP_DIR:-/opt/og-qsys/app}"
CONTAINER_NAME="${CONTAINER_NAME:-og-qsys-app}"
IMAGE_NAME="${IMAGE_NAME:-og-qsys-app:latest}"
ENV_FILE="${ENV_FILE:-/opt/og-qsys/.env.qsys}"
DATA_DIR="${DATA_DIR:-/opt/og-qsys/data}"
DOCKER_NETWORK="${DOCKER_NETWORK:-og-qsys-net}"
HOST_PORT="${HOST_PORT:-3100}"
CONTAINER_PORT="${CONTAINER_PORT:-3100}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${HOST_PORT}/api/health}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_REF="${GIT_REF:-main}"
HEALTH_RETRIES="${HEALTH_RETRIES:-10}"
HEALTH_DELAY_SECONDS="${HEALTH_DELAY_SECONDS:-3}"
RELOAD_NGINX="${RELOAD_NGINX:-0}"
NGINX_CONTAINER="${NGINX_CONTAINER:-og_nginx}"
DEPLOY_SUBDOMAINS="${DEPLOY_SUBDOMAINS:-auto}"
SUBDOMAIN_CONTAINER_NAME="${SUBDOMAIN_CONTAINER_NAME:-og-qsys-subdomains}"
SUBDOMAIN_ENV_FILE="${SUBDOMAIN_ENV_FILE:-/opt/og-qsys/.env.qsys-subdomains}"
SUBDOMAIN_HOST_PORT="${SUBDOMAIN_HOST_PORT:-3101}"
SUBDOMAIN_CONTAINER_PORT="${SUBDOMAIN_CONTAINER_PORT:-3101}"
SUBDOMAIN_HEALTH_URL="${SUBDOMAIN_HEALTH_URL:-http://127.0.0.1:3101/api/health}"

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

start_qsys_container() {
  local container_name="$1"
  local env_file="$2"
  local host_port="$3"
  local container_port="$4"

  echo "==> Stopping old container if present: ${container_name}"
  if docker ps -a --format '{{.Names}}' | grep -Fxq "$container_name"; then
    docker rm -f "$container_name"
  fi

  local run_args=(
    -d
    --name "$container_name"
    --restart unless-stopped
    --env-file "$env_file"
    -p "${host_port}:${container_port}"
    -v "${DATA_DIR}:/var/lib/qsys"
  )

  if [ -n "$DOCKER_NETWORK" ]; then
    run_args+=(--network "$DOCKER_NETWORK")
  fi

  echo "==> Starting new container: ${container_name}"
  docker run "${run_args[@]}" "$IMAGE_NAME"
}

check_health() {
  local health_url="$1"
  local container_name="$2"

  echo "==> Health check: ${health_url}"
  local attempt=1
  until curl -fsS "$health_url"; do
    if [ "$attempt" -ge "$HEALTH_RETRIES" ]; then
      echo >&2
      echo "ERROR: health check failed after ${HEALTH_RETRIES} attempts: ${health_url}" >&2
      docker logs "$container_name" --tail 120 || true
      exit 1
    fi
    echo
    echo "Health check attempt ${attempt}/${HEALTH_RETRIES} failed; retrying in ${HEALTH_DELAY_SECONDS}s..."
    sleep "$HEALTH_DELAY_SECONDS"
    attempt=$((attempt + 1))
  done
  echo
}

start_qsys_container "$CONTAINER_NAME" "$ENV_FILE" "$HOST_PORT" "$CONTAINER_PORT"

should_deploy_subdomains=0
if [ "$DEPLOY_SUBDOMAINS" = "1" ]; then
  should_deploy_subdomains=1
elif [ "$DEPLOY_SUBDOMAINS" = "auto" ] && [ -f "$SUBDOMAIN_ENV_FILE" ]; then
  should_deploy_subdomains=1
fi

if [ "$should_deploy_subdomains" = "1" ]; then
  if [ ! -f "$SUBDOMAIN_ENV_FILE" ]; then
    echo "ERROR: SUBDOMAIN_ENV_FILE does not exist: $SUBDOMAIN_ENV_FILE" >&2
    exit 1
  fi
  start_qsys_container "$SUBDOMAIN_CONTAINER_NAME" "$SUBDOMAIN_ENV_FILE" "$SUBDOMAIN_HOST_PORT" "$SUBDOMAIN_CONTAINER_PORT"
else
  echo "==> Subdomain container deploy skipped"
  echo "Set DEPLOY_SUBDOMAINS=1, or create $SUBDOMAIN_ENV_FILE for auto deployment."
fi

if [ "$RELOAD_NGINX" = "1" ] && [ -n "$NGINX_CONTAINER" ]; then
  echo "==> Validating and reloading Nginx"
  docker exec "$NGINX_CONTAINER" nginx -t
  docker exec "$NGINX_CONTAINER" nginx -s reload
fi

echo "==> Container status"
docker ps --filter "name=${CONTAINER_NAME}"

echo "==> Recent logs"
docker logs "$CONTAINER_NAME" --tail 80 || true
if [ "$should_deploy_subdomains" = "1" ]; then
  echo "==> Recent subdomain logs"
  docker logs "$SUBDOMAIN_CONTAINER_NAME" --tail 80 || true
fi

check_health "$HEALTH_URL" "$CONTAINER_NAME"
if [ "$should_deploy_subdomains" = "1" ]; then
  check_health "$SUBDOMAIN_HEALTH_URL" "$SUBDOMAIN_CONTAINER_NAME"
fi

echo "==> Deploy complete"
