import logger from '../utils/logger.js';
import { BackupService, initializeBackupService } from '../services/backupService.js';

let backupService: BackupService | null = null;

export async function initBackupJob(): Promise<void> {
  try {
    backupService = await initializeBackupService();
    logger.info('Backup job initialized');
  } catch (error) {
    logger.error('Failed to initialize backup job', { error });
  }
}

export async function runDailyBackup(): Promise<void> {
  if (!backupService) {
    logger.warn('Backup service not initialized');
    return;
  }

  try {
    logger.info('Starting daily database backup');

    const backup = await backupService.createLogicalBackup();

    const verified = await backupService.verifyBackup(backup.id);

    if (verified) {
      logger.info('Daily backup completed and verified', {
        backupId: backup.id,
        size: backup.size,
        location: backup.location,
      });
    } else {
      logger.warn('Daily backup completed but verification failed', {
        backupId: backup.id,
      });
    }
  } catch (error) {
    logger.error('Daily backup job failed', { error });
  }
}

export async function cleanupOldBackups(): Promise<void> {
  if (!backupService) {
    logger.warn('Backup service not initialized');
    return;
  }

  try {
    const backups = await backupService.listBackups();
    const now = new Date();
    const retentionMs = 30 * 24 * 60 * 60 * 1000;

    const oldBackups = backups.filter((b) => now.getTime() - b.timestamp.getTime() > retentionMs);

    if (oldBackups.length > 0) {
      logger.info('Found old backups to clean up', { count: oldBackups.length });

      for (const backup of oldBackups) {
        try {
          logger.info('Deleting old backup', { backupId: backup.id, age: backup.timestamp });
        } catch (error) {
          logger.error('Failed to delete old backup', { backupId: backup.id, error });
        }
      }
    }
  } catch (error) {
    logger.error('Cleanup job failed', { error });
  }
}
