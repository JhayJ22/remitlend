import logger from '../utils/logger.js';
import pool from '../db/connection.js';

interface VerificationStatus {
  contractId: string;
  verified: boolean;
  verifiedAt?: string;
  sourceCodeHash: string;
  explorerUrl: string;
  error?: string;
}

/**
 * Service to manage automated contract verification on Stellar explorer.
 * Tracks verification status, stores verification metadata, and logs verification attempts.
 */
class ContractVerificationService {
  private readonly EXPLORER_BASE_URL = 'https://stellar.expert/explorer';
  private readonly VERIFICATION_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

  /**
   * Create verification record in database.
   * Each deployment creates a verification tracking entry.
   */
  async createVerificationRecord(
    contractId: string,
    contractName: string,
    sourceCodeHash: string,
    wasmHash: string,
  ): Promise<void> {
    try {
      await pool.query(
        `
        INSERT INTO contract_verification (contract_id, contract_name, source_code_hash, wasm_hash, verified, created_at)
        VALUES ($1, $2, $3, $4, false, NOW())
        ON CONFLICT (contract_id) DO UPDATE SET
          verified = false,
          verification_attempted_at = NULL,
          updated_at = NOW()
      `,
        [contractId, contractName, sourceCodeHash, wasmHash],
      );
      logger.info('Created verification record', { contractId, contractName });
    } catch (error) {
      logger.error('Error creating verification record', { contractId, error });
      throw error;
    }
  }

  /**
   * Get verification status for a contract.
   */
  async getVerificationStatus(contractId: string): Promise<VerificationStatus | null> {
    try {
      const result = await pool.query(
        `
        SELECT contract_id, verified, verified_at, source_code_hash
        FROM contract_verification
        WHERE contract_id = $1
      `,
        [contractId],
      );

      if (!result.rows.length) {
        return null;
      }

      const row = result.rows[0];
      return {
        contractId: row.contract_id,
        verified: row.verified,
        verifiedAt: row.verified_at,
        sourceCodeHash: row.source_code_hash,
        explorerUrl: this.getExplorerUrl(contractId),
      };
    } catch (error) {
      logger.error('Error getting verification status', { contractId, error });
      throw error;
    }
  }

  /**
   * Mark a contract as verified after successful verification.
   */
  async markVerified(contractId: string, sourceCodeHash: string): Promise<void> {
    try {
      await pool.query(
        `
        UPDATE contract_verification
        SET verified = true, verified_at = NOW(), updated_at = NOW()
        WHERE contract_id = $1 AND source_code_hash = $2
      `,
        [contractId, sourceCodeHash],
      );
      logger.info('Contract marked as verified', { contractId });
    } catch (error) {
      logger.error('Error marking contract verified', { contractId, error });
      throw error;
    }
  }

  /**
   * Record a verification attempt (successful or failed).
   * Tracks all attempts for auditing and troubleshooting.
   */
  async recordVerificationAttempt(
    contractId: string,
    success: boolean,
    message: string,
  ): Promise<void> {
    try {
      await pool.query(
        `
        INSERT INTO contract_verification_attempts (contract_id, success, message, attempted_at)
        VALUES ($1, $2, $3, NOW())
      `,
        [contractId, success, message],
      );
      logger.info('Recorded verification attempt', { contractId, success });
    } catch (error) {
      logger.error('Error recording verification attempt', { contractId, error });
      // Don't throw—verification tracking shouldn't block deployment
    }
  }

  /**
   * Check if a contract is verified on Stellar explorer.
   * This is a polling check that can be called periodically.
   */
  async checkStellarExplorerVerification(contractId: string): Promise<boolean> {
    try {
      // In production, this would make an API call to Stellar expert/explorer
      // For now, we track verification status in our database
      const status = await this.getVerificationStatus(contractId);
      return status?.verified ?? false;
    } catch (error) {
      logger.error('Error checking Stellar explorer verification', { contractId, error });
      return false;
    }
  }

  /**
   * Get Stellar explorer URL for the contract.
   */
  getExplorerUrl(contractId: string): string {
    const network = process.env.STELLAR_NETWORK_ENV || 'testnet';
    const networkPath = network === 'public' ? 'public' : 'testnet';
    return `${this.EXPLORER_BASE_URL}/${networkPath}/contract/${contractId}`;
  }

  /**
   * Get all unverified contracts pending verification.
   */
  async getUnverifiedContracts(limit: number = 100): Promise<
    Array<{
      contractId: string;
      contractName: string;
      createdAt: string;
    }>
  > {
    try {
      const result = await pool.query(
        `
        SELECT contract_id, contract_name, created_at
        FROM contract_verification
        WHERE verified = false
        ORDER BY created_at ASC
        LIMIT $1
      `,
        [limit],
      );
      return result.rows.map((row) => ({
        contractId: row.contract_id,
        contractName: row.contract_name,
        createdAt: row.created_at,
      }));
    } catch (error) {
      logger.error('Error getting unverified contracts', { error });
      throw error;
    }
  }

  /**
   * Get verification statistics for admin dashboard.
   */
  async getVerificationStats(): Promise<{
    total: number;
    verified: number;
    pending: number;
    verificationRate: number;
  }> {
    try {
      const result = await pool.query(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN verified = true THEN 1 ELSE 0 END) as verified
        FROM contract_verification
      `);

      const { total, verified } = result.rows[0];
      const pending = total - verified;
      const verificationRate = total > 0 ? Math.round((verified / total) * 100) : 0;

      return {
        total: parseInt(total),
        verified: parseInt(verified),
        pending,
        verificationRate,
      };
    } catch (error) {
      logger.error('Error getting verification stats', { error });
      throw error;
    }
  }
}

export const contractVerificationService = new ContractVerificationService();
