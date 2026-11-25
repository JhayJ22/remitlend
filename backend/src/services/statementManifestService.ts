import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { query } from '../db/connection.js';
import logger from '../utils/logger.js';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import {
  STATEMENT_MANIFEST_SCHEMA_VERSION,
  type StatementManifestRequest,
  type StatementSourceType,
} from '../schemas/statementManifestSchemas.js';

export const STATEMENT_SIGNATURE_ALGORITHM = 'Ed25519';
export const STATEMENT_VERIFICATION_INSTRUCTIONS = '/docs/STATEMENT_VERIFICATION.md';
export const STATEMENT_MAX_AGE_MS = 5 * 60 * 1000;
export const STATEMENT_MAX_FUTURE_MS = 60 * 1000;

export interface StatementManifestSource {
  type: StatementSourceType;
  checkpoint: string;
}

export interface StatementManifestStatement {
  sha256: string;
  rowCount: number;
  generatedAt: string;
}

export interface StatementManifestVerification {
  algorithm: typeof STATEMENT_SIGNATURE_ALGORITHM;
  keyId: string;
  instructions: string;
}

export interface SignedStatementManifest {
  schema: typeof STATEMENT_MANIFEST_SCHEMA_VERSION;
  manifestId: string;
  source: StatementManifestSource;
  statement: StatementManifestStatement;
  subjectHash: string;
  issuedAt: string;
  verification: StatementManifestVerification;
  signature: string;
}

export interface StatementVerificationKey {
  schema: typeof STATEMENT_MANIFEST_SCHEMA_VERSION;
  algorithm: typeof STATEMENT_SIGNATURE_ALGORITHM;
  keyId: string;
  publicKeyPem: string;
  instructions: string;
}

export interface StatementIntegrityResult {
  signatureValid: boolean;
  digestMatches: boolean;
  valid: boolean;
}

interface QueryResultLike {
  rows: Array<Record<string, unknown>>;
}

export type StatementQueryFn = (text: string, values: unknown[]) => Promise<QueryResultLike>;

export interface StatementManifestDeps {
  privateKeyPem?: string;
  keyId?: string;
  queryFn?: StatementQueryFn;
  now?: () => Date;
  pepper?: string;
  maxAgeMs?: number;
}

interface IssuanceRow {
  manifest_id: string;
  subject_hash: string;
  manifest_json: string;
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function parsePublicKeyPem(privateKeyPem: string): string {
  const privateKey = createPrivateKey(privateKeyPem);
  return createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
}

function ephemeralPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

export class StatementManifestService {
  private readonly privateKey: KeyObject | null;
  private readonly publicKeyPem: string | null;
  private readonly keyId: string;
  private readonly queryFn: StatementQueryFn;
  private readonly now: () => Date;
  private readonly pepper: string;
  private readonly maxAgeMs: number;

  constructor(deps: StatementManifestDeps = {}) {
    this.keyId = deps.keyId ?? process.env.STATEMENT_SIGNING_KEY_ID ?? 'statement-signing-default';
    this.queryFn = deps.queryFn ?? ((text, values) => query(text, values));
    this.now = deps.now ?? (() => new Date());
    const configuredPepper = deps.pepper ?? process.env.STATEMENT_SUBJECT_PEPPER;
    this.pepper = configuredPepper ?? randomBytes(32).toString('hex');
    this.maxAgeMs = deps.maxAgeMs ?? STATEMENT_MAX_AGE_MS;

    if (!configuredPepper && process.env.NODE_ENV === 'production') {
      logger.warn('Statement subject pepper is ephemeral; configure STATEMENT_SUBJECT_PEPPER');
    }

    const configuredPem = deps.privateKeyPem ?? process.env.STATEMENT_SIGNING_PRIVATE_KEY_PEM;
    const pem =
      configuredPem ??
      (process.env.NODE_ENV === 'production' ? undefined : ephemeralPrivateKeyPem());

    if (!pem) {
      this.privateKey = null;
      this.publicKeyPem = null;
      logger.error('Statement signing key is not configured; manifest issuance is disabled');
      return;
    }

    try {
      this.privateKey = createPrivateKey(pem);
      this.publicKeyPem = parsePublicKeyPem(pem);
    } catch {
      this.privateKey = null;
      this.publicKeyPem = null;
      logger.error('Statement signing key is invalid; manifest issuance is disabled');
    }
  }

  isConfigured(): boolean {
    return this.privateKey !== null && this.publicKeyPem !== null;
  }

  getVerificationKey(): StatementVerificationKey {
    if (!this.publicKeyPem) {
      throw AppError.serviceUnavailable(
        'Statement verification key is unavailable',
        ErrorCode.SERVICE_UNAVAILABLE,
      );
    }

    return {
      schema: STATEMENT_MANIFEST_SCHEMA_VERSION,
      algorithm: STATEMENT_SIGNATURE_ALGORITHM,
      keyId: this.keyId,
      publicKeyPem: this.publicKeyPem,
      instructions: STATEMENT_VERIFICATION_INSTRUCTIONS,
    };
  }

  deriveSubjectHash(wallet: string, at: Date = this.now()): string {
    const day = at.toISOString().slice(0, 10);
    return sha256(`${this.pepper}\n${day}\n${wallet}`);
  }

  async issueManifest(
    input: StatementManifestRequest,
    actor: string,
  ): Promise<SignedStatementManifest> {
    const now = this.now();
    const generatedAt = new Date(input.generatedAt).getTime();

    if (generatedAt > now.getTime() + STATEMENT_MAX_FUTURE_MS) {
      throw AppError.badRequest(
        'Statement timestamp is in the future',
        ErrorCode.VALIDATION_ERROR,
        'generatedAt',
      );
    }

    if (now.getTime() - generatedAt > this.maxAgeMs) {
      throw AppError.badRequest(
        'Statement timestamp is stale',
        ErrorCode.VALIDATION_ERROR,
        'generatedAt',
      );
    }

    const verificationKey = this.getVerificationKey();
    if (!this.privateKey) {
      throw AppError.serviceUnavailable(
        'Statement signing key is unavailable',
        ErrorCode.SERVICE_UNAVAILABLE,
      );
    }

    const issuedAtDate = new Date(generatedAt);
    const subjectHash = this.deriveSubjectHash(actor, issuedAtDate);
    const unsigned: Omit<SignedStatementManifest, 'manifestId' | 'verification' | 'signature'> = {
      schema: STATEMENT_MANIFEST_SCHEMA_VERSION,
      source: { type: input.sourceType, checkpoint: input.sourceCheckpoint },
      statement: {
        sha256: input.statementDigest,
        rowCount: input.rowCount,
        generatedAt: input.generatedAt,
      },
      subjectHash,
      issuedAt: issuedAtDate.toISOString(),
    };
    const manifestId = sha256(canonical(unsigned));

    const existing = await this.findIssuance(manifestId);
    if (existing) {
      if (existing.subject_hash !== subjectHash) {
        throw AppError.forbidden(
          'Statement manifest belongs to a different subject',
          ErrorCode.FORBIDDEN,
        );
      }
      return JSON.parse(existing.manifest_json) as SignedStatementManifest;
    }

    const verification: StatementManifestVerification = {
      algorithm: STATEMENT_SIGNATURE_ALGORITHM,
      keyId: verificationKey.keyId,
      instructions: STATEMENT_VERIFICATION_INSTRUCTIONS,
    };
    const unsignedManifest = { ...unsigned, manifestId, verification };
    const signature = sign(
      null,
      Buffer.from(canonical(unsignedManifest)),
      this.privateKey,
    ).toString('base64');
    const manifest: SignedStatementManifest = { ...unsignedManifest, signature };
    const serialized = canonical(manifest);

    try {
      await this.queryFn(
        `INSERT INTO statement_manifest_issuances
           (manifest_id, key_id, source_type, schema_version, subject_hash, row_count, issued_at, manifest_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (manifest_id) DO NOTHING`,
        [
          manifestId,
          this.keyId,
          input.sourceType,
          STATEMENT_MANIFEST_SCHEMA_VERSION,
          subjectHash,
          input.rowCount,
          issuedAtDate,
          serialized,
        ],
      );
    } catch (error) {
      logger.error('Failed to persist statement manifest issuance', { error, manifestId });
      throw AppError.serviceUnavailable(
        'Statement manifest could not be recorded',
        ErrorCode.SERVICE_UNAVAILABLE,
      );
    }

    const persisted = await this.findIssuance(manifestId);
    if (persisted && persisted.subject_hash === subjectHash) {
      return JSON.parse(persisted.manifest_json) as SignedStatementManifest;
    }

    return manifest;
  }

  private async findIssuance(manifestId: string): Promise<IssuanceRow | null> {
    let result: QueryResultLike;
    try {
      result = await this.queryFn(
        'SELECT manifest_id, subject_hash, manifest_json FROM statement_manifest_issuances WHERE manifest_id = $1',
        [manifestId],
      );
    } catch (error) {
      logger.error('Failed to load statement manifest issuance', { error, manifestId });
      throw AppError.serviceUnavailable(
        'Statement manifest registry is unavailable',
        ErrorCode.SERVICE_UNAVAILABLE,
      );
    }

    const row = result.rows[0];
    if (!row) return null;

    return {
      manifest_id: String(row.manifest_id),
      subject_hash: String(row.subject_hash),
      manifest_json: String(row.manifest_json),
    };
  }
}

export const statementManifestService = new StatementManifestService();

export function verifyStatementIntegrity(
  manifest: SignedStatementManifest,
  statement: string | Buffer,
  publicKeyPem: string,
): StatementIntegrityResult {
  const { signature, ...signedPayload } = manifest;
  let signatureValid = false;

  try {
    const publicKey = createPublicKey(publicKeyPem);
    signatureValid = verify(
      null,
      Buffer.from(canonical(signedPayload)),
      publicKey,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    signatureValid = false;
  }

  const digestMatches = sha256(statement) === manifest.statement.sha256;
  return {
    signatureValid,
    digestMatches,
    valid: signatureValid && digestMatches,
  };
}
