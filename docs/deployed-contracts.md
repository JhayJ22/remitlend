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

## Nightly WASM integrity verification

The backend nightly job verifies every contract ID listed in the active network
section above. It reads the expected SHA-256 digest from
[`contracts/wasm-hashes.sha256`](../contracts/wasm-hashes.sha256), retrieves the
contract instance and its WASM bytes through the configured Soroban RPC, and
compares the deployed bytes with the manifest digest. A missing digest or a
mismatch is persisted as a critical discrepancy and emitted to log-based
alerting; RPC failures are recorded separately and retried on the next run.

For each deployed contract:

1. Add a manifest entry for its compiled WASM artifact, using the contract name
   from the registry as the artifact basename (for example
   `loan_manager.wasm`).
2. Record the deployed contract ID in the network's table above.
3. Configure the matching backend contract ID and `STELLAR_NETWORK`.
4. Apply the backend database migrations. The verifier records append-only
   results in `contract_verifications`.
5. Confirm the latest result at the admin-only
   `GET /api/v1/admin/contract-verification` endpoint. A mismatch or missing
   manifest hash must be investigated before the deployment is considered
   healthy.

The endpoint requires a JWT session with the `admin` role. Verification is
read-only and never changes contract state or financial records.
