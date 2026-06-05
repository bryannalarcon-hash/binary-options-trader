// history-intent.test.ts — regression tests for buildTxHistoryRows.
// Bug (2026-06-05): selling YES showed as "Sold No · below strike" in history —
// the decoder conflated CLOB book-side (bid/ask) with outcome (yes/no). Also:
// maker fills took the taker's direction, and composite No-trades leaked their
// mint/sell plumbing as separate confusing rows.

import { expect } from "chai";

import { buildTxHistoryRows } from "../../app/lib/history-intent";

const ME = "MyWallet1111111111111111111111111111111111";
const OTHER = "OtherGuy111111111111111111111111111111111";
const MKT = "MarketAddr11111111111111111111111111111111";

const lookupMarket = (addr: string) =>
  addr === MKT ? { ticker: "GOOGL" as const, strike: 36000 } : undefined;

const OPTS = { myKey: ME, txSig: "sig1", ts: 1_780_700_000_000, lookupMarket };

describe("buildTxHistoryRows", () => {
  it("taker bid alone → Bought Yes at p", () => {
    const rows = buildTxHistoryRows(
      [{ name: "orderMatched", data: { taker: ME, maker: OTHER, market: MKT, takerSide: 0, price: 63, size: 10 } }],
      OPTS,
    );
    expect(rows).to.have.length(1);
    expect(rows[0]).to.include({ type: "buy", side: "yes", price: 63, quantity: 10 });
  });

  it("taker ask alone → Sold YES (not 'Sold No' — the reported bug)", () => {
    const rows = buildTxHistoryRows(
      [{ name: "orderMatched", data: { taker: ME, maker: OTHER, market: MKT, takerSide: 1, price: 57, size: 10 } }],
      OPTS,
    );
    expect(rows).to.have.length(1);
    expect(rows[0]).to.include({ type: "sell", side: "yes", price: 57, quantity: 10 });
  });

  it("Buy No composite (mint_pair + ask) → ONE 'Bought No @ 100−p' row, mint suppressed", () => {
    const rows = buildTxHistoryRows(
      [
        { name: "pairMinted", data: { user: ME, market: MKT, amountPairs: 10 } },
        { name: "orderMatched", data: { taker: ME, maker: OTHER, market: MKT, takerSide: 1, price: 57, size: 10 } },
      ],
      OPTS,
    );
    expect(rows).to.have.length(1);
    expect(rows[0]).to.include({ type: "buy", side: "no", price: 43, quantity: 10 });
  });

  it("Sell No composite (bid + redeem_pair) → ONE 'Sold No @ 100−p' row, redeem suppressed", () => {
    const rows = buildTxHistoryRows(
      [
        { name: "orderMatched", data: { taker: ME, maker: OTHER, market: MKT, takerSide: 0, price: 63, size: 10 } },
        { name: "pairRedeemed", data: { user: ME, market: MKT, amountPairs: 10 } },
      ],
      OPTS,
    );
    expect(rows).to.have.length(1);
    expect(rows[0]).to.include({ type: "sell", side: "no", price: 37, quantity: 10 });
  });

  it("maker hit by a taker bid → I Sold Yes (direction inverted from taker)", () => {
    const rows = buildTxHistoryRows(
      [{ name: "orderMatched", data: { taker: OTHER, maker: ME, market: MKT, takerSide: 0, price: 60, size: 5 } }],
      OPTS,
    );
    expect(rows).to.have.length(1);
    expect(rows[0]).to.include({ type: "sell", side: "yes", price: 60, quantity: 5 });
  });

  it("Buy No with resting remainder labels the OrderPlaced leg as Bought No too", () => {
    const rows = buildTxHistoryRows(
      [
        { name: "pairMinted", data: { user: ME, market: MKT, amountPairs: 10 } },
        { name: "orderMatched", data: { taker: ME, maker: OTHER, market: MKT, takerSide: 1, price: 57, size: 6 } },
        { name: "orderPlaced", data: { user: ME, market: MKT, side: 1, price: 57, size: 4 } },
      ],
      OPTS,
    );
    expect(rows).to.have.length(2);
    expect(rows[0]).to.include({ type: "buy", side: "no", price: 43, quantity: 6 });
    expect(rows[1]).to.include({ type: "buy", side: "no", price: 43, quantity: 4 });
  });

  it("standalone mint / settlement redeem rows are preserved", () => {
    const rows = buildTxHistoryRows(
      [
        { name: "pairMinted", data: { user: ME, market: MKT, amountPairs: 7 } },
        { name: "redeemed", data: { user: ME, market: MKT, side: 0, amountBurned: 3, usdcPaid: 3_000_000 } },
      ],
      OPTS,
    );
    expect(rows).to.have.length(2);
    expect(rows.find((r) => r.type === "mint_pair")).to.include({ quantity: 7, side: null });
    expect(rows.find((r) => r.type === "redeem")).to.include({ side: "yes", quantity: 3, price: 100 });
  });

  it("ignores other users' events and unknown markets; stamps ts/txSig", () => {
    const rows = buildTxHistoryRows(
      [
        { name: "orderMatched", data: { taker: OTHER, maker: OTHER, market: MKT, takerSide: 0, price: 50, size: 1 } },
        { name: "orderMatched", data: { taker: ME, maker: OTHER, market: "UnknownMkt", takerSide: 0, price: 50, size: 1 } },
        { name: "orderMatched", data: { taker: ME, maker: OTHER, market: MKT, takerSide: 0, price: 50, size: 1 } },
      ],
      OPTS,
    );
    expect(rows).to.have.length(1);
    expect(rows[0]).to.include({ ts: OPTS.ts, txSig: "sig1" });
  });
});
