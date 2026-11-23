"use client";

import { useLoans, usePoolStats } from "../../hooks/useApi";
import { OfferComparisonTable } from "../../components/offers/OfferComparisonTable";

export default function OffersPage() {
  const {
    data: loans = [],
    isLoading: loansLoading,
    isError: loansError,
  } = useLoans({ enabled: true });
  const {
    data: poolStats,
    isLoading: poolLoading,
    isError: poolError,
  } = usePoolStats({ enabled: true });

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <OfferComparisonTable
        loans={loans}
        poolStats={poolStats}
        isLoading={loansLoading || poolLoading}
        isError={loansError || poolError}
      />
    </main>
  );
}
