# Troubleshooting Guide

Comprehensive troubleshooting guide for common issues during development and production.

---

## Table of Contents

1. [Quick Diagnosis](#quick-diagnosis)
2. [Development Environment Issues](#development-environment-issues)
3. [Backend API Issues](#backend-api-issues)
4. [Frontend Issues](#frontend-issues)
5. [Database & Migration Issues](#database--migration-issues)
6. [Smart Contract Issues](#smart-contract-issues)
7. [Wallet Integration Issues](#wallet-integration-issues)
8. [Indexer & Sync Issues](#indexer--sync-issues)
9. [Deployment & Production Issues](#deployment--production-issues)
10. [Performance Issues](#performance-issues)
11. [Security & Authentication Issues](#security--authentication-issues)

---

## Quick Diagnosis

### Health Check Endpoints

| Service | Endpoint | Expected Response |
|---------|----------|-------------------|
| Backend | `GET /health` | `200 OK` with `{ "status": "ok" }` |
| Frontend | `GET /` | `200 OK` with HTML |
| Database | `pg_isready` | `accepting connections` |
| Redis | `redis-cli ping` | `PONG` |

### First Steps for Any Issue

1. **Check service health** - Run health checks above
2. **Check logs** - `docker-compose logs -f [service]`
3. **Verify environment** - Compare `.env` with `.env.example`
4. **Check resource usage** - `docker stats`, `htop`, `df -h`
5. **Verify network connectivity** - `curl`, `nc`, `telnet`

---

## Development Environment Issues

### Docker Compose Fails to Start

**Symptoms:** Containers exit immediately, `docker-compose up` fails

**Common Causes & Solutions:**

| Cause | Solution |
|-------|----------|
| Port conflicts (3000, 3001, 5432, 6379 in use) | `lsof -i :3000` and kill conflicting processes, or change ports in `.env` |
| Docker daemon not running | `sudo systemctl start docker` (Linux) / Start Docker Desktop (Mac/Windows) |
| Insufficient memory | Increase Docker memory limit to 4GB+ in Docker Desktop settings |
| Volume permission issues | `sudo chown -R $USER:$USER .` and `docker-compose down -v` then `up --build` |

### Node.js Version Mismatch

**Symptoms:** `npm install` fails, build errors, runtime errors

**Solution:**
```bash
# Check required version
cat .nvmrc
# Use correct version
nvm use
# Or install if missing
nvm install
```

### Dependency Installation Failures

**Backend:**
```bash
cd backend
rm -rf node_modules package-lock.json
npm cache clean --force
npm install
```

**Frontend:**
```bash
cd frontend
rm -rf node_modules package-lock.json .next
npm cache clean --force
npm install
```

**Contracts:**
```bash
cd contracts
cargo clean
cargo build --target wasm32-unknown-unknown --release
```

### Hot Reload Not Working

**Backend:** Ensure `npm run dev` uses `tsx watch` or `nodemon`
**Frontend:** Ensure `npm run dev` uses `next dev` with Turbopack

---

## Backend API Issues

### API Returns 500 Internal Server Error

**Debugging Steps:**
1. Check backend logs: `docker-compose logs backend`
2. Check request ID in response headers for tracing
3. Enable debug logging: Set `LOG_LEVEL=debug` in `.env`

**Common Causes:**

| Error | Cause | Solution |
|-------|-------|----------|
| `ECONNREFUSED` to database | Database not ready | Wait for healthcheck, check `DATABASE_URL` |
| `JWT expired` / `invalid signature` | Token expired or secret mismatch | Verify `JWT_SECRET` in `.env`, check token expiry |
| `Rate limit exceeded` | Too many requests | Check rate limiter config, implement exponential backoff |
| `Validation failed` | Invalid request body | Check request against Swagger/OpenAPI spec at `/docs` |

### Database Connection Issues

**Symptoms:** `connect ECONNREFUSED`, `connection timeout`, `pool exhausted`

**Solutions:**
```bash
# Check database is healthy
docker-compose exec db pg_isready -U postgres

# Check connection pool settings in backend/.env
DATABASE_POOL_MIN=2
DATABASE_POOL_MAX=10
DATABASE_POOL_IDLE_TIMEOUT=30000

# Reset connections
docker-compose restart backend db
```

### Migration Failures

**Symptoms:** `npm run migrate:up` fails

**Solutions:**
```bash
# Check migration status
cd backend
npm run migrate:status

# Rollback failed migration
npm run migrate:down

# Force migration (use with caution)
npm run migrate:up -- --force

# Check migration files for syntax errors
ls backend/migrations/
```

### API Returns 401 Unauthorized

**Causes & Solutions:**
- Invalid/missing JWT token → Check `Authorization: Bearer <token>` header
- Token expired → Refresh token using `/auth/refresh`
- Wrong `JWT_SECRET` → Ensure backend and frontend use same secret
- Clock skew → Sync server time with NTP

### API Returns 403 Forbidden

**Causes & Solutions:**
- Insufficient role/permissions → Check user role in JWT claims
- Resource ownership mismatch → Verify user owns the resource
- Feature flag disabled → Check feature flags in config

### Rate Limiting Issues

**Configuration** (backend/.env):
```env
RATE_LIMIT_WINDOW_MS=900000  # 15 minutes
RATE_LIMIT_MAX_REQUESTS=100  # requests per window
```

**Solutions:**
- Implement client-side caching
- Use request batching
- Implement exponential backoff with jitter

---

## Frontend Issues

### Page Not Loading / Blank Screen

**Debugging Steps:**
1. Open browser DevTools Console (F12)
2. Check Network tab for failed requests
3. Check for JavaScript errors

**Common Causes:**

| Issue | Solution |
|-------|----------|
| Hydration mismatch | Check for client/server rendering differences, use `useEffect` for browser-only code |
| Missing environment variables | Verify `NEXT_PUBLIC_*` vars in frontend/.env.local |
| Chunk load failed | Clear browser cache, check CDN/network, rebuild with `npm run build` |
| TypeScript errors | Run `npm run lint` and fix type errors |

### Styling Issues (Tailwind CSS)

**Symptoms:** Styles not applied, classes missing, dark mode broken

**Solutions:**
```bash
# Rebuild Tailwind
cd frontend
npm run build

# Check content paths in tailwind.config.ts
# Ensure all component paths are included

# Purge unused styles in production
NODE_ENV=production npm run build
```

### Wallet Connection Issues

**Symptoms:** "Wallet not found", connection fails, account not detected

**Solutions:**
1. **Freighter not installed** → Install from [freighter.app](https://freighter.app)
2. **Wrong network** → Switch to Testnet/Mainnet in wallet
3. **Pop-up blocked** → Allow popups for localhost
4. **Multiple wallets** → Disable other wallet extensions
5. **Stellar Wallet Kit version mismatch** → Check `package.json` for compatible versions

### API Integration Issues

**Symptoms:** Frontend shows errors, data not loading, mutations fail

**Debugging:**
1. Check Network tab → failed requests
2. Verify API base URL: `NEXT_PUBLIC_API_URL` in frontend/.env.local
3. Check CORS: Backend `CORS_ALLOWED_ORIGINS` must include frontend origin
4. Check request/response format against Swagger at `/docs`

---

## Database & Migration Issues

### PostgreSQL Connection Issues

**Symptoms:** `FATAL: password authentication failed`, `connection refused`

**Solutions:**
```bash
# Check database is running
docker-compose ps db

# Check logs
docker-compose logs db

# Verify credentials in backend/.env
DATABASE_URL=postgres://postgres:postgres@db:5432/remitlend

# Reset database (WARNING: destroys data)
docker-compose down -v db
docker-compose up -d db
```

### Migration Lock Issues

**Symptoms:** `migration lock timeout`, `migration already in progress`

**Solutions:**
```bash
# Check for stuck migration
cd backend
npm run migrate:status

# Force unlock (use with caution)
npm run migrate:unlock

# Manual unlock via SQL
docker-compose exec db psql -U postgres -d remitlend -c "DELETE FROM migrations_lock;"
```

### Data Integrity Issues

**Symptoms:** Foreign key violations, duplicate key errors, constraint failures

**Solutions:**
1. Check application logic for race conditions
2. Use database transactions for multi-step operations
3. Add unique constraints at database level
4. Implement idempotency keys for mutations

---

## Smart Contract Issues

### Build Failures

**Symptoms:** `cargo build` fails, WASM compilation errors

**Solutions:**
```bash
# Update Rust toolchain
rustup update
rustup target add wasm32-unknown-unknown

# Clean and rebuild
cd contracts
cargo clean
cargo build --target wasm32-unknown-unknown --release

# Check for dependency conflicts
cargo tree -d
```

### Contract Deployment Failures

**Symptoms:** `soroban contract deploy` fails, transaction errors

**Common Causes & Solutions:**

| Error | Solution |
|-------|----------|
| `Insufficient balance` | Fund deployer account with XLM |
| `Contract already deployed` | Use different salt or deploy new contract |
| `WASM too large` | Optimize contract size, enable `strip = true` in Cargo.toml |
| `RPC timeout` | Use different RPC endpoint, increase timeout |

### Contract Interaction Failures

**Symptoms:** Transaction simulation fails, contract returns error

**Debugging:**
```bash
# Simulate transaction first
soroban contract invoke \
  --id <CONTRACT_ID> \
  --source <KEYPAIR> \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- \
  <function_name> \
  --arg1 value1 \
  --arg2 value2

# Check contract events
soroban contract events --id <CONTRACT_ID> --rpc-url ...
```

### Contract Upgrade Issues

**Symptoms:** Upgrade fails, storage migration issues

**Solutions:**
1. Implement `upgrade` function with storage migration
2. Test upgrade on testnet first
3. Use `soroban contract upgrade` with proper WASM
4. Verify storage layout compatibility

---

## Wallet Integration Issues

### Freighter Connection Issues

**Symptoms:** "Freighter not detected", connection hangs, account switching not detected

**Solutions:**
```javascript
// Check Freighter availability
if (typeof window.freighter === 'undefined') {
  // Prompt user to install
  window.open('https://freighter.app', '_blank');
}

// Listen for account changes
window.freighterApi.on('accountChange', (newAddress) => {
  // Update UI, refetch data
});

// Listen for network changes
window.freighterApi.on('networkChange', (network) => {
  // Validate network, switch if needed
});
```

### Transaction Signing Failures

**Symptoms:** User rejects transaction, signing times out, signature invalid

**Solutions:**
1. **User rejected** → Handle gracefully, show retry option
2. **Timeout** → Increase timeout, show pending state
3. **Invalid signature** → Verify network passphrase, transaction envelope

### Network Mismatch

**Symptoms:** Transactions fail, wrong network error

**Solution:**
```javascript
// Check and enforce correct network
const network = await freighterApi.getNetwork();
if (network !== expectedNetwork) {
  await freighterApi.switchNetwork(expectedNetwork);
}
```

---

## Indexer & Sync Issues

### Indexer Lagging Behind

**Symptoms:** Events not indexed, data stale, `indexer_state` shows old ledger

**Debugging:**
```bash
# Check indexer status
curl http://localhost:3001/indexer/status

# Check indexer logs
docker-compose logs indexer

# Manual catch-up
cd backend
npm run indexer:catchup -- --from-ledger <LEDGER>
```

**Solutions:**
- Increase indexer poll interval
- Check RPC endpoint health
- Restart indexer: `docker-compose restart indexer`
- Check for quarantined events

### Quarantined Events

**Symptoms:** Events stuck in quarantine, not processed

**Solutions:**
```bash
# View quarantined events
cd backend
npm run quarantine:list

# Retry quarantined events
npm run quarantine:retry -- --event-id <ID>

# Investigate root cause from event data
npm run quarantine:view -- --event-id <ID>
```

### Database Sync Issues

**Symptoms:** Indexer state diverges from database, duplicate events

**Solutions:**
1. Check `indexer_state` table for last processed ledger
2. Verify event processing idempotency
3. Re-sync from last known good ledger
4. Check for database constraint violations

---

## Deployment & Production Issues

### Staging Deployment Fails

**Symptoms:** GitHub Actions workflow fails, health checks fail

**Debugging:**
1. Check GitHub Actions logs
2. SSH to staging server
3. Run manual health checks

**Common Solutions:**

| Failure Point | Solution |
|---------------|----------|
| Image build fails | Check Dockerfile, build locally first |
| SSH connection fails | Verify secrets, check server firewall |
| Migration fails | Check migration logs, run manually on server |
| Health check fails | Check service logs, verify ports |

### Production Deployment Issues

**Pre-deployment Checklist:**
- [ ] All tests pass: `npm test` (backend & frontend)
- [ ] Linting passes: `npm run lint`
- [ ] Type checking passes: `npm run typecheck`
- [ ] Build succeeds: `npm run build`
- [ ] Database migrations tested on staging
- [ ] Contract upgrades tested on testnet
- [ ] Rollback plan documented

### Container Issues

**Symptoms:** Container crashes, OOM killed, restart loop

**Solutions:**
```bash
# Check container logs
docker logs <container_id>

# Check resource limits
docker stats

# Increase memory limit in docker-compose.yml
deploy:
  resources:
    limits:
      memory: 1G
    reservations:
      memory: 512M
```

### SSL/TLS Certificate Issues

**Symptoms:** Certificate expired, browser warnings, API calls fail

**Solutions:**
1. Check certificate expiry: `openssl x509 -in cert.pem -text -noout`
2. Renew via Let's Encrypt: `certbot renew`
3. Verify certificate chain
4. Update load balancer/reverse proxy config

---

## Performance Issues

### Slow API Responses

**Debugging:**
1. Enable request timing logs
2. Check database query performance: `EXPLAIN ANALYZE`
3. Check for N+1 query problems
4. Profile with `clinic.js` or similar

**Optimizations:**
- Add database indexes
- Implement caching (Redis)
- Use database connection pooling
- Paginate large responses
- Add `SELECT` field limiting

### High Memory Usage

**Symptoms:** OOM kills, slow performance, container restarts

**Solutions:**
```bash
# Profile Node.js memory
node --inspect=0.0.0.0:9229 dist/index.js
# Connect Chrome DevTools

# Check for memory leaks
# - Event listeners not removed
# - Caches growing unbounded
# - Large objects retained in closures
```

### Database Performance

**Common Issues:**
- Missing indexes → `EXPLAIN ANALYZE` slow queries
- Connection pool exhaustion → Increase pool size
- Lock contention → Optimize transactions, reduce lock scope
- Vacuum needed → Enable autovacuum, run manual `VACUUM ANALYZE`

---

## Security & Authentication Issues

### JWT Token Issues

**Symptoms:** Tokens rejected, expired tokens, signature verification fails

**Solutions:**
```bash
# Verify JWT secret consistency
# Backend: JWT_SECRET in .env
# Frontend: Same secret for token validation (if done client-side)

# Check token expiry
# Decode token at jwt.io (use test tokens only!)

# Rotate secrets
# 1. Add new JWT_SECRET_ROTATION
# 2. Deploy backend
# 3. Update frontend
# 4. Remove old secret after all tokens expired
```

### Rate Limiting / Brute Force

**Symptoms:** Legitimate users blocked, attack traffic high

**Solutions:**
- Implement progressive rate limiting
- Add CAPTCHA for auth endpoints
- Block suspicious IPs at firewall/WAF level
- Monitor auth logs for patterns

### CORS Issues

**Symptoms:** Browser blocks requests, `CORS policy` errors

**Solution:**
```env
# backend/.env
CORS_ALLOWED_ORIGINS=https://app.example.com,https://staging.example.com
# Must match frontend origin exactly (including protocol)
```

### Webhook Signature Verification Failures

**Symptoms:** Webhooks rejected, HMAC verification fails

**Solutions:**
1. Verify `WEBHOOK_SECRET` matches between sender and receiver
2. Check timestamp tolerance (default 5 minutes)
3. Ensure raw request body used for HMAC (not parsed JSON)
4. Check for proxy modifying request body

---

## Useful Commands Reference

### Docker Compose
```bash
# Start all services
docker-compose up -d

# Start with build
docker-compose up -d --build

# View logs
docker-compose logs -f [service]

# Restart service
docker-compose restart [service]

# Stop and remove volumes
docker-compose down -v

# Execute command in container
docker-compose exec backend sh
docker-compose exec db psql -U postgres -d remitlend
```

### Backend
```bash
cd backend
npm run dev          # Development server
npm run build        # Production build
npm run start        # Production server
npm run test         # Run tests
npm run test:watch   # Watch mode
npm run lint         # ESLint
npm run format       # Prettier
npm run migrate:up   # Run migrations
npm run migrate:down # Rollback last migration
npm run migrate:status # Check migration status
```

### Frontend
```bash
cd frontend
npm run dev          # Development server
npm run build        # Production build
npm run start        # Production server
npm run test         # Run tests
npm run lint         # ESLint
npm run typecheck    # TypeScript check
```

### Contracts
```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
cargo test
cargo fmt
cargo clippy
```

### Database
```bash
# Connect to database
docker-compose exec db psql -U postgres -d remitlend

# Common queries
\dt                    # List tables
\d+ <table>            # Describe table
SELECT * FROM scores LIMIT 10;
SELECT * FROM indexer_state;
```

---

## Escalation Contacts

| Issue Type | Primary Contact | Secondary Contact |
|------------|-----------------|-------------------|
| Infrastructure | DevOps Team | Backend Lead |
| Backend API | Backend Lead | Full Stack Engineer |
| Frontend | Frontend Lead | Full Stack Engineer |
| Smart Contracts | Contract Lead | Security Team |
| Database | Backend Lead | DevOps Team |
| Security | Security Team | All Leads |

---

## Related Documentation

- [Indexer Recovery Runbook](indexer-recovery.md)
- [Staging Deployment Runbook](README.md#staging-deployment-runbook)
- [Security Model](SECURITY-MODEL.md)
- [Environment Variables](ENVIRONMENT.md)
- [Webhook Integration](webhooks.md)
- [API Idempotency](wiki/api-idempotency.md)
- [JWT Revocation](wiki/jwt-revocation.md)

---

*Last updated: 2024*
*Version: 1.0*