import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { StrKey, xdr } from '@stellar/stellar-sdk';
import { createSorobanRpcServer, type StellarNetwork } from '../config/stellar.js';
import { query } from '../db/connection.js';
import logger from '../utils/logger.js';

type VerificationStatus = 'pending' | 'match' | 'mismatch' | 'error' | 'missing_expected_hash';

interface DeployedContract {
  contractName: string;
  contractId: string;
}

export interface ContractWasmVerificationResult {
  contractId: string;
  contractName: string;
  status: VerificationStatus;
  expectedWasmHash: string | null;
  actualWasmHash: string | null;
  checkedAt: string | null;
  error: string | null;
}

const APP_ROOT = existsSync(resolve(process.cwd(), 'docs/deployed-contracts.md'))
  ? process.cwd()
  : resolve(process.cwd(), '..');
const REGISTRY_PATH = resolve(APP_ROOT, 'docs/deployed-contracts.md');
const HASHES_PATH = resolve(APP_ROOT, 'contracts/wasm-hashes.sha256');

export function parseDeployedContracts(
  registry: string,
  network: StellarNetwork,
): DeployedContract[] {
  const heading = network === 'mainnet' ? '## Mainnet' : '## Testnet';
  const start = registry.indexOf(heading);
  if (start < 0) return [];

  const nextHeading = registry.indexOf('\n## ', start + heading.length);
  const section = registry.slice(start, nextHeading < 0 ? undefined : nextHeading);
  const contracts: DeployedContract[] = [];
  const rowPattern = /^\|\s*`([^`]+)`\s*\|\s*`?(C[A-Z0-9]{55})`?\s*\|/gm;

  for (const match of section.matchAll(rowPattern)) {
    contracts.push({ contractName: match[1], contractId: match[2] });
  }
  return contracts;
}

export function parseExpectedWasmHashes(manifest: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const linePattern = /^([a-fA-F0-9]{64})\s{2,}(.+\.wasm)\s*$/gm;

  for (const match of manifest.matchAll(linePattern)) {
    hashes.set(basename(match[2], '.wasm'), match[1].toLowerCase());
  }
  return hashes;
}

async function getLedgerEntry(key: xdr.LedgerKey): Promise<xdr.LedgerEntry> {
  const result = await createSorobanRpcServer().getLedgerEntries(key);
  const ledgerEntry = result.entries[0]?.xdr;
  if (!ledgerEntry) {
    throw new Error('Ledger entry was not returned by Soroban RPC');
  }
  return xdr.LedgerEntry.fromXDR(ledgerEntry, 'base64');
}

export async function fetchDeployedWasmHash(contractId: string): Promise<string> {
  const contractAddress = xdr.ScAddress.scAddressTypeContract(StrKey.decodeContract(contractId));
  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractAddress,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const contractInstanceEntry = await getLedgerEntry(instanceKey);
  const wasmHash = contractInstanceEntry
    .data()
    .contractData()
    .val()
    .instance()
    .executable()
    .wasmHash();

  const wasmKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
  const wasmEntry = await getLedgerEntry(wasmKey);
  const wasmBytes = wasmEntry.data().contractCode().code();
  return createHash('sha256').update(wasmBytes).digest('hex');
}

class ContractWasmVerificationService {
  private getNetwork(): StellarNetwork {
    const network = (process.env.STELLAR_NETWORK ?? 'testnet').trim().toLowerCase();
    if (network !== 'testnet' && network !== 'mainnet') {
      throw new Error(`Unsupported STELLAR_NETWORK "${network}" for contract verification`);
    }
    return network;
  }

  async verifyDeployedContracts(): Promise<ContractWasmVerificationResult[]> {
    const [registry, manifest] = await Promise.all([
      readFile(REGISTRY_PATH, 'utf8'),
      readFile(HASHES_PATH, 'utf8'),
    ]);
    const deployedContracts = parseDeployedContracts(registry, this.getNetwork());
    const expectedHashes = parseExpectedWasmHashes(manifest);
    const results: ContractWasmVerificationResult[] = [];

    for (const contract of deployedContracts) {
      const expectedWasmHash = expectedHashes.get(contract.contractName) ?? null;
      let actualWasmHash: string | null = null;
      let status: VerificationStatus;
      let error: string | null = null;

      if (!expectedWasmHash) {
        status = 'missing_expected_hash';
        error = 'Expected WASM hash is missing from contracts/wasm-hashes.sha256';
      } else {
        try {
          actualWasmHash = await fetchDeployedWasmHash(contract.contractId);
          status = actualWasmHash === expectedWasmHash ? 'match' : 'mismatch';
        } catch (verificationError) {
          status = 'error';
          const errorType =
            verificationError instanceof Error ? verificationError.name : 'UnknownError';
          error = `Soroban RPC verification failed (${errorType})`;
        }
      }

      const persisted = await query(
        `INSERT INTO contract_verifications (
           contract_id, contract_name, expected_wasm_hash, actual_wasm_hash, status, error, checked_at
         ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING checked_at`,
        [
          contract.contractId,
          contract.contractName,
          expectedWasmHash,
          actualWasmHash,
          status,
          error,
        ],
      );
      const checkedAt = new Date(persisted.rows[0].checked_at).toISOString();
      const result = {
        contractId: contract.contractId,
        contractName: contract.contractName,
        status,
        expectedWasmHash,
        actualWasmHash,
        checkedAt,
        error,
      };
      results.push(result);

      if (status === 'mismatch' || status === 'missing_expected_hash') {
        logger.error('CRITICAL deployed contract WASM integrity discrepancy', {
          alert: 'contract_wasm_hash_mismatch',
          contractId: contract.contractId,
          contractName: contract.contractName,
          expectedWasmHash,
          actualWasmHash,
          status,
        });
      } else if (status === 'error') {
        logger.error('Deployed contract WASM verification failed', {
          contractId: contract.contractId,
          contractName: contract.contractName,
          error,
        });
      }
    }

    return results;
  }

  async getLatestResults(): Promise<ContractWasmVerificationResult[]> {
    const [registry, result] = await Promise.all([
      readFile(REGISTRY_PATH, 'utf8'),
      query(`
      SELECT DISTINCT ON (contract_id)
        contract_id, contract_name, status, expected_wasm_hash, actual_wasm_hash, checked_at, error
      FROM contract_verifications
      ORDER BY contract_id, checked_at DESC, id DESC
      `),
    ]);

    const latestByContractId = new Map<string, ContractWasmVerificationResult>(
      result.rows.map((row) => [
        row.contract_id,
        {
          contractId: row.contract_id,
          contractName: row.contract_name,
          status: row.status,
          expectedWasmHash: row.expected_wasm_hash,
          actualWasmHash: row.actual_wasm_hash,
          checkedAt: new Date(row.checked_at).toISOString(),
          error: row.error,
        },
      ]),
    );

    return parseDeployedContracts(registry, this.getNetwork()).map(
      ({ contractId, contractName }) =>
        latestByContractId.get(contractId) ?? {
          contractId,
          contractName,
          status: 'pending',
          expectedWasmHash: null,
          actualWasmHash: null,
          checkedAt: null,
          error: null,
        },
    );
  }
}

export const contractWasmVerificationService = new ContractWasmVerificationService();
