# Contributor Wiki (In-Repo)

This folder is a GitHub Wiki-style set of documents that live in the repo so they can be reviewed via PRs.

## Contents

- [Soroban Contract State Machine](./contract-state-machine.md)
- [Indexer ↔ Database Sync Flow](./indexer-sync-flow.md)
- [Frontend "Standard Library" Patterns](./frontend-patterns.md)
- [JWT Revocation & Role-Change Propagation](./jwt-revocation.md)
- [Security Scanning](./security-scanning.md)
- [API Idempotency](./api-idempotency.md)
- [Webhook Signatures](./webhook-signatures.md)

## Reference Docs

- [Data Lineage — Score Inputs](../data-lineage.md) — Authoritative mapping of every source that feeds the credit score, the transformation pipeline, and staleness behaviour.
- [Webhook Consumer Certification](../webhook-consumer-certification.md) — Connectivity, security, reliability, and observability requirements for webhook endpoints before they go to production.
- [Production Readiness Rubric](../production-readiness-rubric.md) — Thirteen-dimension scored checklist for assessing whether a new integration is production-ready.
- [Contributor Troubleshooting Decision Tree](../contributor-troubleshooting.md) — Step-by-step branches for diagnosing local setup, test, database, contract, score, webhook, and CI failures.

## Runbooks

- [Troubleshooting Guide](../runbooks/troubleshooting.md) — Comprehensive troubleshooting for development and production issues.
- [Indexer Recovery](../runbooks/indexer-recovery.md) — Responding to indexer lag, RPC outages, and quarantined events.

