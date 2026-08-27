# Pagination Strategy

## Overview
All list endpoints in the RemitLend API use **cursor-based pagination** to ensure stability and efficiency, especially important for real-time data and large datasets.

## Why Cursor-Based Pagination?

### Problems with Offset Pagination
- **Real-time data instability**: Results shift when new items are inserted, causing duplicates or skipped items
- **Performance degradation**: Large offsets require scanning many rows even to skip them
- **Predictable**: Sequential offsets are easy to guess and can be exploited

### Advantages of Cursor-Based Pagination
- **Stable across inserts/deletes**: Results remain consistent even with concurrent writes
- **Performant**: Uses index seeks instead of full scans
- **Opaque**: Cursors are encoded base64url strings, making them tamper-proof
- **Stateless**: The cursor contains all positional information needed

## Implementation Details

### Keyset (Cursor) Pagination

All list endpoints use **keyset pagination** with two ordering columns:
- **Primary**: `created_at` (timestamp) — for chronological ordering
- **Secondary**: `seq` (bigserial) — for stable ordering within the same timestamp

#### Cursor Format
Cursors are **opaque base64url-encoded** JSON:
```json
{
  "createdAt": "2026-08-26T10:30:45.123Z",
  "seq": "12345"
}
```

Encoded example: `eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTI2VDEwOjMwOjQ1LjEyM1oiLCJzZXEiOiIxMjM0NSJ9`

#### Snapshot Consistency
To ensure stable pagination across page boundaries:
1. First request pins a **snapshot_seq** (max seq at request time)
2. Subsequent requests must include the same **snapshot_seq**
3. Only rows with `seq <= snapshot_seq` are visible (older data)
4. New rows (seq > snapshot_seq) won't appear until next snapshot

### Query Pattern

```sql
SELECT * FROM table_name
WHERE
  seq <= :snapshot_seq                                         -- Snapshot constraint
  AND (created_at < :cursor_created_at                        -- Keyset seek
       OR (created_at = :cursor_created_at AND seq < :cursor_seq))
  AND (other_filters)                                          -- Status, date range, etc.
ORDER BY created_at DESC, seq DESC
LIMIT :limit + 1
```

## API Contract

### Request Parameters

| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `limit` | integer | No | Items per page. Default: 50, Max: 100 | `50` |
| `cursor` | string | No | Opaque cursor from `next_cursor` of previous response | `eyJjcmVhdGVkQXQi...` |
| `snapshot_seq` | string | No | Pinned seq for stable pagination. Auto-detected on first request | `99999` |

### Response Structure

```json
{
  "success": true,
  "data": [
    { "id": 1, "status": "active", ... },
    { "id": 2, "status": "active", ... }
  ],
  "total_count": null,
  "page_info": {
    "limit": 50,
    "count": 2,
    "next_cursor": "eyJjcmVhdGVkQXQi...",
    "has_previous": false,
    "has_next": true
  }
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `data` | array | List of items for this page |
| `total_count` | number \| null | Total count at snapshot (null if large table optimization used) |
| `page_info.limit` | integer | Requested limit |
| `page_info.count` | integer | Actual count of returned items |
| `page_info.next_cursor` | string \| null | Cursor for next page, or null if no more items |
| `page_info.has_previous` | boolean | True if there are items before this cursor |
| `page_info.has_next` | boolean | True if next_cursor is not null |

## Pagination Examples

### Example 1: First Page (Loans)

**Request:**
```bash
GET /api/v1/loans/borrower/GXXXXXX?limit=10
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "borrower": "GXXXXXX",
    "loans": [
      { "loanId": 5, "principal": 1000, "status": "active", ... },
      { "loanId": 4, "principal": 2000, "status": "repaid", ... },
      { "loanId": 3, "principal": 500, "status": "active", ... }
    ]
  },
  "total_count": 25,
  "page_info": {
    "limit": 10,
    "count": 3,
    "next_cursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTI0VDEwOjMwOjAwWiIsInNlcSI6IjMifQ==",
    "has_previous": false,
    "has_next": true
  }
}
```

### Example 2: Subsequent Page

**Request:**
```bash
GET /api/v1/loans/borrower/GXXXXXX?limit=10&cursor=eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTI0VDEwOjMwOjAwWiIsInNlcSI6IjMifQ==
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "borrower": "GXXXXXX",
    "loans": [
      { "loanId": 2, "principal": 1500, "status": "active", ... },
      { "loanId": 1, "principal": 3000, "status": "defaulted", ... }
    ]
  },
  "total_count": 25,
  "page_info": {
    "limit": 10,
    "count": 2,
    "next_cursor": null,
    "has_previous": true,
    "has_next": false
  }
}
```

### Example 3: With Filters (Remittances)

**Request:**
```bash
GET /api/v1/remittances?limit=20&status=completed&from=2026-08-01T00:00:00Z&to=2026-08-26T23:59:59Z
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": "uuid-5", "status": "completed", "amount": 500, ... },
    { "id": "uuid-4", "status": "completed", "amount": 1200, ... }
  ],
  "total_count": 145,
  "page_info": {
    "limit": 20,
    "count": 2,
    "next_cursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTI0VDIyOjQ1OjMwWiIsInNlcSI6IjQ4OTAwIn0=",
    "has_previous": false,
    "has_next": true
  }
}
```

## Client Implementation Guide

### JavaScript/TypeScript
```typescript
async function fetchAllItems(url: string, token: string): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: string | null = null;

  while (true) {
    const params = new URLSearchParams({ limit: '50' });
    if (cursor) params.append('cursor', cursor);

    const response = await fetch(`${url}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { data, page_info } = await response.json();

    items.push(...data);

    if (!page_info.has_next) break;
    cursor = page_info.next_cursor;
  }

  return items;
}
```

### Python
```python
def fetch_all_items(url: str, token: str) -> list:
    items = []
    cursor = None
    headers = {'Authorization': f'Bearer {token}'}

    while True:
        params = {'limit': 50}
        if cursor:
            params['cursor'] = cursor

        response = requests.get(url, params=params, headers=headers)
        data = response.json()

        items.extend(data['data'])

        if not data['page_info']['has_next']:
            break
        cursor = data['page_info']['next_cursor']

    return items
```

## Cursor Tampering Prevention

Cursors are:
- **Base64url encoded**: Not plain JSON, harder to read
- **Immutable**: The server strictly validates the structure
- **Snapshot-bound**: Invalid without the matching snapshot_seq
- **Type-checked**: Must contain exactly `createdAt` and `seq` fields

Attempting to create or modify a cursor will result in a `400 Bad Request` with `code: VALIDATION_ERROR`.

## Deprecated: Offset Pagination

The legacy `/api/*` routes may use offset-based pagination (`limit` and `offset` parameters). These routes are **deprecated** as of 2026-08-26.

**Do not use offset pagination for new client implementations.** Always use `/api/v1/*` with cursor pagination.

## Index Strategy

Cursor pagination is optimized by composite indexes on `(created_at DESC, seq DESC)`:

```sql
-- All list endpoints backed by these indexes
idx_remittances_seek (created_at DESC, seq DESC)
idx_contract_events_seek (created_at DESC, seq DESC)
idx_loan_disputes_seek (created_at DESC, seq DESC)
```

These indexes ensure O(1) positioning and O(limit) data retrieval, even on billion-row tables.
