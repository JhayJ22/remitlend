import type { Metadata } from "next";
import { Suspense } from "react";
import { buildPageMetadata } from "../../lib/metadata";
import { LoansListSkeleton } from "../../components/skeletons/LoansListSkeleton";
import { LoansPageClient } from "./LoansPageClient";

type PageProps = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;

  return buildPageMetadata({
    locale,
    path: "/loans",
    title: "Borrower Portfolio | RemitLend",
    description:
      "Review your active loans, repayment due dates, and overall borrower portfolio health.",
  });
}

export default function LoansPage() {
  return (
    <Suspense fallback={<LoansListSkeleton />}>
      <LoansPageClient />
    </Suspense>
  );
}
