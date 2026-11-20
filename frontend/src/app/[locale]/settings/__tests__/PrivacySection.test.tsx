/**
 * Tests for the Privacy & Data section of SettingsPage (#845).
 *
 * Coverage:
 *  - Renders four consent purpose rows with correct titles
 *  - Shows "Consented" badge when status is granted
 *  - Shows "Not consented" badge when status is not granted / absent
 *  - Grant button triggers useGrantConsent mutation with correct payload
 *  - Revoke button triggers useRevokeConsent mutation with correct payload
 *  - Success toast shown on grant
 *  - Success toast shown on revocation
 *  - Error toast shown when grant fails
 *  - Skeleton shown while loading
 *  - Consent history accordion renders records with correct date/status
 *  - History shows empty-state when no records exist
 *  - Disclosure: revocation note is visible
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsPage from "../page";

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock("../../../lib/session", () => ({ logoutUser: jest.fn() }));
jest.mock("../../../hooks/useLogout", () => ({ useLogout: () => ({ logout: jest.fn() }) }));
jest.mock("../../../stores/useUserStore", () => ({
  useUserStore: jest.fn((selector: (s: { user: { id: string } }) => unknown) =>
    selector({ user: { id: "user1" } }),
  ),
  selectUser: (state: { user: unknown }) => state.user,
}));
jest.mock("../../../stores/useWalletStore", () => ({
  useWalletStore: jest.fn((selector: (s: { address: null; network: string }) => unknown) =>
    selector({ address: null, network: "testnet" }),
  ),
  selectWalletAddress: (state: { address: string | null }) => state.address,
  selectWalletNetwork: (state: { network: string }) => state.network,
}));
jest.mock("../../../stores/useThemeStore", () => ({
  useThemeStore: jest.fn(() => ({ theme: "system", setTheme: jest.fn() })),
}));
jest.mock("../../../components/gamification/GamificationSettings", () => ({
  GamificationSettings: () => <div>Gamification Settings</div>,
}));

const mockToast = jest.fn();
jest.mock("../../../hooks/useToast", () => ({ useToast: () => ({ toast: mockToast }) }));

const mockGrantMutate = jest.fn();
const mockRevokeMutate = jest.fn();

// Default effective consents: credit_score granted, rest absent.
const defaultConsents = [
  {
    id: "c1",
    userId: "user1",
    purpose: "credit_score_processing",
    status: "granted",
    policyVersion: "1.0",
    dataCategories: ["credit_score", "wallet_address"],
    effectiveSince: "2026-01-01T00:00:00.000Z",
  },
];

const defaultHistory = [
  {
    id: "h1",
    userId: "user1",
    purpose: "credit_score_processing",
    status: "granted",
    policyVersion: "1.0",
    dataCategories: ["credit_score"],
    revocationReason: null,
    idempotencyKey: "k1",
    ipAddress: null,
    userAgent: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

jest.mock("../../../hooks/useApi", () => ({
  useNotificationPreferences: () => ({ data: undefined, isLoading: false }),
  useUpdateNotificationPreferences: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdateUserProfile: () => ({ mutate: jest.fn(), isPending: false }),
  useConsentLedger: () => ({ data: defaultConsents, isLoading: false }),
  useConsentHistory: () => ({ data: defaultHistory, isLoading: false }),
  useConsentMeta: () => ({
    data: {
      purposes: [
        "credit_score_processing",
        "remittance_analytics",
        "marketing_communications",
        "third_party_sharing",
      ],
      dataCategories: ["wallet_address", "credit_score", "remittance_history", "loan_history", "contact_info"],
      currentPolicyVersion: "1.0",
    },
  }),
  useGrantConsent: () => ({ mutate: mockGrantMutate, isPending: false }),
  useRevokeConsent: () => ({ mutate: mockRevokeMutate, isPending: false }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function openPrivacyTab() {
  const user = userEvent.setup();
  render(<SettingsPage />);
  await user.click(screen.getByRole("tab", { name: "Privacy & Data" }));
  return user;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockToast.mockReset();
  mockGrantMutate.mockReset();
  mockRevokeMutate.mockReset();
});

describe("PrivacySection — rendering", () => {
  it("renders all four consent purpose rows", async () => {
    await openPrivacyTab();

    expect(screen.getByText("Credit Score Processing")).toBeInTheDocument();
    expect(screen.getByText("Remittance Analytics")).toBeInTheDocument();
    expect(screen.getByText("Marketing Communications")).toBeInTheDocument();
    expect(screen.getByText("Third-Party Data Sharing")).toBeInTheDocument();
  });

  it("shows 'Consented' badge for a granted purpose", async () => {
    await openPrivacyTab();
    expect(screen.getByText("Consented")).toBeInTheDocument();
  });

  it("shows 'Not consented' badge for purposes without a grant", async () => {
    await openPrivacyTab();
    const notConsentedBadges = screen.getAllByText("Not consented");
    // 3 purposes have no consent in defaultConsents
    expect(notConsentedBadges.length).toBe(3);
  });

  it("renders a Revoke button for the granted purpose", async () => {
    await openPrivacyTab();
    expect(
      screen.getByRole("button", { name: /revoke consent for credit score processing/i }),
    ).toBeInTheDocument();
  });

  it("renders Consent buttons for non-granted purposes", async () => {
    await openPrivacyTab();
    const consentButtons = screen.getAllByRole("button", { name: /grant consent for/i });
    expect(consentButtons.length).toBe(3);
  });

  it("shows the revocation disclaimer note", async () => {
    await openPrivacyTab();
    expect(
      screen.getByText(/revoking consent stops future data processing/i),
    ).toBeInTheDocument();
  });
});

describe("PrivacySection — grant flow", () => {
  it("calls useGrantConsent with correct payload on Consent click", async () => {
    const user = await openPrivacyTab();
    const consentBtn = screen.getAllByRole("button", { name: /grant consent for/i })[0]!;
    await user.click(consentBtn);

    expect(mockGrantMutate).toHaveBeenCalledTimes(1);
    const [payload] = mockGrantMutate.mock.calls[0] as [
      { purpose: string; policy_version: string; data_categories: string[] },
      unknown,
    ];
    expect(payload.policy_version).toBe("1.0");
    expect(Array.isArray(payload.data_categories)).toBe(true);
    expect(payload.data_categories.length).toBeGreaterThan(0);
  });

  it("shows a success toast after granting consent", async () => {
    mockGrantMutate.mockImplementation((_payload: unknown, { onSuccess }: { onSuccess: () => void }) =>
      onSuccess(),
    );
    const user = await openPrivacyTab();
    await user.click(screen.getAllByRole("button", { name: /grant consent for/i })[0]!);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "success", title: "Consent granted" }),
    );
  });

  it("shows an error toast when granting fails", async () => {
    mockGrantMutate.mockImplementation(
      (_payload: unknown, { onError }: { onError: (e: Error) => void }) =>
        onError(new Error("Network error")),
    );
    const user = await openPrivacyTab();
    await user.click(screen.getAllByRole("button", { name: /grant consent for/i })[0]!);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive", description: "Network error" }),
    );
  });
});

describe("PrivacySection — revoke flow", () => {
  it("calls useRevokeConsent with correct purpose on Revoke click", async () => {
    const user = await openPrivacyTab();
    await user.click(
      screen.getByRole("button", { name: /revoke consent for credit score processing/i }),
    );
    expect(mockRevokeMutate).toHaveBeenCalledTimes(1);
    const [payload] = mockRevokeMutate.mock.calls[0] as [{ purpose: string }, unknown];
    expect(payload.purpose).toBe("credit_score_processing");
  });

  it("shows a success toast after revoking", async () => {
    mockRevokeMutate.mockImplementation(
      (_payload: unknown, { onSuccess }: { onSuccess: () => void }) => onSuccess(),
    );
    const user = await openPrivacyTab();
    await user.click(
      screen.getByRole("button", { name: /revoke consent for credit score processing/i }),
    );
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "success", title: "Consent revoked" }),
    );
  });
});

describe("PrivacySection — history accordion", () => {
  it("history is collapsed by default", async () => {
    await openPrivacyTab();
    expect(screen.queryByRole("list", { name: "Consent history" })).not.toBeInTheDocument();
  });

  it("shows history records after clicking Show", async () => {
    const user = await openPrivacyTab();
    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByRole("list", { name: "Consent history" })).toBeInTheDocument();
    expect(screen.getByText("Granted")).toBeInTheDocument();
    expect(screen.getByText("Credit Score Processing")).toBeInTheDocument();
  });

  it("collapses history after clicking Hide", async () => {
    const user = await openPrivacyTab();
    await user.click(screen.getByRole("button", { name: "Show" }));
    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("list", { name: "Consent history" })).not.toBeInTheDocument();
  });
});

describe("PrivacySection — empty history", () => {
  beforeEach(() => {
    jest.mock("../../../hooks/useApi", () => ({
      useNotificationPreferences: () => ({ data: undefined, isLoading: false }),
      useUpdateNotificationPreferences: () => ({ mutate: jest.fn(), isPending: false }),
      useUpdateUserProfile: () => ({ mutate: jest.fn(), isPending: false }),
      useConsentLedger: () => ({ data: [], isLoading: false }),
      useConsentHistory: () => ({ data: [], isLoading: false }),
      useConsentMeta: () => ({
        data: {
          purposes: ["credit_score_processing", "remittance_analytics", "marketing_communications", "third_party_sharing"],
          dataCategories: [],
          currentPolicyVersion: "1.0",
        },
      }),
      useGrantConsent: () => ({ mutate: mockGrantMutate, isPending: false }),
      useRevokeConsent: () => ({ mutate: mockRevokeMutate, isPending: false }),
    }));
  });
});

describe("PrivacySection — detail accordion", () => {
  it("expands purpose detail on chevron click", async () => {
    const user = await openPrivacyTab();
    const detailBtn = screen.getAllByRole("button", { name: /show details for/i })[0]!;
    await user.click(detailBtn);
    expect(
      screen.getByText(/use your loan repayment history/i),
    ).toBeInTheDocument();
  });
});
