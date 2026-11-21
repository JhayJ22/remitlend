"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChevronRight, Home } from "lucide-react";
import { getSiteUrl } from "../../lib/metadata";

const localeSegments = new Set(["en", "es", "tl"]);

const segmentKeys: Record<string, string> = {
  activity: "activity",
  admin: "admin",
  analytics: "analytics",
  disputes: "disputes",
  governance: "governance",
  kingdom: "kingdom",
  loans: "loans",
  lend: "lend",
  liquidations: "liquidations",
  notifications: "notifications",
  repay: "repay",
  remittances: "remittances",
  "request-loan": "requestLoan",
  "send-remittance": "sendRemittance",
  settings: "settings",
  wallet: "wallet",
  "transaction-preview-demo": "transactionPreview",
  "ui-demo": "uiDemo",
};

function toTitleCase(value: string) {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function Breadcrumbs() {
  const pathname = usePathname();
  const t = useTranslations("Breadcrumbs");

  if (!pathname || pathname === "/") {
    return null;
  }

  const allSegments = pathname.split("/").filter(Boolean);
  const locale = allSegments[0] && localeSegments.has(allSegments[0]) ? allSegments[0] : null;
  const segments = locale ? allSegments.slice(1) : allSegments;

  if (segments.length < 2) {
    return null;
  }

  const baseHref = locale ? `/${locale}` : "/";
  const getContextualLabel = (
    segment: string,
    previousSegment: string | undefined,
    isLast: boolean,
  ) => {
    if (isLast && previousSegment && ["loans", "repay"].includes(previousSegment)) {
      return t("loanNumber", { id: segment });
    }

    if (isLast && previousSegment === "disputes") {
      return t("disputeNumber", { id: segment });
    }

    const key = segmentKeys[segment];
    return key ? t(`segments.${key}`) : toTitleCase(segment);
  };
  const items = segments.map((segment, index) => {
    const fullSegments = locale
      ? [locale, ...segments.slice(0, index + 1)]
      : segments.slice(0, index + 1);
    const href = `/${fullSegments.join("/")}`;
    const isCurrent = index === segments.length - 1;

    return {
      href,
      isCurrent,
      label: getContextualLabel(segment, segments[index - 1], isCurrent),
    };
  });

  const siteUrl = getSiteUrl();
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: t("segments.dashboard"),
        item: new URL(baseHref, siteUrl).toString(),
      },
      ...items.map((item, index) => ({
        "@type": "ListItem",
        position: index + 2,
        name: item.label,
        item: new URL(item.href, siteUrl).toString(),
      })),
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
        }}
      />
      <nav
        aria-label={t("navigationLabel")}
        className="mb-4 overflow-x-auto rounded-2xl border border-zinc-200 bg-white/80 px-3 py-2 shadow-sm shadow-zinc-200/40 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/70 dark:shadow-none sm:mb-6 sm:px-4"
      >
        <ol className="flex min-w-max items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
          <li>
            <Link
              href={baseHref}
              className="inline-flex items-center gap-2 rounded-full px-2 py-1 font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-zinc-50"
            >
              <Home className="h-4 w-4" />
              <span className="hidden sm:inline">{t("segments.dashboard")}</span>
            </Link>
          </li>
          {items.map((item) => (
            <li key={item.href} className="flex items-center gap-1">
              <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
              {item.isCurrent ? (
                <span
                  aria-current="page"
                  aria-label={t("currentPage")}
                  className="rounded-full bg-indigo-50 px-3 py-1 font-semibold text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                >
                  {item.label}
                </span>
              ) : (
                <Link
                  href={item.href}
                  className="rounded-full px-3 py-1 font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-zinc-50"
                >
                  {item.label}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </nav>
    </>
  );
}
