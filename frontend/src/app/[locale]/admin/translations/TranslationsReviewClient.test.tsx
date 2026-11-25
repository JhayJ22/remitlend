import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TranslationsReviewClient from "./TranslationsReviewClient";
import manifestJson from "../../../../../i18n/financial-strings.json";
import glossaryJson from "../../../../../i18n/glossary.json";
import reviewStateJson from "../../../../../i18n/review-state.json";
import enJson from "../../../../../messages/en.json";
import esJson from "../../../../../messages/es.json";
import tlJson from "../../../../../messages/tl.json";
import {
  sourceHash,
  type FinancialStringManifest,
  type ReviewState,
} from "../../../../../lib/i18n/financialTranslations";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string | number>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

const mockUseUserStore = jest.fn((selector: (state: unknown) => unknown) =>
  selector({ user: { role: "admin" }, authToken: "session-token" }),
);
jest.mock("../../../stores/useUserStore", () => ({
  useUserStore: (selector: (state: unknown) => unknown) => mockUseUserStore(selector),
}));

const manifest = manifestJson as FinancialStringManifest;
const reviewState = reviewStateJson as ReviewState;

function renderPage() {
  return render(
    <TranslationsReviewClient
      manifest={manifest}
      glossary={glossaryJson}
      initialReviewState={JSON.parse(JSON.stringify(reviewState)) as ReviewState}
      sourceMessages={enJson}
      localizedMessages={{ en: enJson, es: esJson, tl: tlJson }}
    />,
  );
}

describe("financial translation review UI", () => {
  beforeEach(() => {
    mockUseUserStore.mockImplementation((selector) =>
      selector({ user: { role: "admin" }, authToken: "session-token" }),
    );
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ reviewState: JSON.parse(JSON.stringify(reviewState)) as ReviewState }),
    }) as unknown as typeof fetch;
  });

  it("shows a ready release gate and critical strings for admins", () => {
    renderPage();
    expect(screen.getByText("releaseReady")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "title" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "LoanCard.totalOwed" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "title" })).toBeInTheDocument();
    expect(screen.getByLabelText("locale")).toBeInTheDocument();
  });

  it("hides the review table from non-admin users", () => {
    mockUseUserStore.mockImplementation((selector) =>
      selector({ user: { role: "borrower" }, authToken: null }),
    );
    renderPage();
    expect(screen.getByText("forbidden")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("submits an idempotent approval with the current source hash", async () => {
    const user = userEvent.setup();
    renderPage();
    const entry = manifest.criticalStrings.find((item) => item.key === "LoanCard.principal")!;

    await user.click(screen.getByRole("button", { name: "approve LoanCard.principal" }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/i18n/reviews",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer session-token" }),
        body: JSON.stringify({
          key: "LoanCard.principal",
          locale: "es",
          action: "approve",
          expectedSourceHash: sourceHash(entry),
        }),
      }),
    );
    expect(await screen.findByText("updated")).toBeInTheDocument();
  });

  it("surfaces dependency failures without mutating local state", async () => {
    const user = userEvent.setup();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Session validation failed" }),
    }) as unknown as typeof fetch;
    renderPage();

    await user.click(screen.getByRole("button", { name: "reject LoanCard.interest" }));

    expect(await screen.findByText("Session validation failed")).toBeInTheDocument();
    expect(screen.getByText("releaseReady")).toBeInTheDocument();
  });
});
