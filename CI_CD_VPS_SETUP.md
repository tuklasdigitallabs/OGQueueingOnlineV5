# QSYS VPS CI/CD Setup

This repo now supports GitHub Actions for both validation and VPS deployment.

This document is also safe to use for no-op pipeline verification commits when we need to confirm CI/CD wiring without changing runtime behavior.

## Workflows

- `CI`
  - runs on every pull request
  - runs on pushes to `main`
  - checks JavaScript syntax
  - checks `scripts/deploy_qsys_vps.sh` syntax
  - builds `Dockerfile.qsys`
- `Deploy VPS`
  - auto-runs after `CI` succeeds on `main`
  - can also be triggered manually from GitHub Actions
  - connects to the VPS over SSH
  - runs `scripts/deploy_qsys_vps.sh` on the server

## Required GitHub repository secrets

- `VPS_HOST`
- `VPS_USER`
- `VPS_SSH_KEY`

## Optional GitHub repository secrets

- `VPS_PORT`
  - default: `22`
- `VPS_APP_DIR`
  - default: `/opt/og-qsys/app`
- `VPS_ENV_FILE`
  - default: `/opt/og-qsys/.env.qsys`
- `VPS_DATA_DIR`
  - default: `/opt/og-qsys/data`
- `VPS_DOCKER_NETWORK`
  - default: `og-qsys-net`
- `VPS_IMAGE_NAME`
  - default: `og-qsys-app:latest`
- `VPS_CONTAINER_NAME`
  - default: `og-qsys-app`
- `VPS_HEALTH_URL`
  - default: `https://onegourmetph.com/qsys/api/health`
- `VPS_NGINX_CONTAINER`
  - default: `og_nginx`

## VPS requirements

- the server must already have:
  - Docker
  - Git
  - the repo cloned at `/opt/og-qsys/app` or your chosen `VPS_APP_DIR`
  - the runtime env file at `/opt/og-qsys/.env.qsys` or your chosen `VPS_ENV_FILE`
  - a clean app checkout with no uncommitted local changes
- the SSH user must be allowed to:
  - run `git fetch` and `git pull`
  - build Docker images
  - remove and start containers
  - optionally run `docker exec` on the Nginx container

## Deploy behavior

`scripts/deploy_qsys_vps.sh` now supports:

- `GIT_REF`
  - branch/ref to deploy
- `RELOAD_NGINX`
  - set to `1` to run `nginx -t` and `nginx -s reload` in the configured container
- `HEALTH_RETRIES`
  - retries the public health check before failing the deployment

The deploy script still performs the deployment on the VPS itself:

1. fetch latest code
2. checkout the requested branch if needed
3. fast-forward pull from the remote
4. build `Dockerfile.qsys`
5. replace the app container
6. optionally reload Nginx
7. verify the health endpoint

## Recommended first run

1. Add the required GitHub secrets.
2. Confirm the VPS SSH user can run Docker commands without interactive prompts.
3. Trigger `Deploy VPS` manually with `git_ref=main`.
4. Confirm:
   - the action log reaches `Deploy complete`
   - `https://onegourmetph.com/qsys/api/health` returns `200`
   - `docker logs og-qsys-app --tail 100` looks healthy on the VPS
