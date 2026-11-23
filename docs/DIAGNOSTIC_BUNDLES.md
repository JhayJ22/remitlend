# Diagnostic Bundles

This guide explains how to request, inspect, and safely delete a privacy-safe diagnostic bundle for a transaction incident. Diagnostic bundles exist so support can investigate a stuck or disputed transaction **without** asking users for screenshots or exposing wallet secrets, signed envelopes, or unnecessary personal data.

## What a bundle contains

A bundle is assembled from existing systems and is strictly limited to a **schema allowlist**. Every exported field is declared in the allowlist; there is no arbitrary log or database dump path. The allowlist covers only:

- Transaction reference (the ID the user already knows)
- Bounded status and status history (current state plus a short, capped list of transitions)
- Timestamps (created, updated, last status change)
- Failure category (a coarse, enumerated category — never raw error text)
- App version
- Correlation IDs (request/trace IDs used to join internal logs)

Nothing outside this allowlist is ever serialized. If a field is not in the allowlist, it cannot appear in the bundle.

## What a bundle explicitly excludes

By construction, a bundle **never** contains:

- **Wallet secrets** — private keys, seeds, mnemonics, or any key material
- **Signed envelopes** — signed transaction envelopes or signatures
- **Raw XDR** — unsigned or signed transaction XDR payloads
- **PII** — names, emails, addresses, or other personal data beyond the transaction reference

Sensitive values are redacted before serialization. Redaction happens on the assembled record, so even if an upstream system returns a sensitive value, it is stripped before the bundle is written.

## Requesting a bundle (user action)

Bundle generation requires **explicit user action** and is scoped to a transaction the user may access. A bundle is created with an explicit `POST` that includes a confirmation flag:

```
POST /transactions/{id}/diagnostic-bundle
Content-Type: application/json

{ "confirm": true }
```

- The request must include `"confirm": true`; without it, the request is rejected and no bundle is generated.
- The caller must have access to the referenced transaction. Requests for transactions the user may not access are refused.
- On success, the response returns the bundle identifier and its expiry time.

## Inspecting a bundle (support)

Support retrieves a bundle with a `GET` that enforces an ownership check:

```
GET /transactions/{id}/diagnostic-bundle/{bundleId}
```

- The ownership check ensures only the requesting user (or authorized support acting on their behalf) can read the bundle.
- The response contains only allowlisted, redacted fields.

## Expiry and deletion

- **Expiry:** Bundles expire after a short, documented window (see the expiry value returned when the bundle is created). After expiry the bundle can no longer be retrieved.
- **Deletion:** A user can delete a bundle at any time with:

```
DELETE /transactions/{id}/diagnostic-bundle/{bundleId}
```

Deletion removes the stored artifact. Support should delete bundles once an incident is resolved rather than retaining them.

## Tenant isolation, states, and failure behavior

A bundle is owned by the JWT `publicKey` of the wallet that submitted the
transaction. The transaction reference is resolved with a single ownership-scoped
query (`WHERE (id::text = $1 OR tx_hash = $1) AND submitted_by = $2`); a missing
reference and a reference owned by a different wallet therefore follow the same
code path and return the same `404` body. Bundle reads and deletes are likewise
scoped by `id AND submitted_by`, and no unscoped identifier lookup is performed
before the ownership check. This is what prevents identifier, timing, and error
message differences from disclosing another user's data.

Supported bundle states and responses:

| State     | Condition                                 | API result                                |
| --------- | ----------------------------------------- | ----------------------------------------- |
| `active`  | Owner request before expiry               | `200` with allowlisted, redacted contents |
| `expired` | Owner request after `expiresAt`           | `410` with no contents                    |
| `absent`  | Unknown id, or id owned by another wallet | `404`, identical for both cases           |
| `deleted` | Owner deleted the bundle                  | `404`, identical to `absent`              |

Input constraints: the reference and bundle id must be non-empty strings;
generation requires `{ "confirm": true }`; write requests require an
`Idempotency-Key` header. Invalid input is rejected with `400` before any bundle
is persisted, so a rejected or stale action has no partial side effect. Audit
correlation and audit-log writes are best-effort and never block generation;
a failure of the primary database query propagates without creating a bundle.

### Compatibility and migration

No public schema changes are introduced by the isolation fix. The transaction
reference may be either the numeric id or the `tx_hash`, so clients using either
form keep working. Stored bundles keep the same JSON shape and expiry semantics;
the only behavioral change is that a foreign or missing reference is now
indistinguishable in status, body, and query count. No data migration is needed.

## Test guarantee

The test suite seeds known secrets and PII into the systems a bundle draws from, then generates bundles and asserts that **none** of the seeded values appear in the resulting artifacts. This proves that wallet secrets, signed envelopes, raw XDR, and PII cannot leak into a generated bundle. Any change to the allowlist or redaction logic must keep these tests passing.

`backend/src/__tests__/tenantIsolation.test.ts` extends that guarantee across
the export, API, retry, and asynchronous worker paths: cross-wallet create/read/
delete probes must return byte-identical `404` responses, scoped SQL parameters
must always include the caller key, webhook retries must deliver each tenant's
payload only to its own subscriber, and the Soroban replay worker must not let a
later tenant's write overtake a failed earlier one. Reproduce with:

```bash
cd backend
npm ci --legacy-peer-deps
npm run test:tenant-isolation
```

## Related documentation

- See [DATABASE.md](./DATABASE.md) for storage details and the transaction routes section, which links back to this guide.
