# Deployment Guide

This guide describes how to deploy RemitLend using Docker Compose in a production environment.

## Prerequisites

Before deploying RemitLend, ensure the deployment host has:

* Docker Engine installed and running.
* Docker Compose v2 or newer.
* Access to the GitHub Container Registry (GHCR) if the images are private.
* The required production environment variables.
* The required production secrets.
* Sufficient CPU, memory, and disk space for PostgreSQL, Redis, the backend, and frontend services.

Verify Docker and Compose:

```bash
docker --version
docker compose version
```

## Environment Configuration

Production configuration is supplied through environment variables.

Create a production environment file outside version control if required by the deployment environment:

```bash
touch .env.production
chmod 600 .env.production
```

The following variables are required by `docker-compose.production.yml`:

```env
OWNER=your-github-owner
TAG=v1.0.0

POSTGRES_DB=remitlend
POSTGRES_USER=remitlend

PII_KEK_ID=your-kek-id
PII_KMS_ENDPOINT=your-kms-endpoint
PII_KEK_REGION=your-kms-region
```

Do not commit production environment files or credentials to the repository.

For the complete environment variable reference, see `docs/ENVIRONMENT.md`.

## Production Secrets

Production secrets must not be hardcoded in `docker-compose.production.yml` or committed to Git.

Create the secrets directory:

```bash
mkdir -p secrets
```

Generate a strong PostgreSQL password:

```bash
openssl rand -base64 48 > secrets/postgres_password.txt
```

Restrict access to the secret:

```bash
chmod 600 secrets/postgres_password.txt
```

The secret file must contain only the PostgreSQL password:

```text
generated-random-password
```

Do not use:

```text
POSTGRES_PASSWORD=generated-random-password
```

The `secrets/` directory must remain outside version control.

Verify that it is ignored:

```bash
git status --ignored
```

The repository should contain a safe example file if contributors need to understand the expected structure:

```text
secrets/postgres_password.txt.example
```

Example:

```text
REPLACE_WITH_A_RANDOM_PRODUCTION_PASSWORD
```

Never place real production secrets in the example file.

## Production Deployment

### Authentication Challenge Replay Protection

The backend now persists SHA-256 digests of issued login challenge nonces and
messages in `auth_challenge_nonces`. PostgreSQL atomically consumes a matching
wallet challenge after signature verification. The public challenge/login
payloads remain unchanged. Challenges issued before a backend upgrade must be
requested again, and all backend instances must run the upgraded version for
replay protection to be consistent across the fleet.

Resource and migration impact: before this change challenge/login made zero
challenge-specific SQL calls; afterward challenge issuance makes two (a
bounded expired-row delete and insert) and login makes one indexed atomic update.
The delete is capped at 500 expired rows per request, the incoming message is
capped at 1,024 characters, and the migration adds an empty table plus its
primary-key and expiry indexes with no data backfill. These are query-count and
row-bound measurements; request latency should be compared using the existing
`http_request_duration_seconds` histogram after rollout, since a production
PostgreSQL benchmark was not available in this workspace.

Roll out the migration before deploying the upgraded backend:

1. Back up the database and apply migrations with `npm run migrate:up` from
  `backend/` (or use the deployment job that runs the same migration command).
2. Deploy the upgraded backend to all instances without leaving mixed old and
  new login handlers serving traffic.
3. Verify successful challenge/login, rejection of a second login with the same
  signed message, and `auth_challenge_nonce_total` on the protected `/metrics`
  endpoint. Watch for `auth.challenge_nonce.dependency_failure` log events.

Database transient errors use the connection layer's bounded retry policy;
continued DB failure returns HTTP 503 and authentication fails closed. Clients
can safely request a new challenge and retry. A challenge whose consumption
committed but whose response was lost may require a new challenge. Invalid
signatures do not consume a challenge.

Rollback by first restoring the previous backend version, then rolling back
the schema migration with `npm run migrate:down`. The down migration drops
challenge rows, so do not run it while upgraded handlers are active. Existing
JWTs and contract state are unaffected.

Before starting the production services, validate the Compose configuration:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  config
```

Pull the production images:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  pull
```

Start the services:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  up -d
```

The production deployment consists of:

* PostgreSQL for persistent application data.
* Redis for application caching/queueing.
* Backend API.
* Frontend application.

PostgreSQL and Redis are intentionally not exposed through host ports. They communicate with the backend through the internal Docker network.

Production images should use an explicit release tag or immutable image reference rather than a mutable `latest` or staging tag.

## Reproducible Release Bundles

Every production release is published as a single immutable release bundle. The
bundle is the only supported input to a production deployment: operators must
not deploy images or artifacts that are not referenced by a bundle manifest.

### Bundle contents

A bundle is a directory (and a matching `.tar.gz` archive) named
`remitlend-release-<source_revision>-<build_id>` containing:

| File | Purpose |
| --- | --- |
| `manifest.json` | Bundle manifest: source revision, build ID, image digests, artifact hashes, and the deployment manifest reference. |
| `lockfiles/` | Exact lockfile copies (`package-lock.json` for backend and frontend, contract `Cargo.lock`) with SHA-256 digests recorded in the manifest. |
| `test-results/` | Machine-readable test reports (unit, integration, contract, migration matrix, mutation) with pass/fail counts and the command used to produce them. |
| `schemas/` | Generated API schemas (OpenAPI JSON) and generated event/contract schemas, each with a SHA-256 digest. |
| `wasm/` | Compiled contract WASM artifacts with SHA-256 digests. |
| `deployment/` | Deployment manifest (`docker-compose.production.yml` rendered with the bundle's image digests) and the environment variable reference used. |
| `traceability.json` | Issue-to-release traceability record (see below). |

### Manifest requirements

`manifest.json` must record, at minimum:

* `source_revision`: the full 40-character Git commit SHA the bundle was built from.
* `build_id`: the CI run identifier that produced the bundle.
* `lockfile_digests`: SHA-256 of each lockfile.
* `image_digests`: immutable `@sha256:` image references for backend and frontend.
* `wasm_hashes`: SHA-256 of each contract WASM artifact.
* `schema_hashes`: SHA-256 of each generated schema.
* `test_results`: paths and digests of every test report, including the
  mutation score and the migration matrix result.
* `deployment_manifest_digest`: SHA-256 of the rendered deployment manifest.

Every artifact in the bundle must be traceable to exactly one immutable build:
the manifest is the source of truth, and any artifact whose digest does not
match the manifest must be rejected.

### Verifying a bundle before deployment

```bash
# 1. Verify the archive checksum published with the release.
sha256sum -c remitlend-release-<source_revision>-<build_id>.tar.gz.sha256

# 2. Extract and verify every artifact against the manifest.
tar -xzf remitlend-release-<source_revision>-<build_id>.tar.gz
cd remitlend-release-<source_revision>-<build_id>
npm run release:verify -- --bundle .

# 3. Confirm the source revision matches the reviewed and merged commit.
git rev-parse HEAD
```

`release:verify` recomputes every digest in `manifest.json` and fails closed if
any artifact is missing, modified, or not referenced by the manifest. Do not
deploy a bundle that fails verification.

### Deploying from a bundle

Set `TAG` in `.env.production` to the bundle's `source_revision` (or use the
rendered `deployment/docker-compose.production.yml`, which pins images by
digest) and follow the standard deployment steps above. Record the bundle name
and manifest digest in the deployment log.

### Compatibility and migration implications

* Bundles are additive: the manifest schema may gain fields, but existing
  fields are never removed or repurposed without a documented major version
  bump in `manifest_version`.
* A bundle pins the schema migrations it expects. If the target database has
  migrations newer than the bundle, the deployment must be rejected rather than
  downgraded.
* Rollback targets must be a previously verified bundle; do not rebuild an old
  revision from source, because the rebuild may not reproduce identical
  digests.

## Mutation Testing Thresholds

Authorization and ownership predicates on critical paths are covered by
mutation tests. The mutation suite mutates representative route and service
policies (for example loan ownership checks, admin-only routes, and
wallet-signature authorization) and verifies that the existing tests fail when a
check is removed or inverted.

Stable thresholds for critical paths:

| Scope | Minimum mutation score |
| --- | --- |
| Authorization and ownership predicates (critical) | 90% |
| Financial calculation and money-unit handling | 90% |
| Other backend modules | 70% |

Run the suite locally:

```bash
cd backend
npm run test:mutation
```

The mutation report is written to `test-results/mutation/` and included in the
release bundle. A release is blocked when a critical-path score falls below its
threshold. Threshold changes require review and must be recorded in the release
notes.

## Hermetic Migration and Seed Matrix

Migrations and seeds are validated against supported PostgreSQL versions using
fixtures only. The matrix runs without production data and without external
network access.

```bash
cd backend
npm run test:migrations:matrix
```

The matrix covers:

* Supported PostgreSQL versions (see `docs/ENVIRONMENT.md` for the supported
  range).
* Empty database: apply all migrations and seeds from scratch.
* Prior-schema fixtures: apply migrations and seeds on top of a populated
  previous schema.
* Rollback and retry: `migrate:down` followed by `migrate:up`, and re-running a
  partially applied migration to confirm idempotent retry behavior.

Results are written to `test-results/migrations/` and included in the release
bundle. A failing matrix entry blocks the release.

## Issue-to-Release Traceability

Financial changes must be traceable from accepted requirements to the release
that ships them.

1. Each accepted requirement (issue) is linked to its implementation PR(s) in
   the PR description using `Closes #<issue>` or `Refs #<issue>`.
2. The PR records the required risk evidence: tests added, mutation results,
   migration matrix results, and any compatibility or migration notes.
3. The release notes list every issue included in the bundle and link to the
   PRs and evidence.
4. `traceability.json` in the bundle records each issue, its linked PRs, the
   evidence artifacts, and the release notes entry.

A release is blocked when a high-risk acceptance criterion is unresolved or
silently waived. Waivers must be explicit: recorded in the issue, approved by a
reviewer, and listed in the release notes. The release check fails closed when
`traceability.json` is missing, when an issue has no linked PR, or when a
high-risk issue is marked unresolved without an approved waiver.

### Reproducible validation evidence

The implementation PR for a release-related change must include the commands
run and their results, for example:

```bash
npm run release:verify -- --bundle <bundle>
npm run test:mutation
npm run test:migrations:matrix
```

Attach the resulting reports (or links to the CI run that produced them) so a
reviewer can reproduce the validation from the bundle alone.

## Expand-Contract Migrations

Schema changes that old and new application versions cannot both tolerate must
be split into two independently deployed migrations. The reference example is
`notifications.read` (boolean) to `notifications.read_at` (timestamptz).

| Phase | Location | Command | Reversible |
| --- | --- | --- | --- |
| Expand | `backend/migrations/1806000000000_notifications-read-at-expand.js` | `npm run migrate:up` | Yes (`migrate:down` drops new column/trigger) |
| Contract | `backend/migrations-contract/1806100000000_notifications-drop-read.js` | `npm run migrate:contract:up` | Schema only; dropped data is derived back from `read_at` |

Contract migrations are tracked in a separate `pgmigrations_contract` table and
are never run by `npm run migrate:up`.

### Required sequencing

1. Back up the database.
2. Run the expand migration (additive; a trigger keeps `read` and `read_at` in
   sync for writes from old and new code, so the currently deployed app keeps working).
3. Deploy the new application version (reads/writes `read_at` only).
4. Roll out fully; wait out the rollback window.
5. Run the contract migration in a later release.

### Release gates for the contract step

- No running app instance (including workers and rollback targets) references the old column.
- Expand migration applied everywhere and backfill complete (the contract migration also asserts this and aborts otherwise).
- A verified backup taken after the last old-version instance was retired.
- Contract migration is a separate release/approval from the expand release.

### Rollback guidance

- Before contract: roll back the app freely; the old column is still maintained. `npm run migrate:down` removes the expand artifacts.
- Contract step is the irreversible point: `migrate:contract:down` re-creates `read` from `read_at`, but any data not representable in `read_at` and any old-version deployments are not restored. Prefer restoring from backup for full recovery.
- Tested paths (`backend/src/__tests__/expandContractMigration.test.ts`, run in CI with the backend suite and a Postgres service): migration on a populated prior schema, on a fresh install, old/new writer sync, a concurrent-write test (no lost or duplicated rows), and the gated contract drop.

## Verifying the Deployment

Check the status of all services:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  ps
```

Services should report a healthy or running state according to their configured health checks.

Check the backend logs:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  logs --tail=100 backend
```

Check all service logs:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  logs --tail=100
```

If the application exposes health endpoints, verify them from the deployment host or through the configured frontend/reverse proxy.

## Blue-Green Deployment (Staging)

Staging runs two copies of the app side by side — the **blue** and **green**
slots — behind nginx. Only one slot is live at a time. `deploy-staging.yml`
always deploys to the idle slot, checks it, and only then moves traffic
(issue #797).

| Slot  | Backend port | Frontend port | Compose project   |
|-------|--------------|---------------|-------------------|
| blue  | 3001         | 3000          | `remitlend-blue`  |
| green | 3101         | 3100          | `remitlend-green` |

Both slots bind to `127.0.0.1` and share the long-lived `db`/`redis` services
from `docker-compose.staging.yml` over the `remitlend_default` network. The
slot services are defined in `deploy/blue-green/docker-compose.slot.yml`, and
`scripts/deploy/blue-green.sh` manages them. The workflow pipes that script
over SSH, so the host needs only Docker, nginx, curl and `jq` or `python3`.

### Pipeline

1. **deploy-green** starts `staging-<sha>` in the idle slot. The live slot
   keeps serving.
2. **smoke-test** runs these checks directly against the idle slot's local port:
   - `GET /health` → 200 (the check waits up to 90 s for the process to start)
   - `GET /healthz/ready` → 200 (DB and Redis reachable)
   - `GET /docs.json` → valid OpenAPI JSON (`openapi`/`swagger` plus `paths`)
   - `POST /api/auth/challenge` → 200 (unauthenticated; the request uses a dummy public key)
3. **switch-traffic** runs only if every check passes. It rewrites
   `/etc/nginx/conf.d/remitlend-upstream.conf` to point at the new slot, runs
   `nginx -t`, and reloads nginx. If the reload fails, the old upstream file
   is restored. The old slot is **left running** as the rollback target. The
   live and previous slots are recorded in `$DEPLOY_DIR/state/`.
4. **deploy-failed** runs if the smoke tests or the switch fail. It confirms
   the old slot is still live, saves the failed slot's logs, and tears that
   slot down. It then sends an alert: a message to `STAGING_ALERT_WEBHOOK`
   (if set) and a `deploy-failure` GitHub issue. Finally it marks the run as
   failed. Traffic never moved, so no user saw the bad build.

Only one staging deploy or rollback runs at a time (`concurrency: deploy-staging`).

### Manual rollback

To roll back, open **Actions → Rollback Staging → Run workflow** and enter a
reason. The workflow runs `blue-green.sh rollback`, which:

1. smoke-tests the previous slot (it is still running from the last deploy);
2. switches nginx back to it, if the checks pass. If they fail, nothing is
   switched and the run fails.

To do the same from the host:

```bash
cd /opt/remitlend
bash scripts/deploy/blue-green.sh active      # which slot is live
bash scripts/deploy/blue-green.sh rollback    # smoke-test previous slot, then swap
bash scripts/deploy/blue-green.sh switch blue # force a specific slot (must be running)
```

Rollback swaps only the application containers. Database migrations must stay
backward compatible with the previous release, as described in
[Expand-Contract Migrations](#expand-contract-migrations). Pending chain
transactions are not resubmitted.

### Required configuration

| Name | Kind | Purpose |
|------|------|---------|
| `STAGING_ENABLED` | variable | `true` to run the blue-green jobs |
| `STAGING_DEPLOY_DIR` | variable | Checkout location on the host (default `/opt/remitlend`) |
| `STAGING_SSH_HOST` / `STAGING_SSH_USER` | secret | Deploy host and user. The user needs Docker access and passwordless `sudo` for `install`, `cp` and `nginx`. |
| `STAGING_SSH_KEY` | secret | Private key for the deploy user |
| `STAGING_SSH_KNOWN_HOSTS` | secret | Pinned host key (`ssh-keyscan` output) |
| `STAGING_ALERT_WEBHOOK` | secret (optional) | Slack-compatible incoming webhook for failure alerts |

The nginx site config must proxy to the managed upstream names:

```nginx
include /etc/nginx/conf.d/remitlend-upstream.conf;
location /api/ { proxy_pass http://remitlend_backend; }
location /     { proxy_pass http://remitlend_frontend; }
```

## Viewing Logs

Follow backend logs:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  logs -f backend
```

Follow frontend logs:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  logs -f frontend
```

Follow database logs:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  logs -f db
```

Avoid logging or printing environment variables containing secrets.

## Updating the Deployment

Use an explicit production image tag when deploying a new release.

Update the `TAG` value in `.env.production`:

```env
TAG=v1.1.0
```

Validate the new configuration:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  config
```

Pull the new images:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  pull
```

Recreate the services:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  up -d
```

Verify the deployment after the update:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  ps
```

If the deployment fails, inspect the service logs before rolling back.

## Stopping the Deployment

To stop and remove the running containers:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  down
```

This does not remove named volumes by default, so PostgreSQL data remains available.

Do not use:

```bash
docker compose down -v
```

in production unless you intentionally want to delete the persistent volumes and understand the data-loss consequences.

## Backup and Recovery

PostgreSQL data is stored in the persistent `postgres_data` Docker volume.

Production deployments should have an external PostgreSQL backup strategy. Docker volumes alone should not be considered a complete backup solution.

Before performing destructive maintenance or migrations, ensure a recent database backup is available.

A PostgreSQL dump can be created with:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  exec -T db \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > remitlend-backup.sql
```

Store production backups outside the application host and protect them according to the project's data-security requirements.

For recovery, restore the database using the appropriate PostgreSQL restore procedure after ensuring the target database is available.

## Production Security Practices

The production Compose configuration follows these principles:

* PostgreSQL is not publicly exposed.
* Redis is not publicly exposed.
* Production credentials are not hardcoded in the Compose file.
* Sensitive credentials are supplied through secrets.
* Production image tags are explicit and reproducible.
* Containers use restart policies.
* Containers have CPU and memory resource limits.
* Services use health checks where supported.
* Containers use `no-new-privileges` where supported.
* Persistent application data is stored in named volumes.
* Production environment files and secrets must not be committed to Git.

Always review `docs/ENVIRONMENT.md` when adding or changing environment variables.

## Load Shedding (issue #809)

The backend includes a load-shedding middleware (`src/middleware/loadShedding.ts`)
that returns `503 Service Unavailable` with a `Retry-After` header when the
Node.js process exceeds capacity thresholds.

### How it works

Two metrics are sampled on every request:

| Metric | Implementation |
|---|---|
| Event-loop lag | `perf_hooks.monitorEventLoopDelay` histogram mean (1 kHz poll, 20 ms resolution) |
| V8 heap usage | `v8.getHeapStatistics().used_heap_size / heap_size_limit × 100` |

When either metric exceeds its threshold, the middleware responds immediately
with `503` and `Retry-After: 5` before any handler runs. The response body
includes a human-readable error and `retryAfter` (seconds).

Healthy endpoints (`/health`, `/healthz/*`, `/metrics`) are always exempt.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `LOAD_SHED_LAG_MS` | `100` | Event-loop lag threshold in milliseconds |
| `LOAD_SHED_HEAP_PCT` | `85` | Heap usage threshold as a percentage (0–100) |

Example `.env.production` entries:

```env
LOAD_SHED_LAG_MS=100
LOAD_SHED_HEAP_PCT=85
```

### Prometheus metrics

| Metric | Labels | Description |
|---|---|---|
| `requests_shed_total` | `reason` (`event_loop_lag` \| `heap_usage`) | Requests rejected by load shedding |

Alert example:

```yaml
# Alert when shed rate exceeds 5 rps over 2 minutes.
- alert: HighLoadShedRate
  expr: rate(requests_shed_total[2m]) > 5
  for: 1m
  labels:
    severity: warning
  annotations:
    summary: "RemitLend backend is shedding load"
    description: "{{ $value | humanize }} req/s rejected (reason={{ $labels.reason }})"
```

### Middleware ordering

Load shedding is registered after `globalRateLimiter` (which also defends
against external flooding) but before all other middleware and route handlers,
so it incurs minimal per-request overhead.

```
globalRateLimiter → loadSheddingMiddleware → requestIdMiddleware → … → routes
```

