# API Versioning Strategy

## Overview
The RemitLend API uses URL path versioning with deprecation headers. The current version is **v1**.

## Version History

### Legacy API (`/api/*`) - DEPRECATED
- **Status**: Deprecated as of 2026-08-26
- **Sunset Date**: 2027-08-26 (1 year from deprecation)
- **Migration Target**: `/api/v1/*`

All legacy `/api/*` endpoints return HTTP response headers:
- `Deprecation: true`
- `Sunset: <date>` (1 year from now)
- `Link: </api/v1>; rel="successor-version"; title="API v1"`

### Current API (`/api/v1/*`) - STABLE
- **Status**: Current and stable
- **First Released**: Initial versioning rollout
- **Support**: Long-term support

## Migration Guide

### For API Consumers

1. **Identify your current endpoints**
   - If you're using `/api/loans`, `/api/admin`, etc., you're on the legacy API

2. **Update endpoints**
   - Replace `/api/` prefix with `/api/v1/`
   - Example: `GET /api/loans/borrower/GXXXXXX` → `GET /api/v1/loans/borrower/GXXXXXX`

3. **No breaking changes**
   - All endpoint signatures, parameters, and response formats remain identical
   - This is a purely structural migration (URL prefix change)

4. **Deprecation warnings**
   - The server will include deprecation headers in responses
   - Clients may log warnings when these headers are present

5. **Timeline**
   - Legacy API will be maintained for 1 year
   - All clients should migrate before the sunset date

### Request Examples

#### Legacy (Deprecated)
```bash
curl https://api.remitlend.com/api/v1/loans/borrower/GXXXXXX \
  -H "Authorization: Bearer <token>"
```

#### Current (Recommended)
```bash
curl https://api.remitlend.com/api/v1/loans/borrower/GXXXXXX \
  -H "Authorization: Bearer <token>"
```

## Implementation Details

### Deprecation Headers
Every response from `/api/*` endpoints includes:

```http
HTTP/1.1 200 OK
Deprecation: true
Sunset: Sun, 26 Aug 2027 00:00:00 GMT
Link: </api/v1>; rel="successor-version"; title="API v1"
Content-Type: application/json
```

### Deprecation Response Example
```json
{
  "success": true,
  "data": { /* ... */ }
}
```
The response payload itself is unchanged; only headers signal deprecation.

## Future Versions
When `v2` is released:
- `v1` will receive deprecation headers pointing to `v2`
- Legacy `/api/*` will continue routing to `v1` until v1's sunset date
- Similar 1-year deprecation window for `v1`

## FAQ

**Q: Will my requests stop working after the sunset date?**
A: Yes. After the sunset date (2027-08-26), the `/api/*` prefix will no longer be available.

**Q: Do I need to change my code?**
A: Only the API endpoint prefix. No parameter or response format changes needed.

**Q: Why deprecate the legacy path?**
A: Explicit versioning in the URL path makes it clearer which API version clients are using, and simplifies future migrations.
