import { execSync } from 'child_process';
import logger from '../utils/logger.js';

export interface BackupInfo {
  id: string;
  timestamp: Date;
  size: number;
  type: 'logical' | 'wal';
  verified: boolean;
  location: string;
}

export interface BackupConfig {
  s3Bucket: string;
  s3Region: string;
  s3Endpoint?: string;
  database: string;
  dbUser: string;
  dbPassword: string;
  dbHost: string;
  dbPort: number;
  retentionDays: number;
}

export class BackupService {
  private config: BackupConfig;

  constructor(config: BackupConfig) {
    this.config = config;
  }

  async createLogicalBackup(): Promise<BackupInfo> {
    const timestamp = new Date();
    const backupId = `backup-${timestamp.getTime()}`;

    try {
      logger.info('Starting logical backup', { backupId });

      const backupFile = `/tmp/${backupId}.sql.gz`;
      const env = {
        ...process.env,
        PGPASSWORD: this.config.dbPassword,
      };

      execSync(
        `pg_dump -h ${this.config.dbHost} -p ${this.config.dbPort} -U ${this.config.dbUser} -d ${this.config.database} | gzip > ${backupFile}`,
        { env, stdio: 'pipe' },
      );

      const backupSize = await this.getFileSize(backupFile);

      await this.uploadToS3(backupFile, backupId);

      logger.info('Logical backup completed', {
        backupId,
        size: backupSize,
        location: `s3://${this.config.s3Bucket}/${backupId}.sql.gz`,
      });

      return {
        id: backupId,
        timestamp,
        size: backupSize,
        type: 'logical',
        verified: false,
        location: `s3://${this.config.s3Bucket}/${backupId}.sql.gz`,
      };
    } catch (error) {
      logger.error('Logical backup failed', { backupId, error });
      throw error;
    }
  }

  async enableWalArchiving(): Promise<void> {
    const walDir = '/var/lib/postgresql/wal_archive';

    try {
      logger.info('Enabling WAL archiving');

      execSync(`mkdir -p ${walDir} && chmod 700 ${walDir}`);

      const archiveCommand = `aws s3 cp %p s3://${this.config.s3Bucket}/wal/%f`;

      const sqlCmd = `
        ALTER SYSTEM SET wal_level = replica;
        ALTER SYSTEM SET archive_mode = on;
        ALTER SYSTEM SET archive_command = '${archiveCommand}';
        ALTER SYSTEM SET archive_timeout = 300;
        SELECT pg_ctl('reload', 'fast');
      `;

      const env = {
        ...process.env,
        PGPASSWORD: this.config.dbPassword,
      };

      execSync(
        `psql -h ${this.config.dbHost} -p ${this.config.dbPort} -U ${this.config.dbUser} -d ${this.config.database} -c "${sqlCmd}"`,
        { env, stdio: 'pipe' },
      );

      logger.info('WAL archiving enabled');
    } catch (error) {
      logger.error('Failed to enable WAL archiving', { error });
      throw error;
    }
  }

  async verifyBackup(backupId: string): Promise<boolean> {
    try {
      logger.info('Verifying backup', { backupId });

      const s3Key = `${backupId}.sql.gz`;
      const result = execSync(
        `aws s3 ls s3://${this.config.s3Bucket}/${s3Key} --region ${this.config.s3Region}`,
        { stdio: 'pipe' },
      ).toString();

      const exists = result.includes(s3Key);

      if (exists) {
        logger.info('Backup verified', { backupId });
        return true;
      }

      logger.warn('Backup verification failed', { backupId });
      return false;
    } catch (error) {
      logger.error('Backup verification error', { backupId, error });
      return false;
    }
  }

  async restoreFromBackup(backupId: string, targetDb?: string): Promise<void> {
    const targetDatabase = targetDb || `${this.config.database}_restored`;

    try {
      logger.info('Starting backup restore', { backupId, targetDatabase });

      const backupFile = `/tmp/${backupId}-restore.sql.gz`;

      execSync(
        `aws s3 cp s3://${this.config.s3Bucket}/${backupId}.sql.gz ${backupFile} --region ${this.config.s3Region}`,
        { stdio: 'pipe' },
      );

      const env = {
        ...process.env,
        PGPASSWORD: this.config.dbPassword,
      };

      execSync(
        `dropdb -h ${this.config.dbHost} -p ${this.config.dbPort} -U ${this.config.dbUser} ${targetDatabase} || true`,
        { env },
      );

      execSync(
        `createdb -h ${this.config.dbHost} -p ${this.config.dbPort} -U ${this.config.dbUser} ${targetDatabase}`,
        { env },
      );

      execSync(
        `gunzip -c ${backupFile} | psql -h ${this.config.dbHost} -p ${this.config.dbPort} -U ${this.config.dbUser} -d ${targetDatabase}`,
        { env, stdio: 'pipe' },
      );

      logger.info('Backup restore completed', { backupId, targetDatabase });
    } catch (error) {
      logger.error('Backup restore failed', { backupId, error });
      throw error;
    }
  }

  async listBackups(): Promise<BackupInfo[]> {
    try {
      const result = execSync(
        `aws s3 ls s3://${this.config.s3Bucket}/ --region ${this.config.s3Region} --recursive | grep "\\.sql\\.gz$"`,
        { stdio: 'pipe' },
      ).toString();

      const backups: BackupInfo[] = result
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const parts = line.split(/\s+/);
          const date = new Date(`${parts[0]} ${parts[1]}`);
          const size = parseInt(parts[2], 10);
          const key = parts.slice(3).join(' ');
          const id = key.replace('.sql.gz', '').split('/').pop() || '';

          return {
            id,
            timestamp: date,
            size,
            type: 'logical' as const,
            verified: true,
            location: `s3://${this.config.s3Bucket}/${key}`,
          };
        });

      return backups.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    } catch (error) {
      logger.error('Failed to list backups', { error });
      return [];
    }
  }

  private async uploadToS3(filePath: string, backupId: string): Promise<void> {
    const s3Key = `${backupId}.sql.gz`;

    execSync(
      `aws s3 cp ${filePath} s3://${this.config.s3Bucket}/${s3Key} --region ${this.config.s3Region}`,
      { stdio: 'pipe' },
    );

    execSync(`rm -f ${filePath}`);
  }

  private async getFileSize(filePath: string): Promise<number> {
    const result = execSync(`stat -f%z ${filePath} 2>/dev/null || stat -c%s ${filePath}`, {
      stdio: 'pipe',
    }).toString();
    return parseInt(result.trim(), 10);
  }
}

export async function initializeBackupService(): Promise<BackupService> {
  const config: BackupConfig = {
    s3Bucket: process.env.BACKUP_S3_BUCKET || '',
    s3Region: process.env.BACKUP_S3_REGION || 'us-east-1',
    s3Endpoint: process.env.BACKUP_S3_ENDPOINT,
    database: process.env.DATABASE_NAME || 'remitlend',
    dbUser: process.env.DB_USER || 'postgres',
    dbPassword: process.env.DB_PASSWORD || '',
    dbHost: process.env.DB_HOST || 'localhost',
    dbPort: parseInt(process.env.DB_PORT || '5432', 10),
    retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10),
  };

  if (!config.s3Bucket) {
    throw new Error('BACKUP_S3_BUCKET environment variable is required');
  }

  const service = new BackupService(config);
  await service.enableWalArchiving();
  return service;
}
