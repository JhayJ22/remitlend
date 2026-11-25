"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import {
  User,
  Wallet,
  Bell,
  Shield,
  Monitor,
  Crown,
  LogOut,
  Key,
  CheckCheck,
  Copy,
  FileText,
  ChevronDown,
  ChevronUp,
  Clock,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { useLogout } from "../../hooks/useLogout";
import { GamificationSettings } from "../../components/gamification/GamificationSettings";
import { Toggle } from "../../components/ui/Toggle";
import { usePrivacyStore, selectReducedDataMode } from "../../stores/usePrivacyStore";
import { EyeOff } from "lucide-react";
import { useThemeStore } from "../../stores/useThemeStore";
import {
  useWalletStore,
  selectWalletAddress,
  selectWalletNetwork,
} from "../../stores/useWalletStore";
import { useUserStore, selectUser } from "../../stores/useUserStore";
import { logoutUser } from "../../lib/session";
import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
  useUpdateUserProfile,
  useConsentLedger,
  useConsentHistory,
  useConsentMeta,
  useGrantConsent,
  useRevokeConsent,
  type ConsentPurpose,
  type EffectiveConsent,
  type ConsentRecord,
} from "../../hooks/useApi";
import { useToast } from "../../hooks/useToast";
import { COPY_FEEDBACK_RESET_MS } from "../../components/ui";
// ─── Types ────────────────────────────────────────────────────────────────────

interface NotificationPrefs {
  loanApproved: boolean;
  repaymentDue: boolean;
  repaymentConfirmed: boolean;
  loanDefaulted: boolean;
  scoreChanged: boolean;
  email: boolean;
  sms: boolean;
  inApp: boolean;
  phone: string;
}

// ─── Section navigation ───────────────────────────────────────────────────────

const SECTIONS = [
  { id: "profile", label: "Profile", icon: User },
  { id: "wallet", label: "Wallet", icon: Wallet },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "privacy", label: "Privacy & Data", icon: FileText },
  { id: "security", label: "Security", icon: Shield },
  { id: "display", label: "Display", icon: Monitor },
  { id: "privacy", label: "Privacy", icon: EyeOff },
  { id: "gamification", label: "Gamification", icon: Crown },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function settingsTabId(id: SectionId) {
  return `settings-tab-${id}`;
}

function settingsPanelId(id: SectionId) {
  return `settings-panel-${id}`;
}

// ─── Copy-to-clipboard helper ─────────────────────────────────────────────────

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_RESET_MS);
    });
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 transition-colors"
      title="Copy to clipboard"
      aria-label={copied ? "Copied to clipboard" : "Copy to clipboard"}
    >
      {copied ? <CheckCheck className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}

// ─── Toggle switch ─────────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div className="flex items-center justify-between py-3">
      <div>
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{label}</p>
        {description && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{description}</p>
        )}
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          checked ? "bg-indigo-600" : "bg-zinc-300 dark:bg-zinc-700"
        }`}
        role="switch"
        aria-checked={checked}
        aria-label={label}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            checked ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    </div>
  );
}

// ─── Profile section ──────────────────────────────────────────────────────────

function ProfileSection() {
  const user = useUserStore(selectUser);
  const [displayName, setDisplayName] = useState(user?.id ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { toast } = useToast();
  const updateProfile = useUpdateUserProfile();

  const handleSave = () => {
    const name = displayName.trim();

    if (!name) {
      setSaveError("Display name is required.");
      return;
    }

    setSaveError(null);

    updateProfile.mutate(
      { id: name, email: email.trim() },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
          toast({
            variant: "success",
            title: "Profile saved",
            description: "Your profile changes have been saved.",
          });
        },
        onError: (error) => {
          setSaveError(error.message);
          toast({
            variant: "destructive",
            title: "Could not save profile",
            description: error.message,
          });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Manage your public display name and contact info.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Avatar */}
        <div className="flex items-center gap-4">
          <div className="h-16 w-16 rounded-full bg-indigo-100 dark:bg-indigo-500/20 flex items-center justify-center">
            <User className="h-8 w-8 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Profile Picture</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              Avatars are not supported yet — coming soon.
            </p>
          </div>
        </div>

        <Input
          label="Display Name"
          placeholder="e.g. Alice"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
        />
        <Input
          label="Email (optional)"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          helperText="Used for email notifications only. Never shared publicly."
        />

        <p className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-2">
          <span className="text-red-600">*</span> Required field
        </p>

        {saveError && <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>}

        <Button
          variant="primary"
          onClick={handleSave}
          disabled={updateProfile.isPending}
          className="w-full sm:w-auto"
        >
          {updateProfile.isPending ? "Saving..." : saved ? "Saved!" : "Save Profile"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Wallet section ───────────────────────────────────────────────────────────

function WalletSection() {
  const address = useWalletStore(selectWalletAddress);
  const network = useWalletStore(selectWalletNetwork);
  const disconnect = useWalletStore((s) => s.disconnect);
  const { logout } = useLogout();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Wallet</CardTitle>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Your connected Stellar wallet and network settings.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {address ? (
          <>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-2">
                Connected Address
              </p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-mono text-zinc-900 dark:text-zinc-50 break-all">
                  {address}
                </span>
                <CopyButton value={address} />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Network</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {network?.name ?? "Unknown"}
                </p>
              </div>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                  network?.isSupported
                    ? "bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400"
                    : "bg-yellow-50 text-yellow-700 dark:bg-yellow-500/10 dark:text-yellow-400"
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                {network?.isSupported ? "Supported" : "Unsupported"}
              </span>
            </div>

            <div className="pt-2 border-t border-zinc-200 dark:border-zinc-800 flex flex-col gap-2 sm:flex-row">
              <Button
                variant="outline"
                onClick={() => disconnect()}
                leftIcon={<LogOut className="h-4 w-4" />}
                className="text-amber-600 border-amber-200 hover:bg-amber-50 dark:text-amber-400 dark:border-amber-900/50 dark:hover:bg-amber-950/20"
              >
                Disconnect Wallet
              </Button>
              <Button
                variant="outline"
                onClick={() => logout()}
                leftIcon={<LogOut className="h-4 w-4" />}
                className="text-red-600 border-red-200 hover:bg-red-50 dark:text-red-400 dark:border-red-900/50 dark:hover:bg-red-950/20"
              >
                Sign Out
              </Button>
            </div>
          </>
        ) : (
          <div className="text-center py-6">
            <Wallet className="h-10 w-10 text-zinc-300 dark:text-zinc-600 mx-auto mb-3" />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No wallet connected.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Notifications section ────────────────────────────────────────────────────

function NotificationsSection() {
  const { data, isLoading, error } = useNotificationPreferences();
  const updateNotificationPreferences = useUpdateNotificationPreferences();
  const [prefs, setPrefs] = useState<NotificationPrefs>({
    loanApproved: true,
    repaymentDue: true,
    repaymentConfirmed: true,
    loanDefaulted: true,
    scoreChanged: false,
    email: false,
    sms: false,
    inApp: true,
    phone: "",
  });
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;

    // Sync server-fetched preferences into local editable form state once the
    // query resolves. This is the intended pattern here, not a render-loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPrefs((current) => ({
      ...current,
      email: data.emailEnabled,
      sms: data.smsEnabled,
      phone: data.phone ?? "",
    }));
    // Reset save feedback when fresh server preferences replace the editable form state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSaveError(null);
    // Reset save confirmation when fresh server preferences replace the editable form state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSaved(false);
  }, [data]);

  const toggle = (key: keyof NotificationPrefs) => setPrefs((p) => ({ ...p, [key]: !p[key] }));

  const perTypeOverrides = {
    loan_approved: prefs.loanApproved,
    repayment_due: prefs.repaymentDue,
    repayment_confirmed: prefs.repaymentConfirmed,
    loan_defaulted: prefs.loanDefaulted,
    score_changed: prefs.scoreChanged,
  };

  const handleSave = () => {
    setSaveError(null);
    setPhoneError(null);

    const phone = prefs.phone.trim();

    if (prefs.sms) {
      if (!phone) {
        setPhoneError("A phone number is required for SMS notifications.");
        return;
      }

      // Basic international phone validation
      const phoneRegex = /^\+?[1-9]\d{7,14}$/;

      if (!phoneRegex.test(phone)) {
        setPhoneError("Please enter a valid phone number.");
        return;
      }
    }

    updateNotificationPreferences.mutate(
      {
        emailEnabled: prefs.email,
        smsEnabled: prefs.sms,
        phone: phone || null,
        perTypeOverrides,
      },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        },
        onError: (error) => {
          setSaveError(error.message);
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Choose which events you want to be notified about and how.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 pb-2">
            Delivery
          </p>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            <Toggle
              checked={prefs.inApp}
              onChange={() => toggle("inApp")}
              label="In-App Notifications"
              description="Show notifications inside RemitLend"
            />
            <Toggle
              checked={prefs.email}
              onChange={() => toggle("email")}
              label="Email Notifications"
              description="Requires a verified email address"
            />
            <Toggle
              checked={prefs.sms}
              onChange={() => {
                setPhoneError(null);
                toggle("sms");
              }}
              label="SMS Notifications"
              description="Requires a verified phone number"
            />
          </div>
          <Input
            label="Phone number"
            placeholder="+14155552671"
            value={prefs.phone}
            onChange={(e) => {
              setPhoneError(null);
              setPrefs((p) => ({ ...p, phone: e.target.value }));
            }}
            helperText={
              prefs.sms
                ? "A phone number is required for SMS notifications."
                : "Optional unless SMS notifications are enabled."
            }
          />
          {phoneError && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{phoneError}</p>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 pb-2 pt-4">
            Events
          </p>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            <Toggle
              checked={prefs.loanApproved}
              onChange={() => toggle("loanApproved")}
              label="Loan Approved"
              description="When your loan application is approved"
            />
            <Toggle
              checked={prefs.repaymentDue}
              onChange={() => toggle("repaymentDue")}
              label="Repayment Due"
              description="Reminder before a payment is due"
            />
            <Toggle
              checked={prefs.repaymentConfirmed}
              onChange={() => toggle("repaymentConfirmed")}
              label="Repayment Confirmed"
              description="When a repayment is recorded on-chain"
            />
            <Toggle
              checked={prefs.loanDefaulted}
              onChange={() => toggle("loanDefaulted")}
              label="Loan Defaulted"
              description="When a loan is marked as defaulted"
            />
            <Toggle
              checked={prefs.scoreChanged}
              onChange={() => toggle("scoreChanged")}
              label="Credit Score Changed"
              description="When your score goes up or down"
            />
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">
            Unable to load notification settings.
          </p>
        )}
        {saveError && <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>}
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={updateNotificationPreferences.isPending || isLoading}
          className="w-full sm:w-auto"
        >
          {updateNotificationPreferences.isPending
            ? "Saving..."
            : saved
              ? "Saved!"
              : "Save Preferences"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Security section ─────────────────────────────────────────────────────────

function SecuritySection() {
  const user = useUserStore(selectUser);
  const authToken = useUserStore((s) => s.authToken);
  const [showToken, setShowToken] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Security</CardTitle>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Session management and developer API access.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Session */}
        <div>
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
            Active Session
          </p>
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-zinc-500 dark:text-zinc-400">Started</span>
              <span className="text-zinc-900 dark:text-zinc-100 font-medium">
                {user?.sessionStartedAt ? new Date(user.sessionStartedAt).toLocaleString() : "—"}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-500 dark:text-zinc-400">KYC Status</span>
              <span
                className={`font-medium ${
                  user?.kycVerified
                    ? "text-green-600 dark:text-green-400"
                    : "text-yellow-600 dark:text-yellow-400"
                }`}
              >
                {user?.kycVerified ? "Verified" : "Not Verified"}
              </span>
            </div>
          </div>
        </div>

        {/* API Key */}
        {authToken && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Key className="h-4 w-4 text-zinc-500" />
                <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  JWT Session Token
                </p>
              </div>
              <button
                onClick={() => setShowToken((v) => !v)}
                className="text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
                aria-label={showToken ? "Hide session token" : "Show session token"}
              >
                {showToken ? "Hide" : "Show"}
              </button>
            </div>
            <div className="relative rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-xs font-mono text-zinc-700 dark:text-zinc-300 break-all">
                {showToken ? authToken : `${authToken.slice(0, 20)}${"•".repeat(30)}`}
              </p>
              <div className="absolute right-2 top-2">
                <CopyButton value={authToken} />
              </div>
            </div>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1.5">
              Valid for 24 hours. Keep this secret — it grants full API access.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Display section ──────────────────────────────────────────────────────────

function PrivacySection() {
  const reducedDataMode = usePrivacyStore(selectReducedDataMode);
  const setReducedDataMode = usePrivacyStore((s) => s.setReducedDataMode);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Privacy</CardTitle>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Control how sensitive account data is displayed on this device.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          <Toggle
            checked={reducedDataMode}
            onChange={setReducedDataMode}
            label="Reduced Data Mode"
            description="Mask account identifiers and balances on sensitive screens. Hidden values are absent from copied text, screenshots, and accessible names."
          />
        </div>
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900 space-y-2">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            When enabled:
          </p>
          <ul className="text-xs text-zinc-500 dark:text-zinc-400 space-y-1 ml-4 list-disc">
            <li>Wallet addresses show as "G••••••••" instead of the real address</li>
            <li>Balances and amounts show as "••••••••" instead of the real value</li>
            <li>Credit scores show as "•••" instead of the real number</li>
            <li>Copy buttons on masked values are disabled</li>
            <li>Use the eye toggle on any masked value to temporarily reveal it</li>
          </ul>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 pt-2">
            This preference is stored locally on this device only. It does not
            affect your account data on the blockchain or backend.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Display section ──────────────────────────────────────────────────────────

function DisplaySection() {
  const LANGUAGES = [
    { code: "en", label: "English" },
    { code: "es", label: "Español" },
    { code: "fr", label: "Français" },
    { code: "pt", label: "Português" },
    { code: "hi", label: "हिन्दी" },
  ];

  const [language, setLanguage] = useState("en");

  const theme = useThemeStore((s) => s.theme);
  const hydrated = useThemeStore((s) => s.hydrated);
  const initializeTheme = useThemeStore((s) => s.initializeTheme);
  const setTheme = useThemeStore((s) => s.setTheme);

  // Ensure client store is initialised
  useEffect(() => {
    if (!hydrated) initializeTheme();
  }, [hydrated, initializeTheme]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Display</CardTitle>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Appearance and language preferences.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Theme</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              Choose a preference: Light / Dark / System
            </p>
          </div>
          <div className="inline-flex items-center gap-2">
            {(["light", "dark", "system"] as const).map((opt) => {
              const active = theme === opt;
              return (
                <button
                  key={opt}
                  onClick={() => setTheme(opt)}
                  className={`px-3 py-1 rounded-lg text-sm font-medium transition-colors ${
                    active
                      ? "bg-indigo-600 text-white"
                      : "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
                  }`}
                >
                  {opt[0].toUpperCase() + opt.slice(1)}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="text-sm font-medium text-zinc-900 dark:text-zinc-100 block mb-2">
            Language
          </label>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1.5">
            Full i18n support is coming soon. Only English is fully translated.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Privacy & Data section (#845) ───────────────────────────────────────────

/** Human-readable labels for each processing purpose. */
const PURPOSE_LABELS: Record<ConsentPurpose, { title: string; description: string; categories: string }> = {
  credit_score_processing: {
    title: "Credit Score Processing",
    description:
      "We use your loan repayment history and on-chain activity to compute your credit score. This score affects your borrowing limits and interest rates.",
    categories: "Wallet address, loan history, credit score",
  },
  remittance_analytics: {
    title: "Remittance Analytics",
    description:
      "We aggregate your remittance amounts and patterns to improve pool yield estimates and product features. Data is anonymised before use.",
    categories: "Remittance history, wallet address",
  },
  marketing_communications: {
    title: "Marketing Communications",
    description:
      "We may send you product updates, feature announcements, and promotional offers via email or SMS.",
    categories: "Contact info (email, phone)",
  },
  third_party_sharing: {
    title: "Third-Party Data Sharing",
    description:
      "We may share anonymised, aggregated data with regulated financial partners for credit risk and compliance purposes.",
    categories: "Credit score, loan history, remittance history (anonymised)",
  },
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function ConsentPurposeRow({
  purpose,
  effective,
  policyVersion,
  onGrant,
  onRevoke,
  isGranting,
  isRevoking,
}: {
  purpose: ConsentPurpose;
  effective: EffectiveConsent | undefined;
  policyVersion: string;
  onGrant: (purpose: ConsentPurpose) => void;
  onRevoke: (purpose: ConsentPurpose) => void;
  isGranting: boolean;
  isRevoking: boolean;
}) {
  const info = PURPOSE_LABELS[purpose];
  const isGranted = effective?.status === "granted";
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{info.title}</p>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                isGranted
                  ? "bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400"
                  : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${isGranted ? "bg-green-500" : "bg-zinc-400"}`}
              />
              {isGranted ? "Consented" : "Not consented"}
            </span>
          </div>
          {effective && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 flex items-center gap-1">
              <Clock className="h-3 w-3" aria-hidden="true" />
              {isGranted ? "Granted" : "Revoked"} {formatDate(effective.effectiveSince)} · Policy v
              {effective.policyVersion}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} details for ${info.title}`}
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:text-zinc-300 dark:hover:bg-zinc-800 transition-colors"
          >
            {expanded ? (
              <ChevronUp className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
          {isGranted ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onRevoke(purpose)}
              disabled={isRevoking}
              aria-label={`Revoke consent for ${info.title}`}
            >
              {isRevoking ? "Revoking…" : "Revoke"}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={() => onGrant(purpose)}
              disabled={isGranting}
              aria-label={`Grant consent for ${info.title}`}
            >
              {isGranting ? "Granting…" : "Consent"}
            </Button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-4 py-3 space-y-1.5">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{info.description}</p>
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            <span className="font-medium">Data involved:</span> {info.categories}
          </p>
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            <span className="font-medium">Current policy version:</span> {policyVersion}
          </p>
        </div>
      )}
    </div>
  );
}

function PrivacySection() {
  const { data: consents, isLoading: consentsLoading } = useConsentLedger();
  const { data: meta } = useConsentMeta();
  const { data: history, isLoading: historyLoading } = useConsentHistory({ limit: 20 });
  const grantMutation = useGrantConsent();
  const revokeMutation = useRevokeConsent();
  const { toast } = useToast();
  const [pendingPurpose, setPendingPurpose] = useState<ConsentPurpose | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const effectiveMap = new Map<ConsentPurpose, EffectiveConsent>(
    (consents ?? []).map((c) => [c.purpose, c]),
  );
  const policyVersion = meta?.currentPolicyVersion ?? "1.0";
  const allPurposes: ConsentPurpose[] = meta?.purposes ?? [
    "credit_score_processing",
    "remittance_analytics",
    "marketing_communications",
    "third_party_sharing",
  ];

  const dataCategories: Record<ConsentPurpose, import("../../hooks/useApi").ConsentDataCategory[]> = {
    credit_score_processing: ["wallet_address", "loan_history", "credit_score"],
    remittance_analytics: ["remittance_history", "wallet_address"],
    marketing_communications: ["contact_info"],
    third_party_sharing: ["credit_score", "loan_history", "remittance_history"],
  };

  const handleGrant = (purpose: ConsentPurpose) => {
    setPendingPurpose(purpose);
    grantMutation.mutate(
      {
        purpose,
        policy_version: policyVersion,
        data_categories: dataCategories[purpose],
      },
      {
        onSuccess: () => {
          toast({ variant: "success", title: "Consent granted", description: PURPOSE_LABELS[purpose].title });
        },
        onError: (error) => {
          toast({ variant: "destructive", title: "Could not grant consent", description: error.message });
        },
        onSettled: () => setPendingPurpose(null),
      },
    );
  };

  const handleRevoke = (purpose: ConsentPurpose) => {
    setPendingPurpose(purpose);
    revokeMutation.mutate(
      { purpose },
      {
        onSuccess: () => {
          toast({ variant: "success", title: "Consent revoked", description: PURPOSE_LABELS[purpose].title });
        },
        onError: (error) => {
          toast({ variant: "destructive", title: "Could not revoke consent", description: error.message });
        },
        onSettled: () => setPendingPurpose(null),
      },
    );
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Privacy &amp; Data Processing</CardTitle>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            Control how RemitLend uses your data. You can grant or revoke consent for each purpose
            at any time. Changes take effect immediately in downstream processing jobs.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {consentsLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="h-14 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800"
                />
              ))}
            </div>
          ) : (
            allPurposes.map((purpose) => (
              <ConsentPurposeRow
                key={purpose}
                purpose={purpose}
                effective={effectiveMap.get(purpose)}
                policyVersion={policyVersion}
                onGrant={handleGrant}
                onRevoke={handleRevoke}
                isGranting={pendingPurpose === purpose && grantMutation.isPending}
                isRevoking={pendingPurpose === purpose && revokeMutation.isPending}
              />
            ))
          )}

          <p className="text-xs text-zinc-400 dark:text-zinc-500 pt-2">
            Revoking consent stops future data processing for that purpose. It does not delete
            historical data already processed. Contact support to request data deletion.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Consent History</span>
            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              aria-expanded={showHistory}
              className="text-sm font-normal text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
            >
              {showHistory ? "Hide" : "Show"}
            </button>
          </CardTitle>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            An immutable record of every consent grant and revocation.
          </p>
        </CardHeader>
        {showHistory && (
          <CardContent>
            {historyLoading ? (
              <div className="h-20 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
            ) : !history || history.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400 py-4 text-center">
                No consent history yet.
              </p>
            ) : (
              <ol className="space-y-2" aria-label="Consent history">
                {history.map((record: ConsentRecord) => (
                  <li
                    key={record.id}
                    className="flex items-start justify-between gap-3 rounded-lg border border-zinc-100 dark:border-zinc-800 px-3 py-2 text-xs"
                  >
                    <div>
                      <span
                        className={`font-medium ${
                          record.status === "granted"
                            ? "text-green-700 dark:text-green-400"
                            : "text-red-600 dark:text-red-400"
                        }`}
                      >
                        {record.status === "granted" ? "Granted" : "Revoked"}
                      </span>{" "}
                      <span className="text-zinc-700 dark:text-zinc-300">
                        {PURPOSE_LABELS[record.purpose]?.title ?? record.purpose}
                      </span>
                      {record.revocationReason && (
                        <p className="mt-0.5 text-zinc-500 dark:text-zinc-400">
                          Reason: {record.revocationReason}
                        </p>
                      )}
                    </div>
                    <time
                      dateTime={record.createdAt}
                      className="text-zinc-400 dark:text-zinc-500 whitespace-nowrap"
                    >
                      {formatDate(record.createdAt)}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SectionId>("profile");
  const handleLogout = () => logoutUser("manual");

  const activateSection = (id: SectionId) => {
    setActiveSection(id);
    requestAnimationFrame(() => {
      document.getElementById(settingsTabId(id))?.focus();
    });
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % SECTIONS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + SECTIONS.length) % SECTIONS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = SECTIONS.length - 1;
    }

    if (nextIndex === null) return;

    event.preventDefault();
    activateSection(SECTIONS[nextIndex].id);
  };

  const renderSection = () => {
    switch (activeSection) {
      case "profile":
        return <ProfileSection />;
      case "wallet":
        return <WalletSection />;
      case "notifications":
        return <NotificationsSection />;
      case "privacy":
        return <PrivacySection />;
      case "security":
        return <SecuritySection />;
      case "display":
        return <DisplaySection />;
      case "privacy":
        return <PrivacySection />;
      case "gamification":
        return <GamificationSettings />;
    }
  };

  return (
    <main className="space-y-8 min-h-screen p-8 lg:p-12 max-w-5xl mx-auto">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-indigo-600">Account</p>
          <h1 className="mt-1 text-3xl font-bold text-zinc-900 dark:text-zinc-50">Settings</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Manage your profile, wallet, notifications, and preferences.
          </p>
        </div>
        <Button
          variant="danger"
          onClick={handleLogout}
          leftIcon={<LogOut className="h-4 w-4" />}
          className="sm:mt-1"
        >
          Log out
        </Button>
      </header>

      <div className="flex flex-col lg:flex-row gap-8">
        {/* Side nav */}
        <nav aria-label="Settings sections" className="lg:w-52 flex-shrink-0">
          <ul
            role="tablist"
            aria-orientation="vertical"
            className="flex flex-row lg:flex-col gap-1 overflow-x-auto lg:overflow-x-visible pb-2 lg:pb-0"
          >
            {SECTIONS.map(({ id, label, icon: Icon }, index) => {
              const isActive = activeSection === id;

              return (
                <li key={id} role="presentation">
                  <button
                    type="button"
                    role="tab"
                    id={settingsTabId(id)}
                    aria-selected={isActive}
                    aria-controls={settingsPanelId(id)}
                    tabIndex={isActive ? 0 : -1}
                    onClick={() => activateSection(id)}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium w-full transition-colors whitespace-nowrap ${
                      isActive
                        ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400"
                        : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-50"
                    }`}
                  >
                    <Icon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                    {label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Content */}
        <div
          role="tabpanel"
          id={settingsPanelId(activeSection)}
          aria-labelledby={settingsTabId(activeSection)}
          tabIndex={0}
          className="flex-1 min-w-0"
        >
          {renderSection()}
        </div>
      </div>
    </main>
  );
}
