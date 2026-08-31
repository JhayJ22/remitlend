import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsPage from "./page";

jest.mock("../../lib/session", () => ({
  logoutUser: jest.fn(),
}));

jest.mock("../../hooks/useLogout", () => ({
  useLogout: () => ({ logout: jest.fn() }),
}));

jest.mock("../../stores/useUserStore", () => ({
  useUserStore: jest.fn((selector) =>
    selector({
      user: { id: "user1", email: "test@example.com" },
    }),
  ),
  selectUser: (state: { user: { id: string; email: string } }) => state.user,
}));

jest.mock("../../stores/useWalletStore", () => ({
  useWalletStore: jest.fn((selector) =>
    selector({
      address: null,
      network: "testnet",
      disconnect: jest.fn(),
    }),
  ),
  selectWalletAddress: (state: { address: string | null }) => state.address,
  selectWalletNetwork: (state: { network: string }) => state.network,
}));

jest.mock("../../stores/useThemeStore", () => ({
  useThemeStore: jest.fn(() => ({
    theme: "system",
    setTheme: jest.fn(),
  })),
}));

const mockUpdateProfileMutate = jest.fn();
const mockToast = jest.fn();

jest.mock("../../hooks/useApi", () => ({
  useNotificationPreferences: () => ({ data: undefined, isLoading: false, error: null }),
  useUpdateNotificationPreferences: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdateUserProfile: () => ({ mutate: mockUpdateProfileMutate, isPending: false }),
}));

jest.mock("../../hooks/useToast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock("../../components/gamification/GamificationSettings", () => ({
  GamificationSettings: () => <div>Gamification Settings</div>,
}));

describe("SettingsPage section navigation", () => {
  it("exposes the default active section via aria-selected", () => {
    render(<SettingsPage />);

    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Wallet" })).toHaveAttribute("aria-selected", "false");
  });

  it("updates accessible state and focus when switching sections", async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    const walletTab = screen.getByRole("tab", { name: "Wallet" });
    await user.click(walletTab);

    expect(walletTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute("aria-selected", "false");
    expect(document.activeElement).toBe(walletTab);
  });

  it("links each tab to its panel with aria-controls and tabpanel semantics", () => {
    render(<SettingsPage />);

    const profileTab = screen.getByRole("tab", { name: "Profile" });
    const panelId = profileTab.getAttribute("aria-controls");

    expect(panelId).toBe("settings-panel-profile");

    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("id", panelId);
    expect(panel).toHaveAttribute("aria-labelledby", "settings-tab-profile");
  });
});

describe("SettingsPage profile save", () => {
  beforeEach(() => {
    mockUpdateProfileMutate.mockReset();
    mockToast.mockReset();
  });

  it("persists profile edits through the update-profile mutation", async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    const displayName = screen.getByLabelText(/display name/i);
    await user.clear(displayName);
    await user.type(displayName, "Alice");

    const email = screen.getByLabelText(/email/i);
    await user.clear(email);
    await user.type(email, "alice@example.com");

    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(mockUpdateProfileMutate).toHaveBeenCalledWith(
      { id: "Alice", email: "alice@example.com" },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it("shows a success toast and confirmation after a successful save", async () => {
    mockUpdateProfileMutate.mockImplementation((_payload, { onSuccess }) => onSuccess());
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "success", title: "Profile saved" }),
    );
    expect(await screen.findByRole("button", { name: /saved!/i })).toBeInTheDocument();
  });

  it("surfaces an error toast and inline message when the save fails", async () => {
    mockUpdateProfileMutate.mockImplementation((_payload, { onError }) =>
      onError(new Error("Network unavailable")),
    );
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive", description: "Network unavailable" }),
    );
    expect(screen.getByText("Network unavailable")).toBeInTheDocument();
  });

  it("blocks saving when the display name is empty", async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    const displayName = screen.getByLabelText(/display name/i);
    await user.clear(displayName);

    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(mockUpdateProfileMutate).not.toHaveBeenCalled();
    expect(screen.getByText("Display name is required.")).toBeInTheDocument();
  });
});
