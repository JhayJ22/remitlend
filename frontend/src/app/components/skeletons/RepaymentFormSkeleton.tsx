"use client";

import { Skeleton } from "../ui/Skeleton";

export function RepaymentFormSkeleton() {
  return (
    <section
      role="status"
      aria-label="Loading repayment form"
      className="mx-auto max-w-3xl space-y-6"
    >
      <header className="space-y-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </header>

      <div className="space-y-4 rounded-3xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-12 w-full rounded-2xl" />
          <Skeleton className="h-3 w-52" />
        </div>

        <Skeleton className="h-11 w-full rounded-full" />
      </div>

      <div className="rounded-3xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <Skeleton className="h-5 w-36" />
        <div className="mt-4 space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/6" />
        </div>
      </div>
    </section>
  );
}
