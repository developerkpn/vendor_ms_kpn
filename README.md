# VMS backend (vendor_ms_kpn)

Express API for the Vendor Management System: vendors, Coupa integration, and
the Materials module (single/mass material requests, dynamic approval chains,
SAP staging, material guides, AI material match). It also serves the built
frontend ([ui_vms](https://github.com/developerkpn/ui_vms)) from
`public/build`, so one image runs the whole web app.

## Layout

```
server.js            HTTPS server, routes, background jobs (cron)
ecosystem.config.js  pm2 config used by the Docker images
backend/
  routes/ controllers/ services/ models/   request flow, top to bottom
  constants/ utils/                        pure helpers (no DB, no Express)
  helper/                                  side-effecting helpers (email, DB wrapper, scheduler)
  migration/                               SQL, applied by hand (see below)
  tests/                                   node:test suites (*.test.cjs)
public/build         the frontend build (not in git; produced by ui_vms)
```

## Running locally

Node 22 (`.nvmrc`). The server reads `./<NODE_ENV>.env` (`development.env`,
`production.env`); both are gitignored and hold database, SMTP, SAP, Coupa and
AI settings.

```bash
npm ci
npm run server       # NODE_ENV=development, https://localhost:5000
npm run server_dev   # same with nodemon
```

To serve the UI as well, build the frontend first: in the sibling `ui_vms`
checkout, `npx vite build --mode production` writes into this repo's
`public/build`.

Background jobs start with the server: SAP staging push, rework e-mail inbox
poll, SAP sync, AI validation sweep. A local copy pointed at the shared dev
database runs them too, so switch off the ones you don't need
(`REWORK_EMAIL_INBOUND_ENABLED=false`, `AI_VALIDATION_ENABLED=false`) when
testing alongside the deployed dev environment.

## Tests

```bash
npm test             # node --test 'backend/tests/*.test.cjs'
```

No database or network is needed: the suites stub the DB client, the AI
recommender and the SAP staging push. Many material tests assert on the SQL
the services run; the queries are exported for that through
`materialService.__private` and must be the same strings the code executes.

## Database migrations

Migrations in `backend/migration/` are applied by hand with `psql`, in filename
order, and are written to be safe to re-run. Apply to the dev database
(`vendor_ms_dev`) first, then production (`vendor_ms`).

As of 2026-09-29 production has none of the Materials request tables
(`mat_single_request`, `mat_mass_request*`, `mat_approvers_matrix_level`,
`mst_plant`, ...). Releasing the Materials module to production needs the full
material migration set applied there first, not only the latest files.

## Environments and images

| | Dev | Production |
|---|---|---|
| URL | https://vendorms-dev.gamasap.com | https://vendorms-app.gamasap.com |
| Database | `vendor_ms_dev` | `vendor_ms` |
| ECR repository | `bwbimdm/vms` | `bwbimdm/vms-prod` |
| Tags | `dev-X.Y.Z` | `prod-X.Y.Z` (immutable) |
| Dockerfile | `Dockerfile.dev` | `Dockerfile.prod` |
| How it's built | by hand (below) | GitHub Actions (below) |

ECS runs on Graviton, so images are `linux/arm64`. The env files are not in
the image (`.dockerignore`); the ECS task definition supplies the environment.

### Dev image (by hand)

```bash
# frontend into public/build
(cd ../ui_vms && npx vite build --mode production)
docker build --platform linux/arm64 -f Dockerfile.dev -t vms:dev-X.Y.Z .
aws ecr get-login-password | docker login --username AWS --password-stdin 862989604357.dkr.ecr.ap-southeast-1.amazonaws.com
docker tag vms:dev-X.Y.Z 862989604357.dkr.ecr.ap-southeast-1.amazonaws.com/bwbimdm/vms:dev-X.Y.Z
docker push 862989604357.dkr.ecr.ap-southeast-1.amazonaws.com/bwbimdm/vms:dev-X.Y.Z
```

On an x86 machine, enable arm64 emulation once per boot:
`docker run --privileged --rm tonistiigi/binfmt --install arm64`.

### Production image (GitHub Actions)

`.github/workflows/prod-release.yml` runs when:

- this repo's `production` branch is updated,
- ui_vms's `prod` branch is updated (it sends a `repository_dispatch` here), or
- it is started by hand (Actions > Production release > Run workflow),
  optionally with a version.

It runs both test suites, builds the frontend into `public/build`, builds the
arm64 image from `Dockerfile.prod` and pushes `bwbimdm/vms-prod:prod-X.Y.Z`:
`prod-1.0.0` first, then the next patch, or the version given by hand. It does
**not** deploy; pointing the ECS service at the new tag is a manual step.

Repository settings it needs:

| Name | Kind | Purpose |
|---|---|---|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | secret | IAM user in account 862989604357 that can push to `bwbimdm/vms-prod`. The workflow stops if the keys belong to another account. |
| `CUSTOM_GITHUB_TOKEN` | secret | Token that can read `developerkpn/ui_vms` |
| `VITE_URL_LOC`, `VITE_URL`, `VITE_URL_BE`, `VITE_ETENDER` | variable (optional) | Override the frontend build values (defaults: `/api`, `/`, `/`, `https://etender.gamasap.com`) |

`aws.yml` is the older dev pipeline (branch `deploy_dev_ecs`, tag `latest`) and
is unrelated.

## AI material match

The recommender is a separate service (FastAPI, arm64 image
`bwbimdm/vms:vms-mat-ai`, port 8901); its code and models live in the `ai/`
folder next to this repo. The backend talks to it through:

```
MATERIAL_AI_MATCH_ENABLED=true
MATERIAL_AI_MATCH_URL=https://vms-ai.gamasap.com
MATERIAL_AI_MATCH_TIMEOUT_MS=30000
MATERIAL_AI_MATCH_TOP_K=5
```

With `MATERIAL_AI_MATCH_ENABLED` unset or not `true`, the backend never calls
it and the request forms submit without the pre-save check.
