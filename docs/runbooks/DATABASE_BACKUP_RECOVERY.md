# Database Backup & Point-in-Time Recovery (PITR) Runbook

## Overview

This runbook documents automated database backup procedures and point-in-time recovery (PITR) capabilities using PostgreSQL WAL archiving and logical backups stored in S3.

### Key Metrics
- **RPO (Recovery Point Objective)**: 5 minutes (WAL archive timeout)
- **RTO (Recovery Time Objective)**: 15-30 minutes (depending on backup size)
- **Retention**: 30 days (configurable via `BACKUP_RETENTION_DAYS`)

## Architecture

### Backup Types

1. **Logical Backups** (`pg_dump`)
   - Full database snapshots (compressed with gzip)
   - Executed daily at 2 AM UTC
   - Stored in S3 at `s3://bucket-name/backup-TIMESTAMP.sql.gz`
   - Restorable to any PostgreSQL version

2. **WAL Archiving**
   - Continuous write-ahead logs (WAL) archived to S3
   - Location: `s3://bucket-name/wal/`
   - Enables point-in-time recovery between logical backups
   - Archive timeout: 5 minutes

## Prerequisites

### Environment Variables

```env
# Backup Configuration
BACKUP_S3_BUCKET=remitlend-backups
BACKUP_S3_REGION=us-east-1
BACKUP_S3_ENDPOINT=https://s3.amazonaws.com  # optional for S3-compatible storage
BACKUP_RETENTION_DAYS=30

# Database Connection
DATABASE_NAME=remitlend
DB_USER=postgres
DB_PASSWORD=<secure-password>
DB_HOST=postgres.internal.example.com
DB_PORT=5432
```

### AWS Credentials

Ensure the application has IAM permissions for S3:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::remitlend-backups",
        "arn:aws:s3:::remitlend-backups/*"
      ]
    }
  ]
}
```

## Daily Backup Procedure

The backup job runs automatically every day at 2 AM UTC:

```bash
# Manual backup trigger (if needed)
curl -X POST http://localhost:3000/admin/backup/now \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json"
```

**Expected Output:**
```json
{
  "success": true,
  "backup": {
    "id": "backup-1693497600000",
    "timestamp": "2023-08-31T02:00:00Z",
    "size": 524288000,
    "type": "logical",
    "verified": true,
    "location": "s3://remitlend-backups/backup-1693497600000.sql.gz"
  }
}
```

## Restore Procedures

### Full Recovery from Latest Backup

1. **Identify the latest backup:**
   ```bash
   aws s3 ls s3://remitlend-backups/ --region us-east-1 | grep "\.sql\.gz$" | tail -1
   ```

2. **Stop the application:**
   ```bash
   systemctl stop remitlend
   ```

3. **Drop the current database:**
   ```bash
   dropdb -h postgres.internal.example.com -U postgres remitlend
   ```

4. **Restore from backup:**
   ```bash
   # Download and restore
   aws s3 cp s3://remitlend-backups/backup-1693497600000.sql.gz - \
     --region us-east-1 | gunzip | \
     psql -h postgres.internal.example.com -U postgres -d remitlend
   ```

5. **Verify recovery:**
   ```bash
   psql -h postgres.internal.example.com -U postgres -d remitlend \
     -c "SELECT COUNT(*) FROM loans; SELECT COUNT(*) FROM users;"
   ```

6. **Restart the application:**
   ```bash
   systemctl start remitlend
   ```

### Point-in-Time Recovery (PITR)

**Use Case:** Recover from data corruption or accidental deletion between backups.

1. **Prepare recovery environment:**
   ```bash
   mkdir -p /var/lib/postgresql/wal_restore
   aws s3 sync s3://remitlend-backups/wal/ /var/lib/postgresql/wal_restore/ \
     --region us-east-1
   ```

2. **Restore base backup to temporary database:**
   ```bash
   # Use same procedure as full recovery, but to a temporary DB
   createdb remitlend_pitr
   aws s3 cp s3://remitlend-backups/backup-1693497600000.sql.gz - \
     | gunzip | psql -U postgres -d remitlend_pitr
   ```

3. **Create recovery configuration:**
   ```bash
   cat > /var/lib/postgresql/recovery.conf << EOF
   restore_command = 'cp /var/lib/postgresql/wal_restore/%f %p'
   recovery_target_timeline = 'latest'
   recovery_target_xid = '1234567'  # or recovery_target_time = '2023-08-31 10:30:00'
   recovery_target_inclusive = false
   EOF
   ```

4. **Execute recovery:**
   ```bash
   sudo -u postgres pg_ctl -D /var/lib/postgresql/remitlend_pitr start
   ```

5. **Validate recovered data:**
   ```bash
   psql -U postgres -d remitlend_pitr \
     -c "SELECT COUNT(*) FROM loans; SELECT MAX(created_at) FROM loans;"
   ```

6. **Promote to primary (if needed):**
   ```bash
   psql -U postgres -d remitlend_pitr -c "SELECT pg_wal_replay_resume();"
   ```

## Monitoring & Alerts

### Check Backup Status

```bash
# List recent backups
curl http://localhost:3000/admin/backups/list \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .

# Expected output
{
  "success": true,
  "backups": [
    {
      "id": "backup-1693497600000",
      "timestamp": "2023-08-31T02:00:00Z",
      "size": 524288000,
      "verified": true
    }
  ]
}
```

### WAL Archiving Status

```bash
psql -U postgres remitlend -c "
  SELECT 
    name, setting FROM pg_settings 
  WHERE name LIKE 'archive%' OR name = 'wal_level';
"
```

### Backup Verification Job

The backup service automatically verifies each backup by:
1. Checking S3 object existence
2. Validating file integrity
3. Confirming gzip compression

Failed verifications are logged and trigger alerts.

## Disaster Recovery Checklist

- [ ] Identified backup to restore from
- [ ] Stopped application services
- [ ] Downloaded and verified backup file integrity
- [ ] Restored backup to temporary database
- [ ] Validated data completeness and consistency
- [ ] Promoted recovered database
- [ ] Restarted application
- [ ] Verified application connectivity
- [ ] Ran smoke tests
- [ ] Checked data consistency (row counts, recent transactions)

## Troubleshooting

### Backup Job Fails

```bash
# Check logs
docker logs remitlend-backend | grep -i backup

# Verify AWS credentials
aws s3 ls s3://remitlend-backups/ --region us-east-1

# Test manually
pg_dump -h localhost -U postgres remitlend | gzip | wc -c
```

### Restore Fails on Permission Denied

```bash
# Ensure PostgreSQL user owns data directory
sudo chown -R postgres:postgres /var/lib/postgresql/data

# Check WAL archive permissions
sudo chmod 700 /var/lib/postgresql/wal_archive
```

### WAL Files Not Archiving

```bash
# Check archive command in postgresql.conf
grep archive_command /var/lib/postgresql/data/postgresql.conf

# Test archive command manually
aws s3 cp /tmp/test s3://remitlend-backups/wal/test --region us-east-1

# Check PostgreSQL logs
psql -U postgres remitlend -c "SELECT * FROM pg_stat_archiver;"
```

## Additional Resources

- [PostgreSQL Backup & Restore](https://www.postgresql.org/docs/current/backup-dump.html)
- [WAL Archiving](https://www.postgresql.org/docs/current/continuous-archiving.html)
- [AWS S3 Documentation](https://docs.aws.amazon.com/s3/)
