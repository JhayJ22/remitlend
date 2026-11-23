import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../hooks/useWallet';
import { useGamificationStore } from '../store/gamificationStore';
import { WizardStepper } from '../components/WizardStepper';
import { remittanceNftClient } from '../lib/contracts/remittanceNft';

const ONBOARDING_XP = 100;
const REMITTANCE_DOCS_URL =
  'https://docs.handsoff.io/guides/remittance-history-import';

type StepId = 'connect' | 'mint' | 'import' | 'loan';

interface OnboardingStep {
  id: StepId;
  title: string;
  description: string;
  actions: string[];
  cta: string;
}

const STEPS: OnboardingStep[] = [
  {
    id: 'connect',
    title: 'Connect Wallet',
    description: 'Link a Stellar wallet to create your borrower profile.',
    actions: ['Install a supported wallet (Freighter, xBull)', 'Approve the connection request'],
    cta: 'Connect Wallet',
  },
  {
    id: 'mint',
    title: 'Mint Identity NFT',
    description: 'Mint your non-transferable identity NFT to unlock borrowing.',
    actions: ['Confirm the mint transaction in your wallet', 'Wait for ledger confirmation'],
    cta: 'Mint Identity NFT',
  },
  {
    id: 'import',
    title: 'Import Remittance History',
    description: 'Upload a remittance CSV or link a remittance provider to build your credit history.',
    actions: ['Export your remittance history as CSV', 'Upload the file or link a provider'],
    cta: 'Import History',
  },
  {
    id: 'loan',
    title: 'Request First Loan',
    description: 'You are ready to request your first loan against your remittance history.',
    actions: ['Review your credit score', 'Submit a loan request'],
    cta: 'Request First Loan',
  },
];

export default function Onboarding() {
  const navigate = useNavigate();
  const { address, connect, signTransaction } = useWallet();
  const awardXp = useGamificationStore((s) => s.awardXp);
  const onboardingComplete = useGamificationStore((s) => s.onboardingComplete);
  const markOnboardingComplete = useGamificationStore((s) => s.markOnboardingComplete);

  const [hasNft, setHasNft] = useState(false);
  const [hasHistory, setHasHistory] = useState(false);
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    remittanceNftClient
      .hasIdentity(address)
      .then((owned) => {
        if (!cancelled) setHasNft(owned);
      })
      .catch(() => {
        if (!cancelled) setHasNft(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const currentIndex = useMemo(() => {
    if (!address) return 0;
    if (!hasNft) return 1;
    if (!hasHistory) return 2;
    return 3;
  }, [address, hasNft, hasHistory]);

  const allComplete = Boolean(address) && hasNft && hasHistory;

  useEffect(() => {
    if (!allComplete || onboardingComplete) return;
    markOnboardingComplete();
    awardXp(ONBOARDING_XP, 'onboarding-complete');
  }, [allComplete, onboardingComplete, markOnboardingComplete, awardXp]);

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      await connect();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect wallet');
    }
  }, [connect]);

  const handleMint = useCallback(async () => {
    if (!address) return;
    setError(null);
    setMinting(true);
    try {
      const tx = await remittanceNftClient.buildMintTx(address);
      const signed = await signTransaction(tx);
      await remittanceNftClient.submitMint(signed);
      setHasNft(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mint identity NFT');
    } finally {
      setMinting(false);
    }
  }, [address, signTransaction]);

  const handleImport = useCallback(() => {
    setHasHistory(true);
  }, []);

  const handleFinish = useCallback(() => {
    navigate('/');
  }, [navigate]);

  const renderCta = (step: OnboardingStep) => {
    switch (step.id) {
      case 'connect':
        return (
          <button type="button" onClick={handleConnect} disabled={Boolean(address)}>
            {address ? 'Wallet Connected' : step.cta}
          </button>
        );
      case 'mint':
        return (
          <button type="button" onClick={handleMint} disabled={!address || hasNft || minting}>
            {hasNft ? 'Identity Minted' : minting ? 'Minting…' : step.cta}
          </button>
        );
      case 'import':
        return (
          <button type="button" onClick={handleImport} disabled={!hasNft || hasHistory}>
            {hasHistory ? 'History Imported' : step.cta}
          </button>
        );
      case 'loan':
        return (
          <button type="button" onClick={handleFinish} disabled={!allComplete}>
            {step.cta}
          </button>
        );
      default:
        return null;
    }
  };

  return (
    <div className="onboarding-page">
      <header className="onboarding-header">
        <h1>Welcome to Handsoff</h1>
        <p>Complete these steps to unlock the full dashboard and start borrowing.</p>
      </header>

      <WizardStepper
        steps={STEPS.map((s) => s.title)}
        currentStep={currentIndex}
        completedSteps={currentIndex}
      />

      {error && <div className="onboarding-error">{error}</div>}

      <ol className="onboarding-steps">
        {STEPS.map((step, index) => {
          const isActive = index === currentIndex;
          const isDone = index < currentIndex;
          return (
            <li
              key={step.id}
              className={`onboarding-step${isActive ? ' is-active' : ''}${isDone ? ' is-done' : ''}`}
            >
              <h2>
                {index + 1}. {step.title}
              </h2>
              <p>{step.description}</p>
              <ul>
                {step.actions.map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
              {step.id === 'import' && (
                <p className="onboarding-hint">
                  Provider linking is coming soon.{' '}
                  <a href={REMITTANCE_DOCS_URL} target="_blank" rel="noreferrer">
                    Read the import guide
                  </a>
                </p>
              )}
              {renderCta(step)}
            </li>
          );
        })}
      </ol>

      {allComplete && (
        <p className="onboarding-complete">
          Onboarding complete — you earned {ONBOARDING_XP} XP.
        </p>
      )}
    </div>
  );
}
