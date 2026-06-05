// closed-positions.test.ts — regression tests for deriveClosedPositions.
// Gap (2026-06-05): realized P&L existed ONLY for positions held to settlement;
// buying 10 Yes @63¢ then selling @57¢ (a real −$0.60) showed NOWHERE in the
// portfolio — the position vanished from "active" without entering "settled".

import { expect } from "chai";

import { deriveClosedPositions } from "../../app/lib/closed-positions";
import type { HistoryRow } from "../../app/lib/history-intent";

let seq = 0;
function fill(
  type: "buy" | "sell",
  side: "yes" | "no",
  quantity: number,
  price: number,
  over: Partial<HistoryRow> = {},
): HistoryRow {
  seq += 1;
  return {
    ts: seq * 1000,
    type,
    ticker: "GOOGL" as HistoryRow["ticker"],
    strike: 36000,
    side,
    quantity,
    price,
    feeCents: 0,
    status: "filled",
    txSig: `sig${seq}`,
    ...over,
  };
}

describe("deriveClosedPositions", () => {
  beforeEach(() => {
    seq = 0;
  });

  it("buy 10 @63 then sell 10 @57 → one closed position, realized −$0.60 (the reported gap)", () => {
    const { closed, realizedDollars } = deriveClosedPositions([
      fill("buy", "yes", 10, 63),
      fill("sell", "yes", 10, 57),
    ]);
    expect(closed).to.have.length(1);
    expect(closed[0]).to.include({
      side: "yes",
      quantity: 10,
      avgEntryCents: 63,
      avgExitCents: 57,
    });
    expect(realizedDollars).to.be.closeTo(-0.6, 1e-9);
  });

  it("partial close realizes only the sold slice; remainder stays open (excluded)", () => {
    const { closed, realizedDollars } = deriveClosedPositions([
      fill("buy", "yes", 10, 60),
      fill("sell", "yes", 4, 70),
    ]);
    expect(closed).to.have.length(1);
    expect(closed[0].quantity).to.equal(4);
    expect(realizedDollars).to.be.closeTo(0.4, 1e-9);
  });

  it("weighted-average entry across multiple buys", () => {
    const { closed, realizedDollars } = deriveClosedPositions([
      fill("buy", "yes", 5, 40),
      fill("buy", "yes", 5, 60), // avg 50
      fill("sell", "yes", 10, 55),
    ]);
    expect(closed[0]).to.include({ avgEntryCents: 50, avgExitCents: 55 });
    expect(realizedDollars).to.be.closeTo(0.5, 1e-9);
  });

  it("sells with no known basis are ignored (no invented P&L)", () => {
    const { closed, realizedDollars } = deriveClosedPositions([
      fill("sell", "yes", 10, 57),
    ]);
    expect(closed).to.have.length(0);
    expect(realizedDollars).to.equal(0);
  });

  it("yes and no sides are tracked independently", () => {
    const { closed, realizedDollars } = deriveClosedPositions([
      fill("buy", "no", 10, 43),
      fill("sell", "no", 10, 37),
      fill("buy", "yes", 10, 63),
    ]);
    expect(closed).to.have.length(1);
    expect(closed[0]).to.include({ side: "no", quantity: 10 });
    expect(realizedDollars).to.be.closeTo(-0.6, 1e-9);
  });

  it("ignores cancelled rows and replays by timestamp, not array order", () => {
    const sell = fill("sell", "yes", 10, 57);
    const buy = fill("buy", "yes", 10, 63);
    // Force the buy to precede the sell chronologically despite array order.
    buy.ts = 500;
    const cancelled = fill("buy", "yes", 99, 1, { status: "cancelled" });
    const { closed, realizedDollars } = deriveClosedPositions([sell, buy, cancelled]);
    expect(closed).to.have.length(1);
    expect(closed[0].quantity).to.equal(10);
    expect(realizedDollars).to.be.closeTo(-0.6, 1e-9);
  });
});
