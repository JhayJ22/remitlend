'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@/context/WalletContext';
import { useTransactionPreview } from '@/context/TransactionPreviewContext';
import { useSSE } from '@/hooks/useSSE';
import { apiFetch } from '@/lib/api';
import { formatAmount, formatDuration } from '@/lib/format';

export interface LiquidatableLoan {
  id: string;
  borrower: string;
  borrower_score: number;
  outstanding_amount: string;
  collateral_nft_id: string;
  collateral_status: 'active' | 'seized';
  defaulted_at: string;
  liquidation_bonus_bps: number;
}

const KEEPER_ROLE = 'keeper';

function estimateBonus(loan: LiquidatableLoan): string {
  const outstanding = Number(loan.outstanding_amount) || 0;
  const bonus = (outstanding * loan.liquidation_bonus_bps) / 10_000;
  return formatAmount(bonus);
}

function timeSinceDefault(defaultedAt: string): string {
  const ms = Date.now() - new Date(defaultedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return formatDuration(ms);
}

export default function LiquidationsClient() {
  const { address, roles, signer } = useWallet();
  const { openPreview } = useTransactionPreview();
  const [loans, setLoans] = useState<LiquidatableLoan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const isKeeper = useMemo(
    () => Boolean(address) && (roles ?? []).includes(KEEPER_ROLE),
    [address, roles],
  );

  const loadLoans = useCallback(async () => {
    try {
      setError(null);
      const data = await apiFetch<LiquidatableLoan[]>(
        '/loans?status=defaulted&eligible_for_liquidation=true',
      );
      setLoans(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load liquidatable loans');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLoans();
  }, [loadLoans]);

  useSSE({
    events: ['loan.liquidated', 'loan.updated'],
    onEvent: (event) => {
      const updated = event.data as LiquidatableLoan | undefined;
      if (!updated?.id) {
        void loadLoans();
        return;
      }
      setLoans((prev) => {
        if (updated.collateral_status === 'seized') {
          return prev.map((loan) => (loan.id === updated.id ? { ...loan, ...updated } : loan));
        }
        return prev.map((loan) => (loan.id === updated.id ? { ...loan, ...updated } : loan));
      });
    },
  });

  const handleLiquidate = useCallback(
    async (loan: LiquidatableLoan) => {
      if (!isKeeper || !signer) return;
      setPendingId(loan.id);
      try {
        await openPreview({
          title: 'Liquidate loan',
          description: `Seize collateral NFT ${loan.collateral_nft_id} for loan ${loan.id}.`,
          contractCall: {
            contractId: loan.id,
            method: 'liquidate_loan',
            args: { loan_id: loan.id },
            signer,
          },
          onSuccess: () => {
            setLoans((prev) =>
              prev.map((item) =>
                item.id === loan.id ? { ...item, collateral_status: 'seized' } : item,
              ),
            );
          },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Liquidation failed');
      } finally {
        setPendingId(null);
      }
    },
    [isKeeper, signer, openPreview],
  );

  if (loading) {
    return <div className="p-6 text-sm text-gray-500">Loading liquidatable loans…</div>;
  }

  return (
    <div className="space-y-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Liquidations</h1>
        {!isKeeper && (
          <span className="text-xs text-gray-500">Read-only — keeper wallet required</span>
        )}
      </header>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loans.length === 0 ? (
        <p className="text-sm text-gray-500">No loans eligible for liquidation.</p>
      ) : (
        <ul className="space-y-3">
          {loans.map((loan) => (
            <li
              key={loan.id}
              className="rounded border border-gray-200 p-4"
              data-testid={`liquidation-row-${loan.id}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="space-y-1 text-sm">
                  <p className="font-medium">Loan {loan.id}</p>
                  <p className="text-gray-600">Borrower: {loan.borrower}</p>
                  <p className="text-gray-600">Score: {loan.borrower_score}</p>
                  <p className="text-gray-600">
                    Outstanding: {formatAmount(Number(loan.outstanding_amount))}
                  </p>
                  <p className="text-gray-600">
                    Collateral NFT {loan.collateral_nft_id}:{' '}
                    <span
                      className={
                        loan.collateral_status === 'seized'
                          ? 'font-medium text-red-600'
                          : 'font-medium text-green-600'
                      }
                      data-testid={`collateral-status-${loan.id}`}
                    >
                      {loan.collateral_status}
                    </span>
                  </p>
                  <p className="text-gray-600">
                    Defaulted: {timeSinceDefault(loan.defaulted_at)} ago
                  </p>
                  <p className="text-gray-600">Est. bonus: {estimateBonus(loan)}</p>
                </div>

                {isKeeper && loan.collateral_status !== 'seized' && (
                  <button
                    type="button"
                    className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                    disabled={pendingId === loan.id}
                    onClick={() => void handleLiquidate(loan)}
                  >
                    {pendingId === loan.id ? 'Liquidating…' : 'Liquidate'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
