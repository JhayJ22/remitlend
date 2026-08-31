# RemitLend API Reference

Comprehensive documentation for the RemitLend Backend API v1 endpoints. This document serves as a standalone reference for all publicly available endpoints, authentication methods, request/response formats, and error handling.

## Table of Contents

- [Overview](#overview)
- [Base URLs](#base-urls)
- [Authentication](#authentication)
- [Common Response Format](#common-response-format)
- [Error Codes](#error-codes)
- [Rate Limiting](#rate-limiting)
- [Endpoints](#endpoints)
  - [Authentication](#authentication-endpoints)
  - [Loans](#loans-endpoints)
  - [User](#user-endpoints)
  - [Pool](#pool-endpoints)
  - [Scoring](#scoring-endpoints)
  - [Indexer](#indexer-endpoints)
  - [Admin](#admin-endpoints)
  - [Remittances](#remittances-endpoints)
  - [Notifications](#notifications-endpoints)
  - [System](#system-endpoints)

---

## Overview

RemitLend Backend is an Express.js REST API that provides access to:

- **Loan Management**: Request, approve, repay, and manage loans on the Stellar blockchain
- **Credit Scoring**: Generate and retrieve credit scores based on transaction history
- **Lending Pools**: Access liquidity pools and pool configurations
- **User Profiles**: Manage user account data and preferences
- **Remittance Simulation**: Generate simulated remittance data for testing
- **Event Indexing**: Query blockchain events and transaction history
- **Notifications**: Subscribe to and manage webhook notifications

## Base URLs

- **Legacy (Deprecated)**: `https://api.remitlend.com/api`
- **Current (v1)**: `https://api.remitlend.com/api/v1`
- **User Routes**: `https://api.remitlend.com/user`

All new integrations should use the `/api/v1` base path.

## Authentication

### Bearer Token (JWT)

Used for user-authenticated requests (loans, user profiles, borrower-specific data).

**Header:**
```
Authorization: Bearer <JWT_TOKEN>
```

**How to Obtain:**
1. Call `/api/v1/auth/challenge` with your Stellar public key
2. Sign the returned message with your Stellar wallet
3. Call `/api/v1/auth/login` with the signed message to receive a JWT token

**Token Format:** Ed25519-signed JWT containing:
- `publicKey`: Your Stellar public key
- `role`: Account role (admin, borrower, lender)
- `scopes`: Array of permission scopes

**Token Expiration:** Tokens expire after 24 hours. Use `/api/v1/auth/refresh` to obtain a new token before expiration.

### API Key Authentication

Used for service-to-service requests and server-side operations.

**Header:**
```
x-api-key: <API_KEY>
```

**Available Scopes:**
- `admin:*` — Full administrative access
- `admin:loans` — Loan management
- `admin:pool` — Pool operations
- `admin:indexer` — Indexer operations
- `admin:scoring` — Scoring operations

## Common Response Format

All API responses follow a consistent JSON structure:

### Success Response (2xx)

```json
{
  "success": true,
  "data": {
    // Endpoint-specific data
  }
}
```

### Error Response (4xx, 5xx)

```json
{
  "success": false,
  "message": "Human-readable error message",
  "errors": [
    {
      "path": "body.publicKey",
      "message": "Public key is required"
    }
  ],
  "stack": "Error stack trace (development only)"
}
```

## Error Codes

| Status | Code | Description | Example |
|--------|------|-------------|---------|
| 400 | `ValidationError` | Request validation failed | Missing required field, invalid format |
| 400 | `BadRequestError` | Invalid request parameters | Incompatible loan amount with pool configuration |
| 401 | `UnauthorizedError` | Missing or invalid authentication | Missing Bearer token, JWT expired |
| 403 | `ForbiddenError` | Insufficient permissions | Attempting to access another user's loan |
| 404 | `NotFoundError` | Resource not found | Loan ID doesn't exist |
| 409 | `ConflictError` | Loan state conflict | Attempting to repay an already-repaid loan |
| 429 | `RateLimitError` | Rate limit exceeded | Too many login attempts |
| 500 | `InternalServerError` | Server error | Unexpected backend failure |
| 503 | `ServiceUnavailableError` | Service temporarily unavailable | Blockchain network degradation |

### Detailed Error Handling

- **Validation errors** return detailed `errors` array with field-level information
- **Authentication errors** include a `WWW-Authenticate` header
- **Rate limit errors** include `Retry-After` header with seconds to wait
- **Production errors** omit the `stack` field for security

## Rate Limiting

Rate limits are enforced per endpoint and IP address:

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/auth/challenge` | 5 requests | 15 minutes |
| `/auth/login` | 3 requests | 15 minutes (per IP) |
| `/auth/login` | 10 requests | 1 hour (per public key) |
| `/auth/verify` | 60 requests | 1 minute |
| General endpoints | 1000 requests | 1 hour (per IP) |

**Rate Limit Headers:**
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1700000000
```

---

## Endpoints

### Authentication Endpoints

#### POST /api/v1/auth/challenge

Request a sign-in message for wallet authentication.

**Request:**
```json
{
  "publicKey": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "nonce": "abc123def456",
    "timestamp": 1700000000000,
    "expiresIn": 300000,
    "message": "Sign this message to authenticate with RemitLend.\n\nNonce: abc123\nTimestamp: 1700000000000\n\nThis request will expire in 5 minutes."
  }
}
```

**Errors:**
- `400 ValidationError` — Missing or invalid public key
- `429 RateLimitError` — Too many challenge requests

---

#### POST /api/v1/auth/login

Exchange a signed challenge for a JWT token.

**Request:**
```json
{
  "publicKey": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
  "message": "Sign this message to authenticate with RemitLend.\n\nNonce: abc123\nTimestamp: 1700000000000\n\nThis request will expire in 5 minutes.",
  "signature": "base64EncodedSignature="
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJFZDI1NTE5In0...",
    "publicKey": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7"
  }
}
```

**Errors:**
- `400 ValidationError` — Invalid signature or expired challenge
- `401 UnauthorizedError` — Challenge not found or expired
- `429 RateLimitError` — Too many login attempts

---

#### GET /api/v1/auth/verify

Verify the current JWT token and retrieve user info.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "publicKey": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
    "role": "borrower",
    "scopes": ["loans:read", "loans:write"],
    "valid": true
  }
}
```

**Errors:**
- `401 UnauthorizedError` — Invalid or missing token

---

#### POST /api/v1/auth/logout

Revoke the current JWT token.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Token revoked successfully"
}
```

---

#### POST /api/v1/auth/refresh

Refresh an expiring or expired JWT token.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJFZDI1NTE5In0..."
  }
}
```

---

### Loans Endpoints

#### GET /api/v1/loans/config

Retrieve loan configuration and pool settings.

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "minLoanAmount": "100",
    "maxLoanAmount": "10000",
    "interestRate": "0.05",
    "loanTermMonths": 12,
    "minCollateralRatio": "1.5",
    "pools": [
      {
        "poolId": "pool_123",
        "currency": "USDC",
        "available": "50000",
        "total": "100000",
        "utilization": "0.5"
      }
    ]
  }
}
```

---

#### GET /api/v1/loans/borrower/{borrower}

Get all loans for a borrower.

**Query Parameters:**
```
?status=active&limit=10&offset=0
```

**Response (200 OK):**
```json
{
  "success": true,
  "borrower": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
  "loans": [
    {
      "loanId": 123,
      "principal": "1000",
      "accruedInterest": "50.25",
      "totalRepaid": "200",
      "totalOwed": "850.25",
      "nextPaymentDeadline": "2024-02-01T00:00:00Z",
      "status": "active",
      "borrower": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
      "approvedAt": "2024-01-01T00:00:00Z"
    }
  ]
}
```

**Errors:**
- `404 NotFoundError` — Borrower not found

---

#### GET /api/v1/loans/{loanId}

Get detailed information for a specific loan.

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "loanId": 123,
    "borrower": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
    "principal": "1000",
    "interestRate": "0.05",
    "totalRepaid": "200",
    "totalOwed": "850.25",
    "accruedInterest": "50.25",
    "nextPaymentDeadline": "2024-02-01T00:00:00Z",
    "status": "active",
    "createdAt": "2024-01-01T00:00:00Z",
    "approvedAt": "2024-01-01T00:00:00Z"
  }
}
```

**Errors:**
- `404 NotFoundError` — Loan not found
- `403 ForbiddenError` — Access denied

---

#### GET /api/v1/loans/{loanId}/amortization-schedule

Get the amortization schedule for a loan.

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "schedule": [
      {
        "paymentNumber": 1,
        "dueDate": "2024-02-01T00:00:00Z",
        "principalPayment": "83.33",
        "interestPayment": "4.17",
        "totalPayment": "87.50",
        "balanceRemaining": "916.67"
      }
    ]
  }
}
```

---

#### POST /api/v1/loans/request

Request a new loan.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
Idempotency-Key: unique-key-value
```

**Request:**
```json
{
  "amount": "1000",
  "term": 12,
  "collateral": "500",
  "poolId": "pool_123"
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "loanId": 124,
    "transactionHash": "tx123...",
    "status": "pending_approval"
  }
}
```

**Errors:**
- `400 BadRequestError` — Invalid loan amount or term
- `401 UnauthorizedError` — Missing authentication
- `409 ConflictError` — Insufficient collateral

---

#### POST /api/v1/loans/{loanId}/repay

Make a loan repayment.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
Idempotency-Key: unique-key-value
```

**Request:**
```json
{
  "amount": "200",
  "transactionHash": "tx789..."
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "loanId": 123,
    "newBalance": "650.25",
    "nextPaymentDeadline": "2024-03-01T00:00:00Z"
  }
}
```

**Errors:**
- `404 NotFoundError` — Loan not found
- `409 ConflictError` — Loan already repaid

---

#### POST /api/v1/loans/{loanId}/deposit-collateral

Deposit additional collateral for a loan.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
Idempotency-Key: unique-key-value
```

**Request:**
```json
{
  "amount": "100",
  "transactionHash": "tx456..."
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "loanId": 123,
    "totalCollateral": "600",
    "collateralRatio": "1.75"
  }
}
```

---

#### POST /api/v1/loans/{loanId}/release-collateral

Release excess collateral from a loan.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
Idempotency-Key: unique-key-value
```

**Request:**
```json
{
  "amount": "50"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "loanId": 123,
    "releasedAmount": "50",
    "remainingCollateral": "550"
  }
}
```

---

### User Endpoints

#### GET /user/profile

Get the current user's profile (requires authentication).

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "publicKey": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
    "email": "user@example.com",
    "name": "John Doe",
    "role": "borrower",
    "createdAt": "2024-01-01T00:00:00Z"
  }
}
```

---

#### PATCH /user/profile

Update the current user's profile.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

**Request:**
```json
{
  "email": "newemail@example.com",
  "name": "Jane Doe"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Profile updated successfully"
}
```

---

### Pool Endpoints

#### GET /api/v1/pool

Get all available lending pools.

**Query Parameters:**
```
?limit=10&offset=0
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "pools": [
      {
        "poolId": "pool_123",
        "currency": "USDC",
        "totalLiquidity": "100000",
        "available": "50000",
        "utilization": "0.5",
        "interestRate": "0.05"
      }
    ]
  }
}
```

---

#### GET /api/v1/pool/{poolId}

Get details for a specific pool.

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "poolId": "pool_123",
    "currency": "USDC",
    "totalLiquidity": "100000",
    "available": "50000",
    "utilized": "50000",
    "utilization": "0.5",
    "interestRate": "0.05",
    "activeLoans": 42,
    "totalBorrowers": 38
  }
}
```

---

### Scoring Endpoints

#### POST /api/v1/score/calculate

Calculate a credit score for a borrower.

**Request:**
```json
{
  "borrower": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "score": 750,
    "grade": "A",
    "factors": {
      "repaymentHistory": 0.9,
      "loanCount": 0.8,
      "totalBorrowed": 0.75,
      "defaultRisk": 0.95
    },
    "calculatedAt": "2024-01-15T10:30:00Z"
  }
}
```

---

#### GET /api/v1/score/{borrower}

Get the most recent credit score for a borrower.

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "borrower": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
    "score": 750,
    "grade": "A",
    "calculatedAt": "2024-01-15T10:30:00Z"
  }
}
```

---

### Indexer Endpoints

#### GET /api/v1/indexer/events

Query blockchain events (loan requests, approvals, repayments, etc.).

**Query Parameters:**
```
?type=LoanRequested&borrower=G...&limit=10&offset=0
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "events": [
      {
        "type": "LoanRequested",
        "borrower": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
        "loanId": 123,
        "amount": "1000",
        "timestamp": "2024-01-01T12:00:00Z",
        "transactionHash": "tx123..."
      }
    ],
    "total": 100,
    "limit": 10,
    "offset": 0
  }
}
```

---

#### GET /api/v1/indexer/loans/{loanId}/events

Get all events for a specific loan.

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "loanId": 123,
    "events": [
      {
        "type": "LoanRequested",
        "timestamp": "2024-01-01T12:00:00Z",
        "amount": "1000"
      },
      {
        "type": "LoanApproved",
        "timestamp": "2024-01-02T10:00:00Z"
      },
      {
        "type": "LoanRepaid",
        "timestamp": "2024-01-15T15:30:00Z",
        "amount": "1050"
      }
    ]
  }
}
```

---

### Admin Endpoints

#### GET /api/v1/admin/loans

List all loans (admin only).

**Headers:**
```
x-api-key: <ADMIN_API_KEY>
```

**Query Parameters:**
```
?status=pending&limit=20&offset=0
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "loans": [
      {
        "loanId": 123,
        "borrower": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
        "amount": "1000",
        "status": "pending_approval",
        "createdAt": "2024-01-01T12:00:00Z"
      }
    ],
    "total": 150
  }
}
```

---

#### POST /api/v1/admin/loans/{loanId}/approve

Approve a loan (admin only).

**Headers:**
```
x-api-key: <ADMIN_API_KEY>
Content-Type: application/json
Idempotency-Key: unique-key-value
```

**Request:**
```json
{
  "approverNotes": "Approved after verification"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "loanId": 123,
    "status": "approved",
    "approvedAt": "2024-01-02T10:00:00Z"
  }
}
```

---

#### POST /api/v1/admin/loans/{loanId}/reject

Reject a loan (admin only).

**Headers:**
```
x-api-key: <ADMIN_API_KEY>
Content-Type: application/json
```

**Request:**
```json
{
  "reason": "Insufficient collateral based on credit assessment"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Loan rejected successfully",
  "data": {
    "loanId": 123,
    "status": "rejected"
  }
}
```

---

### Remittances Endpoints

#### GET /api/v1/remittances

Get remittance records.

**Query Parameters:**
```
?borrower=G...&limit=10&offset=0
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "remittances": [
      {
        "remittanceId": "rem_123",
        "borrower": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
        "amount": "500",
        "status": "completed",
        "createdAt": "2024-01-10T08:00:00Z",
        "completedAt": "2024-01-10T09:30:00Z"
      }
    ]
  }
}
```

---

### Notifications Endpoints

#### GET /api/v1/notifications

Get user notifications.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Query Parameters:**
```
?read=false&limit=20
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "notifications": [
      {
        "notificationId": "notif_123",
        "type": "loan_approved",
        "message": "Your loan #123 has been approved",
        "read": false,
        "createdAt": "2024-01-02T10:00:00Z"
      }
    ]
  }
}
```

---

#### POST /api/v1/notifications/{notificationId}/read

Mark a notification as read.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Notification marked as read"
}
```

---

### System Endpoints

#### GET /health

Health check endpoint (no authentication required).

**Response (200 OK):**
```json
{
  "status": "ok",
  "checks": {
    "api": "ok",
    "database": "ok",
    "redis": "ok",
    "soroban_rpc": "ok"
  },
  "uptime": 3600,
  "timestamp": 1700000000000
}
```

---

#### GET /health/deep

Deep health check (queries all dependencies).

**Response (200 OK):**
```json
{
  "status": "ok",
  "checks": {
    "db": "ok",
    "redis": "ok",
    "stellarRpc": "ok",
    "indexer": {
      "status": "ok",
      "lagLedgers": 5
    }
  },
  "timestamp": 1700000000000
}
```

**Status Values:**
- `ok` — All services healthy
- `degraded` — Some services are slow or indexer is lagging
- `down` — Critical service is down

---

#### GET /version

Get deployment version and contract addresses.

**Response (200 OK):**
```json
{
  "gitSha": "abc123def456...",
  "builtAt": "2024-01-15T10:00:00Z",
  "nodeVersion": "v18.18.0",
  "contracts": {
    "loanManager": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    "lendingPool": "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBC4",
    "remittanceNft": "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC4",
    "multisigGovernance": "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD4"
  }
}
```

---

## Request Idempotency

For state-mutating operations (loans, payments, etc.), include an `Idempotency-Key` header to ensure safe retries:

```
Idempotency-Key: a-unique-uuid-v4-string
```

If the same key is sent within 24 hours, the server returns the cached response from the original request, preventing duplicate operations.

---

## Pagination

List endpoints support pagination via query parameters:

```
GET /api/v1/loans/borrower/{borrower}?limit=20&offset=0
```

**Response includes:**
- `total` — Total number of records
- `limit` — Number returned per page
- `offset` — Current offset from start
- `data` — Array of records

---

## Webhooks

Subscribe to events via webhooks for real-time notifications of loan approvals, repayments, and other state changes.

**Webhook Delivery Format:**
```json
{
  "type": "loan.approved",
  "data": {
    "loanId": 123,
    "borrower": "G...",
    "approvedAt": "2024-01-02T10:00:00Z"
  },
  "timestamp": 1704192000000
}
```

For detailed webhook configuration, see [docs/webhooks.md](./webhooks.md).

---

## Interactive API Documentation

An interactive Swagger UI is available at:

**Non-Production:** `https://api.remitlend.com/docs`

**Production (if enabled):** Set `ENABLE_SWAGGER=true` to expose at `/docs`

The raw OpenAPI 3.0 specification is available at `/docs.json`.

---

## Best Practices

### Security

- Always use HTTPS in production
- Store JWT tokens securely (localStorage or secure cookies)
- Rotate API keys regularly
- Never commit API keys to version control
- Validate all input before sending to the API

### Error Handling

- Implement exponential backoff for retries
- Check response status codes and `success` field
- Use `Idempotency-Key` headers for safety
- Log error messages for debugging

### Performance

- Implement pagination for list endpoints
- Cache responses where appropriate
- Avoid polling; use webhooks for real-time updates
- Use connection pooling if possible

### Monitoring

- Monitor rate limit headers (`X-RateLimit-*`)
- Track response times and error rates
- Set up alerts for 5xx errors
- Use correlation IDs for request tracing

---

## Support and Feedback

For issues, questions, or feature requests:

- **GitHub Issues:** [remitlend/issues](https://github.com/JhayJ22/remitlend/issues)
- **Documentation:** [GitHub Docs](https://github.com/JhayJ22/remitlend/tree/main/docs)
- **Security Issues:** Please report privately to maintainers

---

**Last Updated:** 2024-01-15  
**API Version:** 1.0.0  
**Status:** Production
