import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { LanguageSwitcher } from "../../components/global_ui/LanguageSwitcher";
import { ShieldCheck } from "lucide-react";

interface AdminLayoutProps {
  children: ReactNode;
}

export default async function AdminLayout({ children }: AdminLayoutProps) {
  const t = await getTranslations("AdminLayout");

  return (
    <div className="min-h-screen">
      {/* Admin section banner */}
      <div className="border-b border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-2 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            <span>{t("adminArea")}</span>
          </div>
          <LanguageSwitcher />
        </div>
      </div>

      {/* Page content */}
      {children}
    </div>
  );
}
