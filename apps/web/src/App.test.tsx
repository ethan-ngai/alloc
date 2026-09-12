import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { WorkspaceData } from "./data";

const fixture: WorkspaceData = {
  request: {
    revision: 3,
    purpose: "Buffalo Beacon pilot trip",
    state: "review_required",
    fullAmount: { amountMinor: 24000, currency: "USD" },
    cumulativeIncrease: { amountMinor: 6000, currency: "USD" },
    submittedAt: "2026-09-12T14:02:00Z",
    sourceRevision: "1",
  },
  decisionReason: "CUMULATIVE_AMENDMENT_LIMIT_EXCEEDED",
  budget: {
    authorized: { amountMinor: 50000, currency: "USD" },
    recognized: { amountMinor: 12000, currency: "USD" },
    committed: { amountMinor: 21000, currency: "USD" },
    available: { amountMinor: 17000, currency: "USD" },
  },
  facts: [{ label: "Budget authorized amount", value: { amountMinor: 50000, currency: "USD" }, source: "source_mock_simulator", trust: "authoritative" }],
  evidence: [{ title: "Active trip authorization", content: "Synthetic evidence.", source: "source_mock_simulator", trust: "evidence" }],
  forecast: {
    revision: 2,
    total: { amountMinor: 30000, currency: "USD" },
    asOf: "2026-09-12T14:00:00Z",
    horizonEnd: "2026-09-30T23:59:59Z",
    components: [
      { kind: "actual_spend", amount: { amountMinor: 12000, currency: "USD" } },
      { kind: "outstanding_commitment", amount: { amountMinor: 18000, currency: "USD" } },
    ],
    warnings: [],
  },
  activity: [{ id: "activity_1", type: "request", occurredAt: "2026-09-12T14:02:00Z", summary: "Request revision 3 review_required" }],
  asOf: "2026-09-12T14:02:00Z",
  scenarioId: "scenario_mock_northstar_v1",
};

vi.mock("./data", async () => {
  const actual = await vi.importActual<typeof import("./data")>("./data");
  return { ...actual, loadWorkspace: vi.fn(async () => fixture), approveReview: vi.fn(async () => undefined) };
});

describe("Alloc workspace", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders exact financial state and the non-additive scope warning", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByText("$500.00 USD")).toBeInTheDocument();
    expect(screen.getByText(/scope view · not additive/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review request/i })).toBeEnabled();
  });

  it("keeps all primary screens reachable with named controls", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Overview" });
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    expect(screen.getByRole("heading", { name: "Memory" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search company memory")).toHaveValue("Budget");
    fireEvent.click(screen.getByRole("button", { name: "Forecast" }));
    expect(screen.getByRole("heading", { name: "Forecast" })).toBeInTheDocument();
    expect(screen.getByText("Calculation record")).toBeInTheDocument();
  });

  it("records a human review through the action without hiding its mocked status", async () => {
    const data = await import("./data");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /review request/i }));
    expect(screen.getByRole("dialog", { name: /approve revision 3/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /approve revision 3/i }));
    await waitFor(() => expect(data.approveReview).toHaveBeenCalledWith(expect.objectContaining({ key: "northstar" }), 3));
    expect(screen.getByText(/authenticated human decision · mocked/i)).toBeInTheDocument();
  });
});
