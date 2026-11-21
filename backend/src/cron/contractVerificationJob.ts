import cron from 'node-cron';
import { contractVerificationService } from '../services/contractVerificationService.js';
import { contractWasmVerificationService } from '../services/contractWasmVerificationService.js';
import { jobMetricsService } from '../services/jobMetricsService.js';
import logger from '../utils/logger.js';

const BATCH_SIZE = 10;

let scheduledTask: cron.ScheduledTask | null = null;
let inFlight = false;

/**
 * Verifies deployed WASM integrity and polls Stellar explorer for unverified
 * contracts once nightly at 02:00 UTC.
 */
export function startContractVerificationCron() {
  if (scheduledTask) return;

  scheduledTask = cron.schedule(
    '0 2 * * *',
    async () => {
      if (inFlight) {
        logger
          .withContext()
          .warn('Contract verification cron skipped because a previous run is still in flight');
        return;
      }

      const startTime = Date.now();
      const jobName = 'contractVerificationCron';
      inFlight = true;

      try {
        const wasmResults = await contractWasmVerificationService.verifyDeployedContracts();
        const pending = await contractVerificationService.getUnverifiedContracts(BATCH_SIZE);
        let verifiedCount = 0;

        for (const contract of pending) {
          try {
            const verified = await contractVerificationService.checkStellarExplorerVerification(
              contract.contractId,
            );

            if (verified) {
              await contractVerificationService.markVerified(
                contract.contractId,
                contract.sourceCodeHash,
              );
              verifiedCount++;
            }

            await contractVerificationService.recordVerificationAttempt(
              contract.contractId,
              verified,
              verified ? 'Verified on Stellar explorer' : 'Not yet verified on Stellar explorer',
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await contractVerificationService.recordVerificationAttempt(
              contract.contractId,
              false,
              message,
            );
          }
        }

        const durationMs = Date.now() - startTime;
        jobMetricsService.recordSuccess(jobName, durationMs);
        logger
          .withContext()
          .info(
            `Contract verification check completed. WASM checked ${wasmResults.length}, explorer checked ${pending.length}, newly verified ${verifiedCount}.`,
          );
      } catch (error) {
        const durationMs = Date.now() - startTime;
        jobMetricsService.recordFailure(jobName, error as Error | string, durationMs);
        logger.withContext().error('Error in contract verification cron', { error });
      } finally {
        inFlight = false;
      }
    },
    { timezone: 'UTC' },
  );
}

export function stopContractVerificationCron(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.withContext().info('Contract verification cron stopped');
  }
}
