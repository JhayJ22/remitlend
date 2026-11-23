import cron from 'node-cron';
import {
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
} from '@stellar/stellar-sdk';
import { createSorobanRpcServer, getStellarNetworkPassphrase } from '../config/stellar.js';
import { jobMetricsService } from '../services/jobMetricsService.js';
import logger from '../utils/logger.js';

/**
 * Nightly governance storage sweep (#785).
 *
 * Calls the permissionless `sweep_expired(max_count)` entry point on the
 * multisig governance contract so TTL-expired proposals are purged and stop
 * accruing Soroban storage rent. Runs at 03:15 UTC by default to stay clear
 * of the hourly loan/verification jobs.
 *
 * Config:
 *   MULTISIG_GOVERNANCE_CONTRACT_ID   target contract (job is a no-op if unset)
 *   GOVERNANCE_SWEEP_SOURCE_SECRET    fee-paying account (falls back to LOAN_MANAGER_ADMIN_SECRET)
 *   GOVERNANCE_SWEEP_MAX_COUNT        proposals examined per call (default 50, contract caps at 100)
 *   GOVERNANCE_SWEEP_CRON             cron expression (default '15 3 * * *')
 */

const JOB_NAME = 'governanceSweepCron';
const DEFAULT_SCHEDULE = '15 3 * * *';
const DEFAULT_MAX_COUNT = 50;

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
let inFlight = false;

export interface GovernanceSweepResult {
  skipped?: string;
  txHash?: string;
  status?: string;
  removed?: number;
}

function getMaxCount(): number {
  const parsed = Number.parseInt(process.env.GOVERNANCE_SWEEP_MAX_COUNT ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_COUNT;
}

export async function runGovernanceSweep(
  server: rpc.Server = createSorobanRpcServer(),
): Promise<GovernanceSweepResult> {
  const contractId = process.env.MULTISIG_GOVERNANCE_CONTRACT_ID;
  if (!contractId) return { skipped: 'MULTISIG_GOVERNANCE_CONTRACT_ID not set' };

  const secret =
    process.env.GOVERNANCE_SWEEP_SOURCE_SECRET ?? process.env.LOAN_MANAGER_ADMIN_SECRET;
  if (!secret) return { skipped: 'no fee-paying secret configured' };

  const signer = Keypair.fromSecret(secret);
  const account = await server.getAccount(signer.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: getStellarNetworkPassphrase(),
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: 'sweep_expired',
        args: [nativeToScVal(getMaxCount(), { type: 'u32' })],
      }),
    )
    .setTimeout(30)
    .build();

  // Simulation tells us whether there is anything to purge; skip submission
  // (and the fee) when nothing is expired.
  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`sweep_expired simulation failed: ${simulation.error}`);
  }
  const simulatedRemoved = simulation.result?.retval
    ? Number(scValToNative(simulation.result.retval))
    : 0;
  if (simulatedRemoved === 0) return { removed: 0, skipped: 'nothing expired' };

  const prepared = rpc.assembleTransaction(tx, simulation).build();
  prepared.sign(signer);
  const send = await server.sendTransaction(prepared);
  if (send.status === 'ERROR') {
    throw new Error(`sweep_expired submission failed (hash ${send.hash})`);
  }

  const polled = await server.pollTransaction(send.hash, { attempts: 10 });
  const removed =
    polled.status === rpc.Api.GetTransactionStatus.SUCCESS && polled.returnValue
      ? Number(scValToNative(polled.returnValue))
      : undefined;

  return {
    txHash: send.hash,
    status: String(polled.status),
    ...(removed !== undefined ? { removed } : {}),
  };
}

export function startGovernanceSweepCron(): void {
  if (scheduledTask) return;
  const schedule = process.env.GOVERNANCE_SWEEP_CRON || DEFAULT_SCHEDULE;

  scheduledTask = cron.schedule(
    schedule,
    async () => {
      if (inFlight) {
        logger.withContext().warn('Governance sweep skipped: previous run still in flight');
        return;
      }
      inFlight = true;
      const startTime = Date.now();
      try {
        const result = await runGovernanceSweep();
        jobMetricsService.recordSuccess(JOB_NAME, Date.now() - startTime);
        logger.withContext().info('Governance expired-proposal sweep completed', { ...result });
      } catch (error) {
        jobMetricsService.recordFailure(JOB_NAME, error as Error | string, Date.now() - startTime);
        logger.withContext().error('Error in governance sweep cron', { error });
      } finally {
        inFlight = false;
      }
    },
    { timezone: 'UTC' },
  );
}

export function stopGovernanceSweepCron(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.withContext().info('Governance sweep cron stopped');
  }
}
