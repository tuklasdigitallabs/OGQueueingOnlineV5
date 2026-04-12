# QSYS CI/CD Setup

This repo now includes:

- `.github/workflows/ci.yml`
  - Runs on pull requests and pushes to `main`
  - Verifies the production Docker image builds successfully
- `.github/workflows/deploy-vps.yml`
  - Runs on pushes to `main`
  - Connects to the VPS over SSH
  - Executes `scripts/deploy_qsys_vps.sh`

## Recommended Flow

1. Push code to GitHub.
2. GitHub Actions runs CI.
3. If the push is to `main`, GitHub Actions deploys to the VPS automatically.
4. The VPS script fetches the latest code, rebuilds the Docker image, restarts the container, and checks health.

## GitHub Secrets Required

Add these in GitHub repository settings under:
`Settings > Secrets and variables > Actions`

- `VPS_HOST`
  - Example: `your.server.ip.or.domain`
- `VPS_PORT`
  - Example: `22`
- `VPS_USER`
  - Example: `ogadmin`
- `VPS_SSH_PRIVATE_KEY`
  - The private SSH key GitHub Actions will use to connect to the VPS
- `VPS_APP_DIR`
  - Example: `/opt/og-qsys/app`

## VPS Requirements

The VPS user must be able to:

- SSH into the server
- `cd` into the app directory
- run `bash scripts/deploy_qsys_vps.sh`
- access Docker
- pull from the GitHub repo from inside `/opt/og-qsys/app`

If the VPS repo needs GitHub auth for `git pull`, configure deploy keys or a machine user on the server first.

## Strong Recommendation

Use branch protection on `main` so deploys only happen after CI passes and approved changes are merged.

Recommended branch protection rules:

- require pull requests before merging
- require status checks to pass
- require up-to-date branches before merge
- restrict direct pushes to `main`

## First Deployment Test

1. Add the GitHub secrets.
2. Push this workflow to GitHub.
3. Open the `Actions` tab and confirm:
   - `CI` passes
   - `Deploy VPS` connects and runs
4. Verify on the server:
   - container restarted successfully
   - `https://onegourmetph.com/qsys/api/health` responds with `ok: true`

## Future Improvements

Once this is stable, the next upgrades I recommend are:

- add a lightweight smoke test job before deploy
- send deployment notifications to Slack or email
- promote deploys from `staging` to `production` instead of deploying every `main` push
