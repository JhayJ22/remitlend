# Backend

Node.js service for the lending platform. It exposes the REST API, runs database
migrations, and hosts the scheduled jobs.

## Supported toolchain

| Tool | Supported version |
| --- | --- |
| Node.js | 20.x LTS (18.x works, 22.x untested) |
| npm | 10.x (ships with Node 20) |
| PostgreSQL | 15.x or 16.x |
| Docker | 24.x+ (only needed for the container workflow) |

If `node --version` reports anything older than 18, install Node 20 LTS before
continuing. The scripts below assume `npm`; `yarn` and `pnpm` are not supported.

## Clean-checkout quick start

These are the exact commands a fresh clone needs. They are executed on every
pull request by `.github/workflows/verify-contributor-setup.yml`, so if a step
here drifts from `package.json` the workflow fails and points at this section.

```bash
# 1. Install dependencies (uses the committed lockfile)
npm ci

# 2. Create your local environment file from the checked-in example
cp .env.example .env

# 3. Run database migrations
npm run migrate

# 4. Seed development data
npm run seed

# 5. Run the focused test suite
npm test
```

Every script referenced above (`migrate`, `seed`, `test`) must exist in
`package.json`. The verification workflow parses this file and fails with the
section name and the missing script if one is renamed or removed.

## Environment variables

Copy `.env.example` to `.env` and fill in local values. The verification
workflow checks that every variable documented here also appears in
`.env.example`, so add new variables to both places.

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string, e.g. `postgres://user:pass@localhost:5432/lending` |
| `PORT` | no | HTTP port, defaults to `3000` |
| `NODE_ENV` | no | `development`, `test`, or `production` |
| `JWT_SECRET` | yes | Signing key for session tokens; use any local-only value |

Never commit real credentials. The workflow only uses throwaway local values and
performs no external or value-bearing transactions.

## Container workflow

```bash
docker compose up --build
```

This starts PostgreSQL and the API together. Run the migration and seed steps
from inside the API container if you use this path instead of a local database.

## Troubleshooting

**`npm ci` fails with `EUSAGE` or lockfile errors.**
Your `package-lock.json` is out of sync or you are on the wrong Node version.
Run `node --version` and confirm 20.x, then `git checkout package-lock.json` and
retry. Do not run `npm install` to "fix" it — that rewrites the lockfile.

**`npm run migrate` cannot reach the database.**
PostgreSQL is not running or `DATABASE_URL` is wrong. Start it with
`docker compose up -d db`, then verify the host/port in `.env` match the
container. On macOS with Homebrew, `brew services start postgresql@16`.

**`npm run seed` fails with duplicate key errors.**
The database already contains seeded rows. Reset it with
`npm run migrate:reset` (development only) and run `npm run seed` again.

**`npm test` fails on a fresh checkout but passes locally.**
You likely have stale build output or a dirty `.env`. Remove `node_modules` and
`.env`, then repeat the quick start from step 1. Tests must pass without any
network access or external services.

**A documented command no longer exists.**
The verification workflow reports the file, section, and missing script. Update
this README and `package.json` together in the same pull request.

## Financial SLO alert ownership and escalation

Every critical financial SLO alert is registered in
`ops/alerts/financial-slos.yaml` with a stable `alert_id`. Each entry must
declare all of the following; the `npm run ops:alerts:validate` script fails CI
if any field is missing, if an `alert_id` is duplicated, or if an owner or
escalation route is not in the on-call roster.

| Field | Description |
| --- | --- |
| `alert_id` | Stable identifier, e.g. `slo.settlement.lag.p99` |
| `owner` | Owning team from the on-call roster |
| `severity` | `sev1`, `sev2`, or `sev3` |
| `runbook` | Path to the runbook under `ops/runbooks/` |
| `escalation` | Ordered escalation route (primary, secondary, incident commander) |
| `slo` | The SLO expression and threshold the alert fires on |

Supported states for an alert are `firing`, `acknowledged`, `recovering`, and
`resolved`. Transitions are recorded in the `alert_events` table with the
acknowledging actor, so acknowledgement and recovery are auditable. Alerts are
read-only from the API; they are produced by the monitoring pipeline and cannot
be created or mutated by clients.

### Scheduled drill procedure

Run the drill quarterly (and before any major release) with:

```bash
npm run ops:drill -- --alert-id <alert_id> --dry-run   # validate routing only
npm run ops:drill -- --alert-id <alert_id>             # send test notification
npm run ops:drill:report -- --drill-id <drill_id>      # ack/recovery metrics
```

The drill sends a synthetic notification through the real escalation route,
records time-to-acknowledge and time-to-recovery, and writes a report. A drill
that fails to deliver a notification, or that exceeds the acknowledgement
target for the alert's severity, fails the command with a non-zero exit code.
Drills never touch production financial state; the synthetic alert carries a
`drill: true` marker and is excluded from SLO error budgets.

## Incident evidence bundles

`GET /api/ops/incidents/:incidentId/evidence` returns a bounded, redacted
evidence bundle for a financial incident. Bundles are reproducible from the
incident ID alone: the same incident ID yields the same bundle contents for the
same retention window.

The bundle schema (`contracts/ops/evidence-bundle.schema.json`) contains:

| Field | Description |
| --- | --- |
| `incidentId` | Incident identifier the bundle was requested for |
| `generatedAt` | Server timestamp (UTC, ISO 8601) the bundle was assembled |
| `requestRefs` | Bounded list of request IDs (max 200) |
| `traceRefs` | Bounded list of trace IDs (max 200) |
| `checkpointRefs` | Ledger checkpoint references at incident time |
| `stateRefs` | Pointers to authoritative state snapshots (no inline payloads) |
| `redaction` | Redaction profile applied, always `default` unless overridden |

Constraints and failure behavior:

- References are capped at 200 per list; larger incidents return a `413` with
  guidance to narrow the time window rather than a partial bundle.
- Redaction is on by default: PII, tokens, and full request bodies are stripped.
  An unredacted bundle requires the `ops:evidence:raw` scope and is audited.
- Bundles are access-controlled: the caller needs the `ops:evidence:read` scope
  and membership in the incident's owning team. Unauthorized requests return
  `403` without revealing whether the incident exists.
- Bundles are time-limited: links expire after 15 minutes and the stored bundle
  is retained for 30 days, after which the endpoint returns `410 Gone`.
- Unknown or expired incident IDs return `404`/`410` respectively; no partial
  bundle is ever returned.

Migration notes: the `incident_evidence` table and the `ops:evidence:*` scopes
are additive. Existing clients are unaffected; the endpoint is new and gated
behind the scopes above. No stored financial schema changes.

## Clock skew and authoritative timestamps

Each workflow has exactly one authoritative timestamp source. Services must not
derive financial validity from local clocks.

| Workflow | Authoritative timestamp |
| --- | --- |
| Quote validity | `quotes.created_at` (database clock) |
| Nonce / replay window | `nonces.issued_at` (database clock) |
| Authorization expiry | `authorizations.expires_at` (database clock) |
| Settlement | `settlements.settled_at` (ledger clock) |
| Provider callbacks | Provider-signed timestamp, cross-checked against database clock |

Clock drift is measured per service and per provider and exported as the
`slo.clock.drift.seconds` metric. Thresholds:

- Warn at 250 ms drift; page the owning team at 1 s drift.
- A service whose drift exceeds the threshold is marked `degraded` and its
  quote/nonce/authorization writes are rejected with `503` rather than accepted
  with a skewed timestamp.
- Skew must never extend validity: expiry checks use the authoritative
  timestamp, so a fast local clock cannot extend a quote, nonce, or
  authorization. This is covered by `npm run test:clock-skew`.

## Financial workflow coverage map

`quality/coverage-map.yaml` maps each critical journey (borrower, lender,
remittance, settlement, recovery) to the contract, backend, frontend, and e2e
tests that must exist. CI runs:

```bash
npm run quality:coverage:check   # fails if a mapped financial path lost evidence
```

The check fails when a journey listed in the map has no test in a required
layer, or when a changed financial path (matched by the map's path globs) has no
corresponding test change. Add the test and update the map in the same pull
request.

## Reproducible validation evidence

For changes touching any of the above, attach the following to the PR:

```bash
npm run ops:alerts:validate
npm run ops:drill -- --alert-id <alert_id> --dry-run
npm run test:clock-skew
npm run quality:coverage:check
npm test
```

Paste the command output (or the CI job link) into the PR description. The
commands are deterministic and require no network access or external services.
