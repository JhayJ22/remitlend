# Deployed Contract Registry

This is the single source of truth for deployed Soroban contract IDs across all networks.
Update this file whenever a contract is (re-)deployed.

> **Secrets note**: contract IDs are public addresses — safe to commit. Never commit secret/admin keys here.

---

## Testnet (`Test SDF Network ; September 2015`)

RPC: `https://soroban-testnet.stellar.org`  
Explorer: `https://stellar.expert/explorer/testnet`

| Contract | Contract ID | Deploy Date | Version / Commit |
|---|---|---|---|
| `loan_manager` | _not yet recorded_ | — | — |
| `lending_pool` | _not yet recorded_ | — | — |
| `remittance_nft` | _not yet recorded_ | — | — |
| `multisig_governance` | _not yet recorded_ | — | — |
| `token` (USDC-like pool token) | _not yet recorded_ | — | — |

> **How to fill this in**: after running `scripts/deploy.ts`, copy the printed contract IDs into the table above and open a PR. Include the deploy date (YYYY-MM-DD) and the short git commit SHA or release tag.

### Environment variables that consume these IDs

#### Backend (`backend/.env`)

| Contract | Env var |
|---|---|
| `loan_manager` | `LOAN_MANAGER_CONTRACT_ID` |
| `lending_pool` | `LENDING_POOL_CONTRACT_ID` |
| `remittance_nft` | `REMITTANCE_NFT_CONTRACT_ID` |
| `multisig_governance` | `MULTISIG_GOVERNANCE_CONTRACT_ID` |
| `token` | `POOL_TOKEN_ADDRESS` |

#### Frontend (`frontend/.env`)

Most contract addresses are resolved at runtime by the backend API. The loan
wizard is the exception — it reads the lending pool address directly from env:

| Contract | Env var |
|---|---|
| `lending_pool` | `NEXT_PUBLIC_LENDING_POOL_CONTRACT_ID` (canonical; mirrors the backend's `LENDING_POOL_CONTRACT_ID`) |

The legacy name `NEXT_PUBLIC_MANAGER_CONTRACT_ID` is still accepted as a fallback
for existing deployments, but new configs should use the canonical name.

---

## Futurenet

No contracts deployed yet.

---

## Mainnet

No contracts deployed yet.

---

## Updating this file

1. Deploy (or redeploy) via `scripts/deploy.ts`.
2. Copy the contract IDs from the deploy output into the relevant table row.
3. Set the same IDs in your local `backend/.env` (and CI secrets for staging/production).
4. Commit the updated table in the same PR as any contract change.

---

## Contract verification procedure (issue #827)

The backend runs a nightly job (`backend/src/cron/contractVerificationJob.ts`) that verifies the
integrity of every deployed Soroban contract by comparing the deployed WASM hash against the
expected hash recorded in `contracts/wasm-hashes.sha256`.

### How it works

1. **Expected hashes** — `contracts/wasm-hashes.sha256` contains the SHA-256 of each compiled
   WASM artifact (`lending_pool.wasm`, `loan_manager.wasm`, etc.). Regenerate it after any
   intentional contract change:
   ```bash
   bash scripts/verify-wasm-hashes.sh --generate \
     contracts/target/wasm32-unknown-unknown/release
   ```
2. **Deployed hash** — for each contract address configured in `backend/.env`
   (`LOAN_MANAGER_CONTRACT_ID`, `LENDING_POOL_CONTRACT_ID`, `REMITTANCE_NFT_CONTRACT_ID`,
   `MULTISIG_GOVERNANCE_CONTRACT_ID`, `POOL_TOKEN_ADDRESS`), the job reads the deployed contract
   data via the Soroban `getContractData` RPC and computes its SHA-256 hash.
3. **Comparison** — if the deployed hash does not match the expected hash, the job:
   - writes the discrepancy to the `contract_verification` and
     `contract_verification_attempts` tables,
   - fires a `CRITICAL` alert so on-call can investigate a possible contract replacement.
4. **Querying results** — the last verification result per contract is available at:
   ```http
   GET /admin/contract-verification
   Authorization: Bearer <admin token>
   ```
5. **Schedule** — the job runs nightly at 02:00 server time (cron `0 2 * * *`).

### Contract addresses consumed by the backend

| Contract | Env var |
|---|---|
| `loan_manager` | `LOAN_MANAGER_CONTRACT_ID` |
| `lending_pool` | `LENDING_POOL_CONTRACT_ID` |
| `remittance_nft` | `REMITTANCE_NFT_CONTRACT_ID` |
| `multisig_governance` | `MULTISIG_GOVERNANCE_CONTRACT_ID` |
| `token` (USDC-like pool token) | `POOL_TOKEN_ADDRESS` |

Set these IDs (copied from the deploy output) in your local `backend/.env` and in CI secrets for
staging/production so the verification job can reach each deployed contract.
