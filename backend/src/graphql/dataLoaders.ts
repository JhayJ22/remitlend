import DataLoader from 'dataloader';
import { query } from '../db/connection.js';

interface Loan {
  id: string;
  borrower: string;
  amount: string;
  principal_paid: string;
  interest_paid: string;
  accrued_interest: string;
  interest_rate_bps: number;
  due_date: number;
  status: string;
  collateral_amount: string;
  created_at: string | null;
  updated_at: string | null;
}

interface Score {
  address: string;
  score: number;
  updated_at: string | null;
}

interface Remittance {
  id: string;
  recipient: string;
  amount: string;
  status: string;
  metadata_uri: string | null;
  created_at: string | null;
  updated_at: string | null;
}

const loanBatchLoader = new DataLoader<string, Loan | null>(async (loanIds) => {
  const result = await query(
    `SELECT * FROM loans WHERE id = ANY($1)`,
    [loanIds],
  );

  const loansMap = new Map<string, Loan>();
  result.rows.forEach((row) => {
    loansMap.set(row.id, row);
  });

  return loanIds.map((id) => loansMap.get(id) || null);
});

const scoreBatchLoader = new DataLoader<string, Score | null>(async (addresses) => {
  const result = await query(
    `SELECT address, score, updated_at FROM users WHERE address = ANY($1)`,
    [addresses],
  );

  const scoresMap = new Map<string, Score>();
  result.rows.forEach((row) => {
    scoresMap.set(row.address, {
      address: row.address,
      score: row.score,
      updated_at: row.updated_at,
    });
  });

  return addresses.map((addr) => scoresMap.get(addr) || null);
});

const remittanceBatchLoader = new DataLoader<string, Remittance | null>(async (remittanceIds) => {
  const result = await query(
    `SELECT * FROM remittance_events WHERE id = ANY($1)`,
    [remittanceIds],
  );

  const remittancesMap = new Map<string, Remittance>();
  result.rows.forEach((row) => {
    remittancesMap.set(row.id, row);
  });

  return remittanceIds.map((id) => remittancesMap.get(id) || null);
});

export interface DataLoaders {
  loanLoader: DataLoader<string, Loan | null>;
  scoreLoader: DataLoader<string, Score | null>;
  remittanceLoader: DataLoader<string, Remittance | null>;
}

export const createDataLoaders = (): DataLoaders => ({
  loanLoader: loanBatchLoader,
  scoreLoader: scoreBatchLoader,
  remittanceLoader: remittanceBatchLoader,
});

export const clearDataLoaders = () => {
  loanBatchLoader.clearAll();
  scoreBatchLoader.clearAll();
  remittanceBatchLoader.clearAll();
};
