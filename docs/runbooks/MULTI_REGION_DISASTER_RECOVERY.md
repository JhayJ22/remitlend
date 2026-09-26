# Multi-Region Disaster Recovery — Stateful Services (#411)

## Overview

This runbook defines the disaster-recovery (DR) strategy for RemitLend's
stateful services: **PostgreSQL** (primary application database),
**Redis** (cache / session store), and **on-chain Soroban contracts**
(Stellar testnet / mainnet).

| Service | RPO | RTO | Replication mechanism |
|---------|-----|-----|-----------------------|
| PostgreSQL | ≤ 5 min | 15–30 min | WAL streaming replica + S3 logical backups |
| Redis | ≤ 60 s | < 5 min | Redis Sentinel failover or Redis Cluster |
| Soroban contracts | N/A (chain is the source of truth) | < 1 min | Re-point RPC URL; contracts live on Stellar |
| Application tier (backend + frontend) | Stateless | < 5 min | Container re-deploy from GHCR |

---

## Architecture

```
Primary region (e.g. us-east-1)
├── PostgreSQL primary          ──WAL──► PostgreSQL hot-standby (e.g. eu-west-1)
├── Redis primary               ──sync──► Redis replica
├── S3 (logical backups)        ──cross-region replication──► S3 replica bucket
└── GHCR container images       (globally available)

Secondary region (e.g. eu-west-1)
├── PostgreSQL hot-standby      (read-only until promotion)
├── Redis replica
└── Application containers      (pre-warmed or on-demand)
```

### Threat model

| Threat | Mitigation |
|--------|-----------|
| Single-AZ failure | Hot-standby in a second AZ/region auto-promotes via pgBouncer health check |
| Full-region failure | Manual failover to secondary region (≤ 30 min RTO) |
| Data corruption / accidental delete | S3 logical backups retained 30 days; WAL enables PITR |
| Malicious WASM deployment | WASM hash verification (see `contracts/wasm-hashes.sha256`) |
| Secrets exposure during DR | Use secrets manager; never commit credentials |

---

## Prerequisites

### Environment variables (all regions)

See `docs/ENVIRONMENT.md` for the full reference.  The following are
specifically required for DR operations:

```env
# Backup bucket — replicate across regions via S3 cross-region replication
BACKUP_S3_BUCKET=remitlend-backups
BACKUP_S3_REGION=us-east-1
BACKUP_RETENTION_DAYS=30

# Secondary region read-replica endpoint
DATABASE_REPLICA_URL=postgres://user:pass@replica.internal.example.com:5432/remitlend

# Streaming replication credentials (set on the primary)
REPLICATION_USER=replicator
REPLICATION_PASSWORD=<strong-password>
```

### IAM permissions

The DR runner (CI/CD role or operator) needs:

```json
{
  "Effect": "Allow",
  "Action": [
    "s3:GetObject", "s3:PutObject", "s3:ListBucket",
    "rds:FailoverDBCluster",           // if using RDS
    "elasticache:RebootCacheCluster"   // if using ElastiCache
  ],
  "Resource": [
    "arn:aws:s3:::remitlend-backups",
    "arn:aws:s3:::remitlend-backups/*"
  ]
}
```

---

## Runbook 1 — Planned failover (maintenance window)

Use this procedure for scheduled maintenance, region migration, or DR drills.

### Step 1 — Pre-flight checks

```bash
# 1a. Verify replica lag is within RPO
psql "$DATABASE_REPLICA_URL" -c "
  SELECT now() - pg_last_xact_replay_timestamp() AS replica_lag;"

# Expected: lag < 5 minutes. Abort if lag > 10 minutes.

# 1b. Confirm latest backup exists and is verified
aws s3 ls s3://remitlend-backups/ | tail -5

# 1c. Verify Redis replica is in sync
redis-cli -h $REDIS_REPLICA_HOST info replication | grep master_last_io_seconds_ago
# Expected: < 60
```

### Step 2 — Stop writes to primary

```bash
# Option A: Put application in maintenance mode (returns HTTP 503)
curl -X POST https://api.remitlend.com/admin/maintenance \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"enabled": true, "reason": "Planned failover"}'

# Option B: Scale backend replicas to 0
# (Kubernetes / ECS / Docker Swarm — adapt to your orchestrator)
```

### Step 3 — Promote PostgreSQL replica

```bash
# If using PostgreSQL streaming replication directly:
ssh replica.internal.example.com \
  "sudo -u postgres pg_ctl promote -D /var/lib/postgresql/data"

# If using pg_autoctl / Patroni:
pg_autoctl perform failover --pgdata /var/lib/postgresql/data

# Confirm promotion
psql "$DATABASE_REPLICA_URL" -c "SELECT pg_is_in_recovery();"
# Expected: f (false)
```

### Step 4 — Update application config

Update `DATABASE_URL` in the deployment environment (secrets manager / CI
variable) to point to the newly promoted primary:

```bash
# Example using AWS Parameter Store
aws ssm put-parameter \
  --name /remitlend/production/DATABASE_URL \
  --value "postgres://user:pass@new-primary.internal.example.com:5432/remitlend" \
  --type SecureString --overwrite
```

### Step 5 — Promote Redis replica (if needed)

```bash
redis-cli -h $REDIS_REPLICA_HOST REPLICAOF NO ONE
```

### Step 6 — Re-deploy application containers

```bash
# Pull latest image from GHCR and restart
docker pull ghcr.io/<owner>/remitlend-backend:production-latest
docker-compose -f docker-compose.production.yml up -d --remove-orphans
```

### Step 7 — Health checks

```bash
curl https://api.remitlend.com/health
# Expected: {"status":"ok"}

curl https://api.remitlend.com/health/deep
# Expected: all components healthy, indexer lag within limits
```

### Step 8 — Disable maintenance mode

```bash
curl -X POST https://api.remitlend.com/admin/maintenance \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"enabled": false}'
```

### Step 9 — Reconfigure old primary as new replica

Once the old primary is healthy, configure it as a streaming replica of the new
primary to restore HA posture:

```bash
# On the old primary (now offline)
# Edit postgresql.conf to add:
#   primary_conninfo = 'host=new-primary.internal.example.com port=5432 user=replicator'
# Create standby.signal file:
touch /var/lib/postgresql/data/standby.signal
pg_ctl start -D /var/lib/postgresql/data
```

---

## Runbook 2 — Unplanned failover (emergency)

Use this procedure when the primary region is unavailable without warning.

### Step 1 — Confirm outage scope

```bash
# Check primary health endpoints
curl --max-time 5 https://api.remitlend.com/health || echo "PRIMARY UNREACHABLE"

# Check PostgreSQL primary
pg_isready -h primary.internal.example.com -p 5432 || echo "DB PRIMARY DOWN"
```

### Step 2 — Assess replica lag at time of outage

```bash
# On the replica
psql "$DATABASE_REPLICA_URL" -c "
  SELECT
    now() - pg_last_xact_replay_timestamp() AS replay_lag,
    pg_last_wal_receive_lsn() AS received_lsn,
    pg_last_wal_replay_lsn() AS replayed_lsn;"
```

Note: data written to the primary after the last replicated LSN will be lost
(this defines the actual RPO for this incident).

### Step 3 — Promote replica immediately

```bash
sudo -u postgres pg_ctl promote -D /var/lib/postgresql/data
# Or if using pgBouncer/HA proxy: update the load-balancer target
```

### Step 4 — Update DATABASE_URL and re-deploy

Same as planned failover Steps 4–6 above.

### Step 5 — Post-incident reconciliation

After service is restored:

1. Run the score reconciliation job to detect any on-chain / off-chain drift:

```bash
curl -X POST https://api.remitlend.com/admin/reconcile/scores \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

2. Review the indexer lag metric; replay any missed ledgers:

```bash
# Check indexer state
psql "$DATABASE_URL" -c "SELECT * FROM indexer_state ORDER BY updated_at DESC LIMIT 5;"
```

3. Validate loan event table consistency:

```bash
psql "$DATABASE_URL" -c "
  SELECT COUNT(*) FROM loan_events WHERE created_at >= now() - interval '2 hours';"
```

4. File an incident report documenting the actual RPO and RTO achieved.

---

## Runbook 3 — Point-in-time recovery (data corruption)

See [DATABASE_BACKUP_RECOVERY.md](DATABASE_BACKUP_RECOVERY.md) for the full
PITR procedure.  In addition to that runbook:

1. Before restoring, take a snapshot of the corrupted state for forensics:

```bash
pg_dump "$DATABASE_URL" | gzip > /tmp/corrupted-state-$(date +%s).sql.gz
```

2. After restore, run the contract-verification job to confirm on-chain state
   matches the database:

```bash
curl -X POST https://api.remitlend.com/admin/verify-contracts \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## Runbook 4 — Stellar / Soroban contract recovery

Soroban contracts are immutable once deployed; the chain is the authoritative
source of truth. Recovery is about re-pointing the backend, not the contract.

### RPC endpoint failure

Update `STELLAR_RPC_URL` to a failover endpoint:

| Network | Primary | Failover |
|---------|---------|---------|
| Testnet | `https://soroban-testnet.stellar.org` | `https://rpc-futurenet.stellar.org` (experimental) |
| Mainnet | `https://soroban.stellar.org` | Run your own Soroban RPC node |

```bash
aws ssm put-parameter \
  --name /remitlend/production/STELLAR_RPC_URL \
  --value "https://failover-rpc.example.com" \
  --type SecureString --overwrite
# Then redeploy backend containers
```

### Contract upgrade emergency

If a critical bug is found in a deployed contract:

1. Invoke the multisig governance contract to pause affected contracts.
2. Follow [contracts/UPGRADE_PROCESS.md](../../contracts/UPGRADE_PROCESS.md).
3. Update `LOAN_MANAGER_CONTRACT_ID` / `LENDING_POOL_CONTRACT_ID` /
   `REMITTANCE_NFT_CONTRACT_ID` in the deployment environment.
4. Redeploy backend and verify via `/admin/verify-contracts`.

---

## Observability and alerting

The following metrics should trigger PagerDuty / alerting:

| Alert | Threshold | Runbook |
|-------|-----------|---------|
| Replica lag | > 5 min | This runbook §1 |
| Backup age | > 25 h | DATABASE_BACKUP_RECOVERY.md |
| Indexer lag | > `INDEXER_HEALTH_LAG_LIMIT` ledgers | indexer-recovery.md |
| Backend health check | HTTP ≠ 200 for 3 consecutive checks | graceful-shutdown.md |
| Redis memory | > 90% `maxmemory` | Redis docs |

Metrics are exposed at `GET /metrics` (Prometheus format, internal only).

---

## DR drill schedule

| Frequency | Drill type |
|-----------|-----------|
| Monthly | Restore from latest S3 backup to staging database |
| Quarterly | Full planned failover to secondary region (staging) |
| Annually | Full unplanned failover simulation |

Record drill results in `docs/runbooks/dr-drill-log.md` (create the file on
the first drill).

---

## Rollback

To reverse a failover and return to the original primary region:

1. Repeat the planned failover procedure, swapping "primary" and "secondary".
2. Verify replica lag on the original primary (now replica) is within RPO
   before cutting traffic back.

---

## Compatibility impact

- No schema or API changes.
- All environment variable additions are optional with documented defaults.
- Backward-compatible: existing single-region deployments continue to function
  without change.

## Rollout steps

1. Provision streaming replica in secondary region.
2. Enable cross-region S3 replication for backup bucket.
3. Configure monitoring thresholds listed above.
4. Run first monthly backup-restore drill and record results.

## Verification evidence

- Monthly drill results committed to `docs/runbooks/dr-drill-log.md`.
- CI validates WASM hashes on every push (`contracts/wasm-hashes.sha256`).
- `/health/deep` endpoint reports replica lag and indexer health.
