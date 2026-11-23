# Statement manifest verification

Issue #855 adds a tamper-evident seal to downloadable CSV statements from the
wallet, activity, and loan-details screens. The signing service uses a managed
Ed25519 key that never leaves the backend; only the public key is published.

## What is downloaded

Each export produces two files:

1. `<name>.csv` — the original statement, byte-for-byte as generated in the browser.
2. `<name>.csv.manifest.json` — a signed manifest describing the exact CSV bytes.

The manifest schema is `statement-manifest/v1`:

```json
{
  "schema": "statement-manifest/v1",
  "manifestId": "sha256 of the unsigned manifest payload",
  "source": {
    "type": "activity",
    "checkpoint": "api:3:2026-06-15T11:59:00.000Z"
  },
  "statement": {
    "sha256": "<sha256 hex of the CSV bytes>",
    "rowCount": 3,
    "generatedAt": "2026-06-15T12:00:00.000Z"
  },
  "subjectHash": "<daily salted sha256 of the authenticated wallet>",
  "issuedAt": "2026-06-15T12:00:01.000Z",
  "verification": {
    "algorithm": "Ed25519",
    "keyId": "statement-signing-default",
    "instructions": "/docs/STATEMENT_VERIFICATION.md"
  },
  "signature": "<base64 Ed25519 signature>"
}
```

### Field constraints

| Field                   | Constraint                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `schema`                | Fixed `statement-manifest/v1`; unknown versions must be rejected by verifiers.                                            |
| `source.type`           | One of `activity`, `wallet_payments`, `loan_events`.                                                                      |
| `source.checkpoint`     | 1–256 chars, limited to `A-Z a-z 0-9 : . _ @ / -`. It identifies the API/Horizon projection snapshot used at export time. |
| `statement.sha256`      | Lowercase 64-char hex SHA-256 of the CSV bytes.                                                                           |
| `statement.rowCount`    | Integer 0–100000.                                                                                                         |
| `statement.generatedAt` | ISO-8601 timestamp within 5 minutes of server time (max 60s future skew).                                                 |
| `subjectHash`           | Daily rotating salted hash; no raw wallet address is stored in the manifest.                                              |
| `verification.keyId`    | Identifies the signing key; rotate with `STATEMENT_SIGNING_KEY_ID`.                                                       |

## States and failure behavior

| State                      | Trigger                                                                   | Result                                                                           |
| -------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `issued`                   | Authenticated request with valid input, key configured, registry writable | `201` with signed manifest; CSV and manifest are downloaded.                     |
| `replayed`                 | Same request retried within the freshness window                          | The stored manifest is returned unchanged; no duplicate issuance row is created. |
| `rejected_invalid`         | Malformed digest, checkpoint, source type, row count, or timestamp        | `400`; no signature is produced.                                                 |
| `rejected_stale`           | `generatedAt` older than 5 minutes or more than 60s in the future         | `400`; no signature is produced.                                                 |
| `rejected_unauthenticated` | Missing/invalid JWT                                                       | `401`.                                                                           |
| `unavailable`              | Signing key missing/invalid or issuance registry unavailable              | `503`; the UI shows an error and does not present a partial export as verified.  |

The signing path performs no balance, loan, score, or settlement writes, so a
failed or stale request has no partial financial side effects.

## Verification instructions

Fetch the public key:

```bash
curl -s https://<api-host>/api/v1/statements/verification-key \
  | jq -r '.data.publicKeyPem' > statement-public-key.pem
```

Verify with Node.js (no private material involved):

```bash
node --input-type=module - <<'NODE'
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const csv = readFileSync('remitlend-activity-2026-06-15.csv');
const manifest = JSON.parse(readFileSync('remitlend-activity-2026-06-15.csv.manifest.json', 'utf8'));
const publicKeyPem = readFileSync('statement-public-key.pem', 'utf8');

const digestMatches =
  createHash('sha256').update(csv).digest('hex') === manifest.statement.sha256;

const { signature, ...signedPayload } = manifest;
const signatureValid = verify(
  null,
  Buffer.from(JSON.stringify(signedPayload)),
  createPublicKey(publicKeyPem),
  Buffer.from(signature, 'base64'),
);

console.log({ schema: manifest.schema, digestMatches, signatureValid });
if (manifest.schema !== 'statement-manifest/v1' || !digestMatches || !signatureValid) {
  process.exit(1);
}
NODE
```

Canonicalization is `JSON.stringify` of the manifest with `signature` removed,
in the field order shown above. A change to any signed field, the CSV bytes, or
the byte order invalidates the signature.

## Key management and rotation

Generate a managed key outside the repository:

```bash
openssl genpkey -algorithm ED25519 -out statement-signing-key.pem
chmod 600 statement-signing-key.pem
```

Inject it as `STATEMENT_SIGNING_PRIVATE_KEY_PEM` (PEM contents) with a stable
`STATEMENT_SIGNING_KEY_ID`. In production, a missing or invalid key disables
issuance and verification-key publication with `503`; a non-production process
uses an ephemeral key for local development only. The private key, seed, and
`STATEMENT_SUBJECT_PEPPER` are never returned by any endpoint or written to the
manifest or issuance table.

To rotate: deploy a new key with a new `STATEMENT_SIGNING_KEY_ID` and keep the
old public key available to verifiers until all outstanding manifests expire.
Old manifests remain valid with their original key ID.

## Compatibility and migration

- Additive migration `backend/migrations/1812000000000_statement-manifest-issuances.js`
  creates `statement_manifest_issuances`; it does not alter financial tables.
- The table stores the signed manifest text, key ID, source type, schema version,
  subject hash, row count, and issue timestamp. No private signing material, CSV
  contents, wallet address, or amount is persisted.
- Existing unsigned CSV exports remain readable; only new exports gain a
  sibling manifest. Clients that ignore the manifest are unaffected.
- The legacy `/api/statements/*` alias is mounted for compatibility with the
  existing `/api/*` surface and carries the standard deprecation headers.

## Explicit assumptions

- The signature proves that RemitLend's signing service sealed the exact CSV
  bytes at `issuedAt`. It does not independently re-query Stellar or the API at
  verification time.
- `source.checkpoint` identifies the projection snapshot used by the browser;
  the Stellar ledger remains the ultimate authority for money and settlement.
- Amounts are exported exactly as returned by the source API; the signing
  service performs no conversion, rounding, or mutation.
- Verifiers must trust the published public key endpoint over HTTPS and reject
  unknown schema versions or key IDs they do not recognize.
