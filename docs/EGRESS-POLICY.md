# Outbound Egress Policy for Provider Integrations

> **Issue #363** — This document defines the permitted outbound network
> destinations for every RemitLend service, the controls in place to enforce
> those boundaries, and the process for requesting new egress allowances.

---

## Threat model

Unrestricted outbound network access from a compromised container allows:
- Exfiltration of in-memory secrets (JWT signing key, PII field-encryption key)
- Command-and-control (C2) connectivity for a supply-chain backdoor
- Lateral movement to cloud metadata endpoints (e.g., `169.254.169.254`)

Explicitly enumerating and enforcing permitted destinations reduces the blast
radius of a container breakout or a compromised dependency.

---

## Service egress allowances

Each row describes the destinations a service is permitted to reach and the
business reason. Destinations are domain-based; IP ranges are noted where the
provider publishes them.

### Backend (`remitlend-backend`)

| Destination | Port | Protocol | Reason |
|-------------|------|----------|--------|
| `horizon.stellar.org` | 443 | HTTPS | Stellar Horizon API — NFT / pool reads |
| `soroban-testnet.stellar.org` | 443 | HTTPS | Soroban RPC (testnet) |
| `soroban-mainnet.stellar.org` | 443 | HTTPS | Soroban RPC (mainnet) |
| `*.rpc.stellar.org` | 443 | HTTPS | Stellar RPC node pool |
| Internal `db` service | 5432 | TCP | PostgreSQL — primary datastore |
| Internal `redis` service | 6379 | TCP | Redis — session cache / job queue |
| Webhook subscriber URLs | 443 | HTTPS | Outbound webhook delivery (user-configured) |
| `kms.<region>.amazonaws.com` | 443 | HTTPS | AWS KMS — PII field-encryption key wrapping |
| `sentry.io` | 443 | HTTPS | Error telemetry (optional, configured via `SENTRY_DSN`) |

**Blocked by default:**
- Cloud metadata endpoint `169.254.169.254`
- Any destination not listed above

### Frontend (`remitlend-frontend`)

The frontend container is a Next.js server-side renderer. Its outbound
connections are limited to internal service-to-service calls.

| Destination | Port | Protocol | Reason |
|-------------|------|----------|--------|
| Internal `backend` service | 3001 | HTTP | Server-side API calls (`API_URL`) |
| `sentry.io` | 443 | HTTPS | Error telemetry (optional) |

Browser-side requests (from the user's browser, not the container) are
governed by the `Content-Security-Policy` response headers — see
[`backend/docs/CONTENT_SECURITY_POLICY.md`](../backend/docs/CONTENT_SECURITY_POLICY.md).

### Database (`db` — PostgreSQL)

Listens only on the internal `backend` Docker network. Does not initiate any
outbound connections.

### Cache (`redis`)

Listens only on the internal `backend` Docker network. Does not initiate any
outbound connections.

---

## Enforcement mechanisms

### 1. Docker network segmentation (current, all environments)

`docker-compose.production.yml` places `db` and `redis` on an `internal:
true` bridge network that has no route to the host network. The `backend`
service bridges the `frontend` and `backend` networks. The `frontend` service
attaches only to the `frontend` network.

```
Internet → frontend:3000 → backend:3001 → db:5432
                                        → redis:6379
                                        → Stellar RPC / KMS (outbound HTTPS)
```

The `internal: true` flag on the `backend` network blocks all outbound traffic
from `db` and `redis` at the Docker daemon level — no additional firewall rules
required.

### 2. Linux capabilities dropped (current, all environments)

All production/staging containers run with `cap_drop: [ALL]`, which removes
`CAP_NET_ADMIN` and `CAP_NET_RAW`. This prevents a compromised process from
modifying routing tables, creating raw sockets, or bypassing iptables rules.

### 3. Kubernetes NetworkPolicy (recommended for production clusters)

If the deployment target migrates to Kubernetes, apply the policies in
[`docs/k8s/`](k8s/) alongside the service definitions. A reference policy
is provided below.

```yaml
# Allow backend → Stellar RPC egress on port 443 only.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-egress-stellar
  namespace: remitlend
spec:
  podSelector:
    matchLabels:
      app: remitlend-backend
  policyTypes:
    - Egress
  egress:
    # Internal: PostgreSQL
    - ports:
        - port: 5432
          protocol: TCP
    # Internal: Redis
    - ports:
        - port: 6379
          protocol: TCP
    # External: Stellar RPC / Horizon / KMS / Sentry
    - ports:
        - port: 443
          protocol: TCP
    # DNS resolution
    - ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
```

> **Note:** Kubernetes NetworkPolicy enforcement requires a CNI plugin that
> supports it (e.g., Calico, Cilium, Weave). Confirm your cluster's CNI before
> applying.

### 4. Webhook URL allowlisting (application layer)

Outbound webhook delivery is a controlled egress vector. The backend validates
webhook subscriber URLs against the following rules before delivery:

- Must use `https://` (no plain HTTP, no `file://`, no `data:`)
- Must not resolve to RFC 1918 / link-local ranges (SSRF guard)
- Must not be `169.254.169.254` (cloud metadata endpoint)

These checks are implemented in `backend/src/services/webhookService.ts`.

---

## Adding a new egress destination

1. Open a pull request that modifies this file to add the new destination.
2. Include in the PR description:
   - The service that needs the connection
   - The domain/IP and port
   - The business reason (specific feature or dependency)
   - The threat model impact (data classification of what is sent)
3. Update the Docker Compose `networks` or Kubernetes `NetworkPolicy` to allow
   the new destination if required.
4. Tag the PR with `security` and request a review from a maintainer.

Destinations that route user PII (email, phone, name) outside the internal
network require an additional privacy review.

---

## Cloud metadata endpoint protection

The backend `SSRF_BLOCKED_CIDRS` environment variable (see
[`docs/ENVIRONMENT.md`](ENVIRONMENT.md)) is set to block requests to
`169.254.169.254/32` and `100.64.0.0/10` by default. This is enforced at the
HTTP client layer in `backend/src/utils/httpClient.ts`.

If you deploy on a cloud provider that uses a different metadata address,
add it to `SSRF_BLOCKED_CIDRS`.

---

## Audit log

Outbound HTTP requests from the backend are logged at `debug` level with the
destination host and response status (not the full URL, to avoid logging tokens
in query strings). Set `LOG_LEVEL=debug` to enable.

Security-relevant egress failures (e.g., a blocked SSRF attempt) are logged
at `warn` level and included in the audit log table.
