import { createHash, generateKeyPairSync } from 'node:crypto';
import { StatementManifestService, verifyStatementIntegrity } from '../statementManifestService.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const NOW = new Date('2026-06-15T12:00:00.000Z');

function makeService(options: Record<string, unknown> = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const queryFn = async (text: string, values: unknown[]) => {
    if (text.startsWith('SELECT')) {
      const row = rows.get(String(values[0]));
      return { rows: row ? [row] : [] };
    }
    const row = {
      manifest_id: values[0],
      subject_hash: values[4],
      manifest_json: values[7],
    };
    rows.set(String(values[0]), row);
    return { rows: [] };
  };

  return new StatementManifestService({
    privateKeyPem,
    keyId: 'test-key-1',
    pepper: 'test-subject-pepper',
    now: () => NOW,
    queryFn,
    ...options,
  });
}

const request = {
  sourceType: 'activity' as const,
  sourceCheckpoint: 'api:3:2026-06-15T11:59:00.000Z',
  statementDigest: 'a'.repeat(64),
  rowCount: 3,
  generatedAt: NOW.toISOString(),
};

const CSV = 'date,amount\n2026-06-15,10.0000\n';
const CSV_DIGEST = createHash('sha256').update(CSV).digest('hex');

describe('StatementManifestService', () => {
  it('issues a signed manifest and verifies the exact CSV bytes', async () => {
    const service = makeService();
    const validRequest = { ...request, statementDigest: CSV_DIGEST };
    const manifest = await service.issueManifest(validRequest, 'GACTOR');

    expect(manifest.schema).toBe('statement-manifest/v1');
    expect(manifest.manifestId).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.verification.keyId).toBe('test-key-1');
    expect(manifest.subjectHash).toMatch(/^[a-f0-9]{64}$/);

    const result = verifyStatementIntegrity(manifest, CSV, publicKeyPem);
    expect(result).toEqual({ signatureValid: true, digestMatches: true, valid: true });
    expect(JSON.stringify(manifest)).not.toContain('GACTOR');
    expect(JSON.stringify(manifest)).not.toContain(privateKeyPem);
  });

  it('detects tampered CSV bytes using only the public key', async () => {
    const service = makeService();
    const manifest = await service.issueManifest(
      { ...request, statementDigest: CSV_DIGEST },
      'GACTOR',
    );

    const result = verifyStatementIntegrity(
      manifest,
      CSV.replace('10.0000', '9999.0000'),
      publicKeyPem,
    );
    expect(result.signatureValid).toBe(true);
    expect(result.digestMatches).toBe(false);
    expect(result.valid).toBe(false);
  });

  it('detects tampered manifest fields', async () => {
    const service = makeService();
    const manifest = await service.issueManifest(
      { ...request, statementDigest: CSV_DIGEST },
      'GACTOR',
    );
    const tampered = { ...manifest, statement: { ...manifest.statement, rowCount: 999 } };

    const result = verifyStatementIntegrity(tampered, CSV, publicKeyPem);
    expect(result.signatureValid).toBe(false);
    expect(result.valid).toBe(false);
  });

  it('is idempotent for a repeated request', async () => {
    const service = makeService();
    const validRequest = { ...request, statementDigest: CSV_DIGEST };
    const first = await service.issueManifest(validRequest, 'GACTOR');
    const second = await service.issueManifest(validRequest, 'GACTOR');

    expect(second).toEqual(first);
  });

  it('rejects stale and future statement timestamps', async () => {
    const service = makeService();
    await expect(
      service.issueManifest(
        { ...request, generatedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString() },
        'GACTOR',
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      service.issueManifest(
        { ...request, generatedAt: new Date(NOW.getTime() + 2 * 60_000).toISOString() },
        'GACTOR',
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('fails closed when the issuance registry is unavailable', async () => {
    const service = makeService({
      queryFn: async () => {
        throw new Error('database down');
      },
    });
    await expect(service.issueManifest(request, 'GACTOR')).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it('fails closed when no valid signing key is configured', async () => {
    const service = makeService({ privateKeyPem: 'not-a-pem' });
    expect(service.isConfigured()).toBe(false);
    await expect(service.issueManifest(request, 'GACTOR')).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it('binds the manifest to the authenticated subject', async () => {
    const service = makeService();
    const first = await service.issueManifest(request, 'GACTOR_A');
    const second = await service.issueManifest(request, 'GACTOR_B');

    expect(first.subjectHash).not.toBe(second.subjectHash);
    expect(first.manifestId).not.toBe(second.manifestId);
  });
});
