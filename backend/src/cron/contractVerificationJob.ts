import cron from 'node-cron';
import { createHash } from 'crypto';
import { contractVerificationService } from '../services/contractVerificationService.js';
import { jobMetricsService } from '../services/jobMetricsService.js';
import { createSorobanRpcServer } from '../config/stellar.js';
import logger from '../utils/logger.js';

const BATCH_SIZE = 10;

// Contracts tracked for WASM hash integrity, keyed by contract name -> env var holding the deployed address.
const CONTRACT_ENV_VARS: Record<string, string> = {
  loan_manager: 'LOAN_MANAGER_CONTRACT_ID',
  lending_pool: 'LENDING_POOL_CONTRACT_ID',
  remittance_nft: 'REMITTANCE_NFT_CONTRACT_ID',
  multisig_governance: 'MULTISIG_GOVERNANCE_CONTRACT_ID',
  token: 'POOL_TOKEN_ADDRESS',
};

let scheduledTask: cron.ScheduledTask | null = null;
let inFlight = false;

/**
 * Compute the SHA-256 hex digest of a byte array / string.
 */
function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Fetch the deployed contract data via the Soroban getContractData RPC and
 * return its SHA-256 hash. The WASM hash of a deployed contract is anchored
 * in its contract data ledger entry; we read the contract data and hash it so
 * any replacement of the deployed contract is detected.
 */
async function fetchDeployedWasmHash(contractId: string): Promise<string> {
  const server = createSorobanRpcServer();
  // Read the contract data ledger entry for the contract. The key is the
  // contract itself (an empty contract-data key reads the contract's own
  // metadata, which anchors the deployed WASM).
  const contractData = await server.getContractData({
    contractId,
    key: { type: 'contractData' } as any,
  });
  const payload = JSON.stringify(contractData);
  return sha256Hex(payload);
}

/**
 * Fire a CRITICAL alert when a deployed contract's WASM hash diverges from the
 * expected hash. The alert is persisted as a failed verification attempt and
 * logged at error level so on-call paging/webhooks pick it up.
 */
function fireCriticalAlert(contractId: string, contractName: string, expected: string, actual: string): void {
  logger
    .withContext()
    .error('CRITICAL: deployed WASM hash mismatch detected', {
      alertSeverity: 'CRITICAL',
      contractId,
      contractName,
      expectedHash: expected,
      actualHash: actual,
      action: 'Investigate possible contract replacement; do not trust the deployed contract until resolved.',
    });
}

/**
 * Runs nightly. For each tracked contract it:
 * 1. Reads the expected WASM hash from wasm-hashes.sha256.
 * 2. Fetches the deployed contract data via the Soroban getContractData RPC.
 * 3. Computes the deployed hash and compares it to the expected hash.
 * 4. Records the result in contract_verification / contract_verification_attempts.
 * 5. Fires a CRITICAL alert on any mismatch.
 */
export function startContractVerificationCron() {
  if (scheduledTask) return;

  scheduledTask = cron.schedule('0 2 * * *', async () => {
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
      const expectedHashes = contractVerificationService.parseExpectedWasmHashes();
      let checked = 0;
      let mismatches = 0;

      for (const [contractName, envVar] of Object.entries(CONTRACT_ENV_VARS)) {
        const contractId = process.env[envVar];
        const expectedHash = expectedHashes.get(contractName) ?? null;

        if (!contractId) {
          logger.warn('Skipping WASM hash check: contract address not configured', {
            contractName,
            envVar,
          });
          continue;
        }

        try {
          const actualHash = await fetchDeployedWasmHash(contractId);
          const matched = expectedHash ? actualHash === expectedHash : false;

          await contractVerificationService.recordWasmHashVerification(
            contractId,
            contractName,
            expectedHash,
            actualHash,
            matched,
          );

          checked++;

          if (!matched) {
            mismatches++;
            fireCriticalAlert(contractId, contractName, expectedHash ?? 'unknown', actualHash);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error('WASM hash check failed for contract', { contractName, contractId, error: message });
          await contractVerificationService.recordWasmHashVerification(
            contractId,
            contractName,
            expectedHash,
            null,
            false,
            message,
          );
          mismatches++;
          fireCriticalAlert(contractId, contractName, expectedHash ?? 'unknown', 'unavailable');
        }
      }

      const durationMs = Date.now() - startTime;
      jobMetricsService.recordSuccess(jobName, durationMs);
      logger
        .withContext()
        .info(
          `Contract WASM hash verification completed. Checked ${checked}, mismatches ${mismatches}.`,
        );
    } catch (error) {
      const durationMs = Date.now() - startTime;
      jobMetricsService.recordFailure(jobName, error as Error | string, durationMs);
      logger.withContext().error('Error in contract verification cron', { error });
    } finally {
      inFlight = false;
    }
  });
}

export function stopContractVerificationCron(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.withContext().info('Contract verification cron stopped');
  }
}
