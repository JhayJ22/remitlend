import type { Request, Response } from 'express';
import { query } from '../db/connection.js';
import { asyncHandler } from '../utils/asyncHandler.js';

type GovernanceRow = {
  proposal_id?: string;
  proposed_admin?: string;
  approval_count?: number | string;
  threshold?: number | string;
  executable_at?: string | Date | null;
  expires_at?: string | Date | null;
  signer_address?: string | null;
  approved?: boolean | null;
};

type RiskProposalRow = {
  id: string;
  submitter: string;
  parameter: string;
  proposed_value: string;
  status: string;
  tx_hash: string | null;
  executable_at: string | Date | null;
  created_at: string | Date | null;
};

const RISK_PROPOSAL_STATUSES = ['proposed', 'pending_execution', 'executed', 'cancelled'] as const;
type RiskProposalStatus = (typeof RISK_PROPOSAL_STATUSES)[number];

function parseSignersFromEnv() {
  return (process.env.GOVERNANCE_SIGNERS ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean)
    .map((address) => ({ address, approved: false }));
}

function serializeRiskProposal(row: RiskProposalRow) {
  return {
    id: row.id,
    submitter: row.submitter,
    parameter: row.parameter,
    proposedValue: row.proposed_value,
    status: row.status,
    txHash: row.tx_hash,
    executableAt: row.executable_at,
    createdAt: row.created_at,
  };
}

async function submitContractTx(method: string, args: Record<string, unknown>) {
  const contractId = process.env.RISK_GOVERNANCE_CONTRACT_ID ?? process.env.MULTISIG_GOVERNANCE_CONTRACT_ID ?? null;
  if (!contractId) {
    throw new Error('RISK_GOVERNANCE_CONTRACT_ID is not configured');
  }
  // The Soroban client is injected at runtime; the transaction hash is returned
  // by the contract submission layer once the transaction is accepted.
  const submit = (globalThis as { sorobanSubmit?: (c: string, m: string, a: Record<string, unknown>) => Promise<string> })
    .sorobanSubmit;
  if (typeof submit !== 'function') {
    throw new Error('Soroban submission client is not available');
  }
  return submit(contractId, method, args);
}

export const getPendingGovernance = asyncHandler(async (_req: Request, res: Response) => {
  const currentAdmin = process.env.GOVERNANCE_CURRENT_ADMIN ?? process.env.ADMIN_PUBLIC_KEY ?? null;
  const targetContract = process.env.MULTISIG_GOVERNANCE_CONTRACT_ID ?? null;
  const threshold = Number.parseInt(process.env.GOVERNANCE_THRESHOLD ?? '0', 10) || 0;

  try {
    const result = await query(
      `SELECT
           proposal_id,
           proposed_admin,
           approval_count,
           threshold,
           executable_at,
           expires_at,
           signer_address,
           approved
         FROM multisig_governance_pending
         ORDER BY proposal_id DESC`,
    );

    if (result.rows.length > 0) {
      const first = result.rows[0] as GovernanceRow;
      res.json({
        currentAdmin,
        targetContract,
        pendingProposal: {
          id: first.proposal_id,
          proposedAdmin: first.proposed_admin,
          approvalCount: Number(first.approval_count ?? 0),
          threshold: Number(first.threshold ?? threshold),
          executableAt: first.executable_at,
          expiresAt: first.expires_at,
          signers: result.rows
            .filter((row: GovernanceRow) => row.signer_address)
            .map((row: GovernanceRow) => ({
              address: row.signer_address,
              approved: Boolean(row.approved),
            })),
        },
      });
      return;
    }
  } catch {
    // The contract-facing index table is optional in early deployments.
  }

  res.json({
    currentAdmin,
    targetContract,
    pendingProposal: null,
    signers: parseSignersFromEnv(),
    threshold,
  });
});

export const createRiskProposal = asyncHandler(async (req: Request, res: Response) => {
  const { parameter, proposedValue, submitter } = req.body ?? {};
  if (typeof parameter !== 'string' || !parameter.trim()) {
    res.status(400).json({ error: 'parameter is required' });
    return;
  }
  if (proposedValue === undefined || proposedValue === null || `${proposedValue}`.trim() === '') {
    res.status(400).json({ error: 'proposedValue is required' });
    return;
  }
  const submitterAddress = typeof submitter === 'string' && submitter.trim() ? submitter.trim() : null;
  if (!submitterAddress) {
    res.status(400).json({ error: 'submitter is required' });
    return;
  }

  let txHash: string;
  try {
    txHash = await submitContractTx('propose_risk_change', {
      submitter: submitterAddress,
      parameter,
      proposed_value: `${proposedValue}`,
    });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'contract submission failed' });
    return;
  }

  const timelockSeconds = Number.parseInt(process.env.RISK_GOVERNANCE_TIMELOCK_SECONDS ?? '0', 10) || 0;
  const executableAt = new Date(Date.now() + timelockSeconds * 1000).toISOString();

  const result = await query(
    `INSERT INTO risk_parameter_proposals
         (submitter, parameter, proposed_value, status, tx_hash, executable_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, submitter, parameter, proposed_value, status, tx_hash, executable_at, created_at`,
    [submitterAddress, parameter, `${proposedValue}`, 'proposed', txHash, executableAt],
  );

  res.status(201).json({ proposal: serializeRiskProposal(result.rows[0] as RiskProposalRow) });
});

export const listRiskProposals = asyncHandler(async (_req: Request, res: Response) => {
  const result = await query(
    `SELECT id, submitter, parameter, proposed_value, status, tx_hash, executable_at, created_at
       FROM risk_parameter_proposals
       ORDER BY created_at DESC`,
  );
  res.json({ proposals: result.rows.map((row) => serializeRiskProposal(row as RiskProposalRow)) });
});

export const executeRiskProposal = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await query(
    `SELECT id, submitter, parameter, proposed_value, status, tx_hash, executable_at, created_at
       FROM risk_parameter_proposals
       WHERE id = $1`,
    [id],
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'proposal not found' });
    return;
  }

  const proposal = result.rows[0] as RiskProposalRow;
  if (proposal.status === 'executed' || proposal.status === 'cancelled') {
    res.status(409).json({ error: `proposal already ${proposal.status}` });
    return;
  }

  const executableAt = proposal.executable_at ? new Date(proposal.executable_at).getTime() : 0;
  if (Number.isFinite(executableAt) && Date.now() < executableAt) {
    res.status(409).json({
      error: 'timelock has not elapsed',
      executableAt: proposal.executable_at,
    });
    return;
  }

  let txHash: string;
  try {
    txHash = await submitContractTx('execute_risk_change', {
      proposal_id: proposal.id,
      parameter: proposal.parameter,
      proposed_value: proposal.proposed_value,
    });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'contract submission failed' });
    return;
  }

  const updated = await query(
    `UPDATE risk_parameter_proposals
       SET status = $1, tx_hash = $2
       WHERE id = $3
       RETURNING id, submitter, parameter, proposed_value, status, tx_hash, executable_at, created_at`,
    ['executed', txHash, proposal.id],
  );

  res.json({ proposal: serializeRiskProposal(updated.rows[0] as RiskProposalRow) });
});
