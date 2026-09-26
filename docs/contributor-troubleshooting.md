# Contributor Troubleshooting Decision Tree

Use this guide when you are stuck during local development, running tests, or
submitting a PR. Follow each decision node in order — most issues resolve at
the first matching branch.

For production incidents see the [Ops Troubleshooting Runbook](runbooks/troubleshooting.md).
For indexer-specific issues see [Indexer Recovery](runbooks/indexer-recovery.md).

---

## Table of Contents

- [Start Here — Quick Triage](#start-here--quick-triage)
- [Branch A — Services Won't Start](#branch-a--services-wont-start)
- [Branch B — Tests Failing](#branch-b--tests-failing)
- [Branch C — TypeScript / Lint Errors](#branch-c--typescript--lint-errors)
- [Branch D — Database / Migration Issues](#branch-d--database--migration-issues)
- [Branch E — Smart Contract Issues](#branch-e--smart-contract-issues)
- [Branch F — Frontend Not Loading](#branch-f--frontend-not-loading)
- [Branch G — Scores Not Updating](#branch-g--scores-not-updating)
- [Branch H — Webhooks Not Delivering](#branch-h--webhooks-not-delivering)
- [Branch I — PR / CI Failing](#branch-i--pr--ci-failing)
- [Common Commands Reference](#common-commands-reference)
- [Getting More Help](#getting-more-help)

---

## Start Here — Quick Triage

```
Is the problem in …?

┌─────────────────────────────────────┐
│  Services won't start or crash      │──► Branch A
├─────────────────────────────────────┤
│  Tests failing                      │──► Branch B
├─────────────────────────────────────┤
│  TypeScript / lint errors           │──► Branch C
├─────────────────────────────────────┤
│  Database / migration error         │──► Branch D
├─────────────────────────────────────┤
│  Smart contract build or test fail  │──► Branch E
├─────────────────────────────────────┤
│  Frontend won't load or shows blank │──► Branch F
├─────────────────────────────────────┤
│  Credit score stuck / wrong value   │──► Branch G
├─────────────────────────────────────┤
│  Webhook not delivered to endpoint  │──► Branch H
├─────────────────────────────────────┤
│  CI check failing on my PR          │──► Branch I
└─────────────────────────────────────┘
```

---

## Branch A — Services Won't Start

```
docker compose up --build fails or a container exits immediately
│
├─ Is the error "address already in use" or "port conflict"?
│   YES ──► Kill the conflicting process:
│              lsof -i :3000   (frontend)
│              lsof -i :3001   (backend)
│              lsof -i :5432   (postgres)
│              lsof -i :6379   (redis)
│           Or change the PORT in backend/.env.
│
├─ Is the error about Docker memory or OOM?
│   YES ──► Increase Docker Desktop memory to 4 GB+.
│
├─ Is the backend container exiting with "connection refused" to Postgres?
│   YES ──► Postgres healthcheck hasn't passed yet. Wait 30 s and re-run.
│           Or run:  docker compose up db -d && sleep 10 && docker compose up
│
├─ Is there a volume permission error?
│   YES ──► sudo chown -R $USER:$USER .
│           docker compose down -v
│           docker compose up --build
│
├─ Is Node.js version wrong?
│   YES ──► nvm use   (reads .nvmrc which pins the required version)
│           Or install the pinned version:  nvm install
│
└─ Still failing? ──► docker compose logs backend | tail -50
                      Check for a missing env var in backend/.env.
                      Compare with backend/.env.example.
```

---

## Branch B — Tests Failing

```
npm test (backend) or cargo test (contracts) fails
│
├─ Is the error "Cannot connect to database"?
│   YES ──► Tests need a running Postgres. Two options:
│           (a) docker compose up db -d   then re-run tests, OR
│           (b) Use the in-memory test DB:
│               cp backend/.env.test backend/.env  (uses SQLite shim)
│
├─ Is the error "Table does not exist"?
│   YES ──► Run migrations for the test database:
│               NODE_ENV=test npm run migrate:up  (from backend/)
│
├─ Is there a snapshot mismatch in contracts?
│   YES ──► Review the diff carefully. If the change is intentional:
│               UPDATE_SNAPSHOTS=true cargo test
│           If unexpected, investigate the contract logic change.
│
├─ Is a Jest test timing out?
│   YES ──► Look for a missing mock or an awaited Promise that never resolves.
│           Add --testTimeout=30000 to debug:
│               npx jest --testTimeout=30000 <test-file>
│
├─ Is the error about a missing service (Redis, external API)?
│   YES ──► Check that your test uses the mock provided in
│           backend/src/__tests__/ or adds vi.mock(). Live service calls
│           are not expected in unit tests.
│
└─ Are only integration tests failing?
    YES ──► Integration tests require all services running:
                docker compose up --build
            Then from backend/:  npm run test:integration
```

---

## Branch C — TypeScript / Lint Errors

```
npm run build or npm run lint reports errors
│
├─ Is the error "Cannot find module '…'"?
│   YES ──► Run npm install in the relevant package directory.
│           If that doesn't help, delete node_modules and reinstall:
│               rm -rf node_modules && npm install
│
├─ Is the error about a missing type declaration (@types/…)?
│   YES ──► npm install --save-dev @types/<package>
│           Pin to an exact version matching the runtime package.
│
├─ Is the error "Type 'X' is not assignable to type 'Y'" in generated code?
│   YES ──► Re-generate API types:
│               cd scripts && npm run generate-api-types
│           Commit the updated generated file.
│
├─ Is ESLint reporting "Unexpected any" or "no-explicit-any"?
│   YES ──► Replace `any` with the correct type. Avoid `@ts-ignore`.
│           If the type is genuinely unknown use `unknown` and narrow it.
│
├─ Is Prettier reporting formatting errors?
│   YES ──► Auto-fix:  npm run format  (from the relevant package directory)
│
└─ Is the error only in a test file?
    YES ──► Check that the test imports are from the correct path.
            Test files live in __tests__/ or alongside the source file
            with a .test.ts suffix.
```

---

## Branch D — Database / Migration Issues

```
Migration fails or the database schema is unexpected
│
├─ Is the error "migration already applied"?
│   YES ──► The migration ran previously. Check the current state:
│               SELECT * FROM pgmigrations ORDER BY run_on DESC LIMIT 10;
│           If you are re-running a modified migration in development:
│               npm run migrate:down  (from backend/)
│               npm run migrate:up
│
├─ Is the error "column does not exist"?
│   YES ──► The ensure-core-tables migration (1789000000000) renames
│           user_id → borrower and current_score → score.
│           Confirm all migrations have run:
│               npm run migrate:up
│           Check the DATABASE.md column name notes for the table in question.
│
├─ Is there a duplicate key error on contract_events.event_id?
│   YES ──► A duplicate Soroban event was indexed. This is expected and safe.
│           The ON CONFLICT DO NOTHING clause handles this gracefully.
│           No action needed unless the indexer is re-processing old blocks.
│
├─ Did you add a new migration file?
│   YES ──► Follow the naming convention:
│               <unix-timestamp>_<short-description>.js
│           Include both `up` and `down` exports.
│           Test the down migration on a copy of the DB before opening a PR.
│
└─ Is the database completely broken?
    YES ──► Nuclear reset (development only — destroys all local data):
                docker compose down -v
                docker compose up --build
            This drops the volume and re-runs all migrations from scratch.
```

---

## Branch E — Smart Contract Issues

```
cargo build or cargo test fails in contracts/
│
├─ Is the error "error[E0463]: can't find crate for …"?
│   YES ──► Add the wasm32 target:
│               rustup target add wasm32-unknown-unknown
│
├─ Is the error about the wrong Rust toolchain version?
│   YES ──► The toolchain is pinned in contracts/rust-toolchain.toml.
│               rustup show   to confirm the active toolchain.
│               rustup update to pull the pinned version.
│
├─ Is a test snapshot out of date?
│   YES ──► Re-generate snapshots (after verifying the change is correct):
│               UPDATE_SNAPSHOTS=true cargo test
│
├─ Is the WASM binary over the size budget?
│   YES ──► Run the size check:
│               bash scripts/check-wasm-size-regression.sh
│           Optimise with:
│               bash scripts/optimize-wasm-sizes.sh
│           See contracts/CI_SIZE_OPTIMIZATION.md for guidance.
│
└─ Is the fuzz test crashing with a new input?
    YES ──► Save the crashing input from contracts/fuzz/artifacts/
            and open an issue referencing contracts/FUZZING_README.md.
```

---

## Branch F — Frontend Not Loading

```
Browser shows a blank page, 500, or compile error
│
├─ Is the error in the browser console about a missing environment variable?
│   YES ──► Check frontend/.env.example and create frontend/.env.local
│           with the required NEXT_PUBLIC_* variables.
│
├─ Is Next.js reporting a module not found error?
│   YES ──► rm -rf frontend/.next && npm run dev  (clears the build cache)
│
├─ Is there a hydration mismatch warning?
│   YES ──► The server and client rendered different HTML.
│           Common cause: a Date.now() or Math.random() call outside
│           useEffect. Move non-deterministic code into a useEffect hook.
│
├─ Is the wallet connection failing (Freighter not found)?
│   YES ──► Install the Freighter browser extension and ensure it is
│           connected to Testnet. The app does not support Mainnet in
│           local development.
│
├─ Is an API call returning CORS errors?
│   YES ──► Confirm CORS_ALLOWED_ORIGINS in backend/.env includes
│           http://localhost:3000.
│
└─ Is a Storybook story failing?
    YES ──► npm run storybook  (from frontend/) and check the story's
            args match the current component props.
```

---

## Branch G — Scores Not Updating

```
GET /api/scores/:userId returns a stale or unexpected score
│
├─ Is Redis running?
│   YES ──► redis-cli ping  →  PONG
│   NO  ──► docker compose up redis -d
│
├─ Is the score cached from a stale value?
│   YES ──► Bust the cache manually:
│               redis-cli DEL "score:userId:<userId>"
│               redis-cli DEL "score:breakdown:<userId>"
│
├─ Are contract events being indexed?
│   YES ──► Check the indexer log:
│               docker compose logs backend | grep eventIndexer
│           Look for "indexed new events" messages. If absent, the indexer
│           may be lagging or the RPC endpoint is unreachable.
│
├─ Are the relevant events in the database?
│   YES ──► SELECT * FROM contract_events
│           WHERE address = '<userId>'
│           AND event_type IN ('LoanRepaid', 'LoanDefaulted')
│           ORDER BY ledger DESC LIMIT 10;
│
├─ Is the score calculation returning prior-only (500)?
│   YES ──► No LoanRepaid or LoanDefaulted events exist for this user.
│           This is correct initial behaviour — the score starts at the
│           prior mean of 500.
│
└─ Do you need to force a reconciliation?
    YES ──► POST /api/scores/reconcile  (requires admin JWT)
            Or trigger scoreReconciliationService directly in a REPL:
                node -e "require('./dist/services/scoreReconciliationService').runReconciliation()"
```

---

## Branch H — Webhooks Not Delivering

```
Subscribed endpoint is not receiving events
│
├─ Is the subscription active?
│   YES ──► GET /api/webhooks/subscriptions  →  check "active": true
│
├─ Is the endpoint URL reachable from inside Docker?
│   YES ──► curl from inside the backend container:
│               docker compose exec backend curl -X POST <your-url> \
│                 -H "Content-Type: application/json" \
│                 -d '{"test":true}'
│           If unreachable, use host.docker.internal instead of localhost.
│
├─ Are deliveries being attempted but failing?
│   YES ──► SELECT * FROM webhook_deliveries
│           WHERE subscription_id = '<sub_id>'
│           ORDER BY created_at DESC LIMIT 10;
│           Check "status" and "response_status" columns.
│
├─ Is the endpoint returning a non-2xx status?
│   YES ──► RemitLend retries on 4xx and 5xx. Check your endpoint logs.
│           A 401 means signature verification is failing — see
│           docs/wiki/webhook-signatures.md.
│
├─ Has the circuit breaker tripped?
│   YES ──► After N consecutive failures the subscription is paused.
│           Re-enable via:  PATCH /api/webhooks/subscriptions/<id>
│           with  { "active": true }
│
└─ Is this a local dev environment?
    YES ──► Use a tunnel tool (e.g. ngrok) to expose your local endpoint:
                ngrok http 8080
            Use the generated HTTPS URL as the subscription URL.
```

---

## Branch I — PR / CI Failing

```
GitHub Actions CI is red on my PR
│
├─ Is it a lint or type-check failure?
│   YES ──► Run locally: npm run lint && npm run build  (in backend/ and frontend/)
│           Fix all errors before pushing.
│
├─ Is it a test failure?
│   YES ──► Run: npm test  (backend) or cargo test  (contracts)
│           Match the failing test name from the CI output.
│
├─ Is it the contract drift check?
│   YES ──► Your API response shape may have diverged from the contract.
│           Run: cd scripts && npm run check:drift
│           See docs/API_CONTRACT_DRIFT_PREVENTION.md for guidance.
│
├─ Is it the WASM size regression check?
│   YES ──► bash scripts/check-wasm-size-regression.sh
│           Optimise or update the size budget in contracts/size-budgets.json
│           if the change is intentional.
│
├─ Is it a Dependabot security alert?
│   YES ──► Run: npm audit fix  (in the relevant package directory)
│           If the fix is a breaking version bump, open a separate PR.
│
├─ Is it the env-docs check?
│   YES ──► A new environment variable was added without a docs/ENVIRONMENT.md
│           entry. Add the variable to the relevant section.
│
└─ Is the CI runner timing out?
    YES ──► Check the GitHub Actions run log for which step timed out.
            Flaky integration tests can be re-run from the GitHub UI.
            If consistently slow, file an issue to investigate the root cause.
```

---

## Common Commands Reference

| Task | Command |
|------|---------|
| Start all services | `docker compose up --build` |
| Start only the database | `docker compose up db -d` |
| Apply migrations | `cd backend && npm run migrate:up` |
| Roll back one migration | `cd backend && npm run migrate:down` |
| Run backend tests | `cd backend && npm test` |
| Run backend tests (watch) | `cd backend && npm run test -- --watch` |
| Lint backend | `cd backend && npm run lint` |
| Format backend | `cd backend && npm run format` |
| Build backend | `cd backend && npm run build` |
| Run frontend tests | `cd frontend && npm test` |
| Build frontend | `cd frontend && npm run build` |
| Run contract tests | `cd contracts && cargo test` |
| Build contracts (WASM) | `cd contracts && cargo build --target wasm32-unknown-unknown --release` |
| Check WASM sizes | `bash scripts/check-wasm-size-regression.sh` |
| Optimise WASM | `bash scripts/optimize-wasm-sizes.sh` |
| Generate API types | `cd scripts && npm run generate-api-types` |
| Bust score cache | `redis-cli DEL "score:userId:<id>"` |
| View backend logs | `docker compose logs -f backend` |
| Reset everything (⚠ destructive) | `docker compose down -v && docker compose up --build` |

---

## Getting More Help

1. Search [existing issues](https://github.com/JhayJ22/remitlend/issues) — your
   problem may already be tracked.
2. Check the [Ops Troubleshooting Runbook](runbooks/troubleshooting.md) for
   more detailed step-by-step guides.
3. Read the relevant service README:
   - Backend: [`backend/README.md`](../backend/README.md)
   - Frontend: [`frontend/README.md`](../frontend/README.md)
   - Contracts: [`contracts/README.md`](../contracts/README.md)
4. Open a new issue using the **Bug Report** template and include:
   - The command you ran and its full output.
   - Your OS and Node.js / Rust version.
   - Whether the issue is reproducible from a clean clone.
5. Tag `@JhayJ22` or another maintainer if the issue is blocking a PR.
