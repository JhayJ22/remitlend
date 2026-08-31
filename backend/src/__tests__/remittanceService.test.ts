import { jest } from '@jest/globals';
import { Account, Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';

const mockWithTransaction = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockQuery = jest.fn<
  (...args: unknown[]) => Promise<{
    rows: unknown[];
    rowCount: number;
    command: string;
    oid: number;
    fields: unknown[];
  }>
>();
const mockGetAccount = jest.fn<() => Promise<Account>>();

jest.unstable_mockModule('../db/connection.js', () => ({
  query: mockQuery,
  default: { query: mockQuery, connect: jest.fn(), end: jest.fn() },
}));

jest.unstable_mockModule('../db/transaction.js', () => ({
  withTransaction: mockWithTransaction,
}));

jest.unstable_mockModule('../config/stellar.js', () => ({
  getStellarNetworkPassphrase: () => Networks.TESTNET,
  createSorobanRpcServer: () => ({
    getAccount: mockGetAccount,
  }),
}));

const { remittanceService } = await import('../services/remittanceService.js');

const USDC_ISSUER = Keypair.random().publicKey();
const SENDER = Keypair.random().publicKey();
const RECIPIENT = Keypair.random().publicKey();

function mockRemittanceInsert() {
  mockWithTransaction.mockImplementation(async (...args: unknown[]) => {
    const callback = args[0] as (client: {
      query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
    }) => Promise<unknown>;
    const now = new Date();
    let xdrValue = '';
    const result = await callback({
      query: async (_sql: string, queryParams: unknown[]) => {
        xdrValue = queryParams[8] as string;
        return {
          rows: [
            {
              id: 'remit-1',
              sender_id: SENDER,
              recipient_address: RECIPIENT,
              amount: '25',
              from_currency: queryParams[4],
              to_currency: queryParams[5],
              memo: queryParams[6],
              status: 'pending',
              transaction_hash: null,
              xdr: xdrValue,
              created_at: now,
              updated_at: now,
            },
          ],
        };
      },
    });
    return result;
  });
}

describe('remittanceService.createRemittance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.STELLAR_USDC_ISSUER;
    delete process.env.STELLAR_EURC_ISSUER;
    delete process.env.STELLAR_PHP_ISSUER;
    mockGetAccount.mockResolvedValue(new Account(SENDER, '12345'));
    mockRemittanceInsert();
  });

  it('rejects unsupported source currencies', async () => {
    await expect(
      remittanceService.createRemittance({
        recipientAddress: RECIPIENT,
        amount: 25,
        fromCurrency: 'DOGE',
        toCurrency: 'USDC',
        memo: 'test',
        senderAddress: SENDER,
      }),
    ).rejects.toThrow('Unsupported currency: DOGE');
  });

  it('rejects token currencies when issuer is not configured', async () => {
    await expect(
      remittanceService.createRemittance({
        recipientAddress: RECIPIENT,
        amount: 25,
        fromCurrency: 'USDC',
        toCurrency: 'USDC',
        memo: 'test',
        senderAddress: SENDER,
      }),
    ).rejects.toThrow('Unsupported currency: USDC');
  });

  it('builds token transfer XDR for configured USDC remittances', async () => {
    process.env.STELLAR_USDC_ISSUER = USDC_ISSUER;

    const remittance = await remittanceService.createRemittance({
      recipientAddress: RECIPIENT,
      amount: 25,
      fromCurrency: 'USDC',
      toCurrency: 'USDC',
      memo: 'test',
      senderAddress: SENDER,
    });

    const tx = TransactionBuilder.fromXDR(remittance.xdr!, Networks.TESTNET);
    const payment = tx.operations[0] as {
      asset: { getCode: () => string; getIssuer: () => string };
    };

    expect(payment.asset.getCode()).toBe('USDC');
    expect(payment.asset.getIssuer()).toBe(USDC_ISSUER);
  });

  it('moves the same amount on-chain as the amount stored in the DB', async () => {
    process.env.STELLAR_USDC_ISSUER = USDC_ISSUER;

    const remittance = await remittanceService.createRemittance({
      recipientAddress: RECIPIENT,
      amount: 25,
      fromCurrency: 'USDC',
      toCurrency: 'USDC',
      memo: 'test',
      senderAddress: SENDER,
    });

    const tx = TransactionBuilder.fromXDR(remittance.xdr!, Networks.TESTNET);
    const payment = tx.operations[0] as { amount: string };

    expect(payment.amount).toBe('25.0000000');
    expect(remittance.amount).toBe(25);
  });

  it("builds the payment XDR from the sender's live Stellar sequence", async () => {
    const remittance = await remittanceService.createRemittance({
      recipientAddress: RECIPIENT,
      amount: 25,
      fromCurrency: 'XLM',
      toCurrency: 'XLM',
      memo: 'test',
      senderAddress: SENDER,
    });

    expect(mockGetAccount).toHaveBeenCalledWith(SENDER);

    const tx = TransactionBuilder.fromXDR(
      remittance.xdr!,
      Networks.TESTNET,
    ) as import('@stellar/stellar-sdk').Transaction;
    expect(tx.source).toBe(SENDER);
    expect(tx.sequence).toBe('12346');
  });
});

describe('remittanceService.getRemittances with filters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('filters remittances by status', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'remit-1',
          sender_id: SENDER,
          recipient_address: RECIPIENT,
          amount: '100',
          from_currency: 'USDC',
          to_currency: 'USDC',
          memo: null,
          status: 'completed',
          transaction_hash: 'tx123',
          xdr: 'xdr123',
          created_at: new Date('2024-03-01'),
          updated_at: new Date('2024-03-01'),
        },
      ],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: '1' }],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const result = await remittanceService.getRemittances(SENDER, 20, null, 'completed');

    expect(result.remittances).toHaveLength(1);
    expect(result.remittances[0]!.status).toBe('completed');
    expect(result.total).toBe(1);
  });

  it('filters remittances by date range', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'remit-2',
          sender_id: SENDER,
          recipient_address: RECIPIENT,
          amount: '50',
          from_currency: 'USDC',
          to_currency: 'USDC',
          memo: null,
          status: 'completed',
          transaction_hash: 'tx456',
          xdr: 'xdr456',
          created_at: new Date('2024-03-15'),
          updated_at: new Date('2024-03-15'),
        },
      ],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: '1' }],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const result = await remittanceService.getRemittances(
      SENDER,
      20,
      null,
      undefined,
      '2024-03-01',
      '2024-03-31',
    );

    expect(result.remittances).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('searches remittances by recipient address', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'remit-3',
          sender_id: SENDER,
          recipient_address: RECIPIENT,
          amount: '75',
          from_currency: 'USDC',
          to_currency: 'USDC',
          memo: null,
          status: 'completed',
          transaction_hash: 'tx789',
          xdr: 'xdr789',
          created_at: new Date('2024-03-10'),
          updated_at: new Date('2024-03-10'),
        },
      ],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: '1' }],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const result = await remittanceService.getRemittances(
      SENDER,
      20,
      null,
      undefined,
      undefined,
      undefined,
      RECIPIENT.substring(0, 10),
    );

    expect(result.remittances).toHaveLength(1);
    expect(result.remittances[0]!.recipientAddress).toBe(RECIPIENT);
  });

  it('combines multiple filters', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'remit-4',
          sender_id: SENDER,
          recipient_address: RECIPIENT,
          amount: '200',
          from_currency: 'USDC',
          to_currency: 'USDC',
          memo: 'payment',
          status: 'completed',
          transaction_hash: 'tx999',
          xdr: 'xdr999',
          created_at: new Date('2024-03-20'),
          updated_at: new Date('2024-03-20'),
        },
      ],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: '1' }],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const result = await remittanceService.getRemittances(
      SENDER,
      20,
      null,
      'completed',
      '2024-03-01',
      '2024-03-31',
      'payment',
    );

    expect(result.remittances).toHaveLength(1);
    expect(result.remittances[0]!.status).toBe('completed');
  });

  it('rejects invalid date formats', async () => {
    await expect(
      remittanceService.getRemittances(SENDER, 20, null, undefined, 'invalid-date'),
    ).rejects.toThrow("Invalid 'from' date format");
  });

  it('handles pagination with cursor', async () => {
    const remittances = Array.from({ length: 21 }, (_, i) => ({
      id: `remit-${i}`,
      sender_id: SENDER,
      recipient_address: RECIPIENT,
      amount: String(100 + i),
      from_currency: 'USDC',
      to_currency: 'USDC',
      memo: null,
      status: 'completed',
      transaction_hash: `tx${i}`,
      xdr: `xdr${i}`,
      created_at: new Date('2024-03-20'),
      updated_at: new Date('2024-03-20'),
    }));

    mockQuery.mockResolvedValueOnce({
      rows: remittances.slice(0, 21),
      command: 'SELECT',
      rowCount: 21,
      oid: 0,
      fields: [],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: '30' }],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const result = await remittanceService.getRemittances(SENDER, 20);

    expect(result.remittances).toHaveLength(20);
    expect(result.total).toBe(30);
    expect(result.nextCursor).toBe('2024-03-20T00:00:00.000Z');
  });

  it('returns null cursor when no more results', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'remit-1',
          sender_id: SENDER,
          recipient_address: RECIPIENT,
          amount: '100',
          from_currency: 'USDC',
          to_currency: 'USDC',
          memo: null,
          status: 'completed',
          transaction_hash: 'tx123',
          xdr: 'xdr123',
          created_at: new Date('2024-03-01'),
          updated_at: new Date('2024-03-01'),
        },
      ],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: '1' }],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const result = await remittanceService.getRemittances(SENDER, 20);

    expect(result.nextCursor).toBeNull();
  });

  it('rejects invalid cursor format', async () => {
    await expect(
      remittanceService.getRemittances(SENDER, 20, 'invalid-cursor'),
    ).rejects.toThrow('Invalid cursor');
  });

  it('handles empty result set', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [],
      command: 'SELECT',
      rowCount: 0,
      oid: 0,
      fields: [],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: '0' }],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const result = await remittanceService.getRemittances(SENDER);

    expect(result.remittances).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.nextCursor).toBeNull();
  });
});

describe('remittanceService.getRemittance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('retrieves a single remittance by ID', async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'remit-1',
          sender_id: SENDER,
          recipient_address: RECIPIENT,
          amount: '100',
          from_currency: 'USDC',
          to_currency: 'USDC',
          memo: 'test payment',
          status: 'completed',
          transaction_hash: 'tx123',
          xdr: 'xdr123',
          created_at: now,
          updated_at: now,
        },
      ],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const remittance = await remittanceService.getRemittance('remit-1');

    expect(remittance.id).toBe('remit-1');
    expect(remittance.senderId).toBe(SENDER);
    expect(remittance.amount).toBe(100);
    expect(remittance.memo).toBe('test payment');
    expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM remittances WHERE id = $1', ['remit-1']);
  });

  it('throws not found error when remittance does not exist', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [],
      command: 'SELECT',
      rowCount: 0,
      oid: 0,
      fields: [],
    });

    await expect(remittanceService.getRemittance('nonexistent')).rejects.toThrow(
      'Remittance not found',
    );
  });

  it('handles database errors gracefully', async () => {
    mockQuery.mockRejectedValueOnce(new Error('Database connection failed'));

    await expect(remittanceService.getRemittance('remit-1')).rejects.toThrow(
      'Failed to fetch remittance',
    );
  });

  it('converts amount to float correctly', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'remit-1',
          sender_id: SENDER,
          recipient_address: RECIPIENT,
          amount: '123.45',
          from_currency: 'USDC',
          to_currency: 'USDC',
          memo: null,
          status: 'pending',
          transaction_hash: null,
          xdr: 'xdr123',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const remittance = await remittanceService.getRemittance('remit-1');

    expect(remittance.amount).toBe(123.45);
    expect(typeof remittance.amount).toBe('number');
  });
});

describe('remittanceService.updateRemittanceStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates remittance status to completed with transaction hash', async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'remit-1',
          sender_id: SENDER,
          recipient_address: RECIPIENT,
          amount: '100',
          from_currency: 'USDC',
          to_currency: 'USDC',
          memo: 'payment',
          status: 'completed',
          transaction_hash: 'tx_abc123def456',
          xdr: 'xdr123',
          created_at: now,
          updated_at: now,
        },
      ],
      command: 'UPDATE',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const remittance = await remittanceService.updateRemittanceStatus(
      'remit-1',
      'completed',
      'tx_abc123def456',
    );

    expect(remittance.status).toBe('completed');
    expect(remittance.transactionHash).toBe('tx_abc123def456');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE remittances'),
      expect.arrayContaining(['completed', 'tx_abc123def456']),
    );
  });

  it('updates remittance status to failed with error message', async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'remit-1',
          sender_id: SENDER,
          recipient_address: RECIPIENT,
          amount: '100',
          from_currency: 'USDC',
          to_currency: 'USDC',
          memo: 'payment',
          status: 'failed',
          transaction_hash: null,
          error_message: 'Insufficient balance',
          xdr: 'xdr123',
          created_at: now,
          updated_at: now,
        },
      ],
      command: 'UPDATE',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const remittance = await remittanceService.updateRemittanceStatus(
      'remit-1',
      'failed',
      undefined,
      'Insufficient balance',
    );

    expect(remittance.status).toBe('failed');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE remittances'),
      expect.arrayContaining(['failed']),
    );
  });

  it('updates to processing status without transaction hash', async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'remit-1',
          sender_id: SENDER,
          recipient_address: RECIPIENT,
          amount: '100',
          from_currency: 'USDC',
          to_currency: 'USDC',
          memo: 'payment',
          status: 'processing',
          transaction_hash: null,
          xdr: 'xdr123',
          created_at: now,
          updated_at: now,
        },
      ],
      command: 'UPDATE',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    const remittance = await remittanceService.updateRemittanceStatus('remit-1', 'processing');

    expect(remittance.status).toBe('processing');
    expect(remittance.transactionHash).toBeNull();
  });

  it('throws not found error when remittance does not exist', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [],
      command: 'UPDATE',
      rowCount: 0,
      oid: 0,
      fields: [],
    });

    await expect(
      remittanceService.updateRemittanceStatus('nonexistent', 'completed'),
    ).rejects.toThrow('Remittance not found');
  });

  it('handles database errors gracefully', async () => {
    mockQuery.mockRejectedValueOnce(new Error('Database connection timeout'));

    await expect(
      remittanceService.updateRemittanceStatus('remit-1', 'completed', 'tx123'),
    ).rejects.toThrow('Failed to update remittance');
  });
});

describe('remittanceService validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.STELLAR_USDC_ISSUER;
    delete process.env.STELLAR_EURC_ISSUER;
    delete process.env.STELLAR_PHP_ISSUER;
    mockGetAccount.mockResolvedValue(new Account(SENDER, '12345'));
    mockRemittanceInsert();
  });

  it('rejects invalid recipient address', async () => {
    await expect(
      remittanceService.createRemittance({
        recipientAddress: 'invalid-address',
        amount: 25,
        fromCurrency: 'XLM',
        toCurrency: 'XLM',
        senderAddress: SENDER,
      }),
    ).rejects.toThrow('Invalid Stellar recipient address');
  });

  it('rejects invalid sender address', async () => {
    await expect(
      remittanceService.createRemittance({
        recipientAddress: RECIPIENT,
        amount: 25,
        fromCurrency: 'XLM',
        toCurrency: 'XLM',
        senderAddress: 'not-a-valid-address',
      }),
    ).rejects.toThrow('Invalid Stellar sender address');
  });

  it('accepts native XLM currency', async () => {
    const remittance = await remittanceService.createRemittance({
      recipientAddress: RECIPIENT,
      amount: 25,
      fromCurrency: 'XLM',
      toCurrency: 'XLM',
      memo: 'test',
      senderAddress: SENDER,
    });

    expect(remittance.fromCurrency).toBe('XLM');
    expect(remittance.toCurrency).toBe('XLM');
  });

  it('normalizes currency codes to uppercase', async () => {
    process.env.STELLAR_USDC_ISSUER = USDC_ISSUER;

    const remittance = await remittanceService.createRemittance({
      recipientAddress: RECIPIENT,
      amount: 25,
      fromCurrency: 'usdc',
      toCurrency: 'usdc',
      memo: 'test',
      senderAddress: SENDER,
    });

    expect(remittance.fromCurrency).toBe('USDC');
    expect(remittance.toCurrency).toBe('USDC');
  });

  it('handles missing memo gracefully', async () => {
    const remittance = await remittanceService.createRemittance({
      recipientAddress: RECIPIENT,
      amount: 25,
      fromCurrency: 'XLM',
      toCurrency: 'XLM',
      senderAddress: SENDER,
    });

    expect(remittance.memo).toBeUndefined();
  });
});
