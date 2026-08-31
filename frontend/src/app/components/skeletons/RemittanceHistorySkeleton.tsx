"use client";

import { Skeleton } from "../ui/Skeleton";

export function RemittanceHistorySkeleton() {
  return (
    <main
      role="status"
      aria-label="Loading remittance history"
      className="mx-auto min-h-screen max-w-7xl space-y-8 p-8 lg:p-12"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-8 w-52" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-11 w-36 rounded-lg" />
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950"
          >
            <Skeleton className="mb-4 h-10 w-10 rounded-lg" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-2 h-8 w-20" />
            <Skeleton className="mt-2 h-3 w-28" />
          </div>
        ))}
      </section>

      <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-4 flex flex-wrap gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-20 rounded-full" />
          ))}
        </div>

        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="grid grid-cols-12 items-center gap-4 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800"
            >
              <Skeleton className="col-span-4 h-6 w-full" />
              <Skeleton className="col-span-2 h-6 w-full" />
              <Skeleton className="col-span-2 h-6 w-full" />
              <Skeleton className="col-span-2 h-6 w-full" />
              <Skeleton className="col-span-2 h-6 w-full" />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
