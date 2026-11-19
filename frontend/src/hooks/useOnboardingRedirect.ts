import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useWallet } from '@/hooks/useWallet';
import { useNftStatus } from '@/hooks/useNftStatus';

const ONBOARDING_PATH = '/onboarding';

/**
 * Entry points that should funnel brand-new borrowers (no identity NFT)
 * into the guided onboarding flow.
 */
const PROTECTED_ENTRY_POINTS = ['/', '/loans', '/lend'];

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/**
 * Redirects users who have connected a wallet but do not yet hold an
 * identity NFT away from the main dashboard entry points and into the
 * onboarding wizard.
 */
export function useOnboardingRedirect(): void {
  const router = useRouter();
  const { isConnected } = useWallet();
  const { hasNft, isLoading } = useNftStatus();

  useEffect(() => {
    if (!router.isReady || isLoading) {
      return;
    }

    const currentPath = normalizePath(router.pathname);
    if (!PROTECTED_ENTRY_POINTS.includes(currentPath)) {
      return;
    }

    if (isConnected && !hasNft) {
      void router.replace(ONBOARDING_PATH);
    }
  }, [router, router.isReady, isConnected, hasNft, isLoading]);
}

export default useOnboardingRedirect;
