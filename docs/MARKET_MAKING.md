# Market Making on Meridian

This document is for liquidity providers — proprietary trading firms, professional market makers, and DIY quoting bots. It explains the structural opportunity, the capital requirement, a worked numerical example, and how to integrate with the SDK.

If you trade options professionally and want the derivatives framing first, read [docs/FOR_OPTIONS_TRADERS.md](FOR_OPTIONS_TRADERS.md) before this one.

---

## 1. The opportunity

Meridian markets are 0DTE binary options on MAG7 daily closes. There are ~40 strikes live per trading day across the seven tickers. Each strike has its own on-chain CLOB (one `OrderBook` PDA per market). The maker–taker dynamic is the same as any CLOB venue:

- **Makers post limit orders** (resting bids on the Yes book; resting asks on the Yes book). These provide liquidity.
- **Takers cross the spread** to buy or sell at the best available price. These consume liquidity.

The market maker's profit per round-trip is the **bid–ask spread**, minus fees, minus adverse-selection cost. On a 2¢-wide market in a Yes at $0.65, a maker buying at $0.64 and selling at $0.66 captures $0.02 per pair before fees.

**Today's Meridian fee schedule:**
- Taker fee: parabolic curve, peaking at 1.5% × `p × (1 − p) × 4` (= 1.5% at p = 0.5, 0% at extremes).
- Maker rebate: 0.4% × `p × (1 − p) × 4` (when implemented; not yet live in the v1 program).

The maker rebate is the standard market-microstructure incentive: it pays you to provide liquidity. In v1 of Meridian the rebate is configured but not yet active — the spread alone is the maker's compensation. The rebate is on the roadmap; integrate against the SDK now and you'll get the rebate when it goes live.

---

## 2. Capital requirement

The capital requirement for Meridian MM is **$1 USDC per pair you want to inventory** — set by the on-chain invariant Yes + No = $1.

Compare to vanilla options MM:
- Vanilla options MM: post a delta-hedged quote → margin posted at the exchange + variation margin + funding for the underlying hedge. Typical capital footprint: $50K–$500K per ATM strike at retail size.
- Meridian MM: `mint_pair($1000)` → 1000 Yes + 1000 No tokens, ready to quote both sides. No margin, no variation, no funding. **Capital footprint: face value of pairs you want to hold.**

The structural reason: the Yes + No = $1 invariant is enforced atomically by the program. A market maker holding equal Yes and No inventory has *zero net exposure* — there is nothing to liquidate against. Margin only becomes relevant if you skew inventory away from pair-balanced (e.g., sell down your Yes inventory and accumulate cash; you're now exposed to the No-side outcome).

---

## 3. Worked example — quoting AAPL > $300 for a day

**Setup.** It's 9:30 AM ET. AAPL spot is $308.88 (from the live Hermes price at bootstrap). You want to quote the AAPL > $300 Yes market all day. Implied fair value (rough back-of-envelope): roughly P(S_T > $300) ≈ 0.72 given AAPL is at $308.88 with ~1% daily vol → ~28% chance of a 3% drawdown to below $300, so Yes ≈ $0.72.

**Step 1: Mint inventory.**

```
deposit 1000 USDC via mint_pair(1000)
→ receive 1000 Yes + 1000 No tokens
```

Capital deployed: $1000 USDC. Net exposure: zero.

**Step 2: Quote both sides.**

You want a 2¢ spread around your fair value of $0.72:
- Post 500 Yes **asks** at $0.73 (selling Yes at the offer)
- Post 500 Yes **bids** at $0.71 (buying Yes at the bid)

On the No side, the math is symmetric (No ask at $0.29, No bid at $0.27 — implemented via composite-tx as `Yes bid at 1-0.29 = $0.71` and `Yes ask at 1-0.27 = $0.73`). The same Yes/USDC order book serves both perspectives.

Net inventory after quotes are posted:
- 1000 Yes tokens, of which 500 are locked in resting asks (committed to sell if taken).
- 1000 No tokens, all sitting in your wallet.
- 0 USDC working capital (already deposited as mint-pair collateral).
- Order escrows hold the resting orders' collateral on-chain (USDC for bids, Yes tokens for asks).

**Step 3: Fills accumulate.**

Suppose by 11 AM, half your asks have filled (250 fills on the ask side) and a third of your bids (165 fills on the bid side). Net flows:

- **Ask fills:** 250 Yes sold at $0.73 → received 250 · $0.73 = $182.50 USDC. You now hold 750 Yes + 1000 No + $182.50 USDC.
- **Bid fills:** 165 Yes bought at $0.71 → paid 165 · $0.71 = $117.15 USDC. You now hold 915 Yes + 1000 No + $65.35 USDC.

Position state after these fills:
- 915 Yes tokens (matched: 165 of these are "new" inventory you'd accumulated by bidding).
- 1000 No tokens.
- $65.35 USDC.
- **Spread captured:** revenue from the round-trip = 250 fills × ($0.73 − $0.72) + 165 fills × ($0.72 − $0.71) = $2.50 + $1.65 = $4.15. Plus the directional drift: net inventory delta has decreased (sold more Yes than you bought), so you're now slightly net short Yes vs paired-balanced.

**Step 4: Re-quote.**

You re-mint with the freed USDC ($65.35 → 65 new pairs), refresh your quotes around updated fair value, and continue. By end of day (3:55 PM ET, just before settlement), say you've:

- Captured ~$25 in spread over the day from ~1500 round-trips.
- Net inventory: 850 Yes + 950 No tokens (slightly off pair-balanced — you've accumulated ~100 No tokens net).
- Cash on hand: $35.

**Step 5: Settle.**

At 4:00 PM ET, AAPL closes at $312 (above the $300 strike, so Yes wins). You redeem:
- 850 Yes at $1.00 = $850 USDC
- 950 No at $0.00 = $0 USDC
- + $35 cash on hand
= $885 USDC total

But wait — you started with $1000. You're down $115? Yes — and this is the critical lesson. Your **inventory imbalance** at settlement (850 Yes vs 950 No) means you were net *short* Yes going into a Yes-wins close. The 100-pair imbalance × $1 payoff difference = $100 of inventory loss. Net P&L:

```
Spread captured:       +$25
Inventory P&L:        -$100  (100 pairs short Yes into a Yes-wins close)
Net P&L:               -$75
```

**This is the central risk of binary-options market making.** Your spread is small (~$0.01–0.02 per round-trip); your inventory exposure can dwarf it. A good MM keeps inventory close to pair-balanced; a great MM hedges directional inventory via the underlying (Drift perps, see §5).

If you had hedged the 100-pair short-Yes inventory by going long ~30 shares of AAPL spot at 11:30 AM when the imbalance opened up, you'd have captured the spread and broken even on directional risk. With AAPL up 1% on the day, the spot hedge would have made $93 → spread + hedge − inventory loss = $25 + $93 − $100 = +$18 net.

---

## 4. Spread / size / fill-rate sensitivity

The MM economics are summarized by three knobs:

| Knob | Range | Effect on edge |
|---|---|---|
| Spread (bid–ask gap) | 1¢ – 5¢ | Wider = more edge per fill, fewer fills. |
| Size per quote | 10 – 10000 pairs | Larger = capital deployed, more inventory risk. |
| Skew (how far from fair value) | -2¢ to +2¢ | Skewing makes you take a directional bet; balanced has zero net. |

A reasonable starting strategy for a paper-trading MM bot on Meridian devnet:

- 1000 pairs minted ($1000 USDC capital).
- 2¢ spread (1¢ either side of mid).
- 100-pair clip size per resting order (10 resting orders per side, 20 total live).
- Re-quote every 30 seconds or on a 50-bps move in the underlying.
- Hard inventory cap of ±200 pairs from balanced; if exceeded, widen the closing side and tighten the opening side until balanced.

This strategy will capture roughly $5–$15 per day per strike on a typical day, before adverse selection. With 40 strikes live and modest scaling, a $40K MM book could plausibly generate $200–$600/day on devnet (subject to actual fill rates, which require live data).

---

## 5. Delta hedging via the underlying

The way to neutralize directional risk from inventory imbalance is to hedge with the underlying. On a centralized venue (Interactive Brokers, a prime broker), you'd short AAPL stock; on devnet there's no liquid spot. The recommended hedge venue for a production MM on Meridian is:

### Drift Protocol — MAG7 perpetual futures
- Drift offers perp futures on AAPL, MSFT, NVDA, TSLA, GOOGL, AMZN, META.
- Same chain (Solana), so atomic cross-venue hedging is possible via a single transaction.
- Funding rate is the cost of carry; typically annualized 5–15% depending on side.
- Documentation: https://docs.drift.trade

### Hedging mechanics
- For each 1 Yes contract you're net short (vs paired-balanced), your underlying delta exposure is roughly `delta_yes ≈ 1 − 2·yes_price` (the heuristic from [FOR_OPTIONS_TRADERS.md §3.1](FOR_OPTIONS_TRADERS.md)). At p=$0.72, delta ≈ -0.44 per Yes (negative because ITM).
- 100 pairs short Yes inventory → +44 shares-equivalent of AAPL exposure (you benefit if AAPL goes up).
- To neutralize: short ~44 USD-notional worth of AAPL perp on Drift.
- Rebalance the hedge as inventory and underlying price move during the day.

### Cross-venue atomicity
A sophisticated MM could compose Meridian + Drift instructions into a single Solana transaction: `mint_pair` + `place_order` (Meridian Yes ask) + Drift `open_position` (AAPL short) → either all succeed or all revert. This is the structural advantage of being on Solana — cross-venue hedging that, on Ethereum, would require multiple blocks of latency.

The Meridian SDK (in `app/lib/composite-tx.ts`) exports the atomic-composition primitives. A `delta-hedge.ts` helper that builds the cross-venue composite is on the roadmap (work in progress).

---

## 6. SDK integration

The TS-side primitives for market making live in `app/lib/composite-tx.ts`. Key functions:

```ts
// 1. Mint inventory
import { buildAndSendMintPair } from '@/lib/composite-tx';

await buildAndSendMintPair({
  market: marketPda,           // PDA for the (ticker, strike, expiry) market
  qty: 1000,                   // pairs to mint
  payer: walletPubkey,
  wallet,                      // wallet adapter for signing
  connection,
});
// → 1000 Yes + 1000 No in your ATAs; 1000 USDC locked in market vault.
```

```ts
// 2. Read the current order book
import { useOrderBook } from '@/lib/markets-client';

const { bids, asks, bestBid, bestAsk } = useOrderBook(marketPda);
// bids, asks are sorted price-time priority arrays.
// bestBid, bestAsk are the top of book.
```

```ts
// 3. Post a quote on both sides
import { buildAndSendTrade } from '@/lib/composite-tx';

// Ask at $0.66 (sell Yes you already hold)
await buildAndSendTrade({
  market: marketPda,
  side: 'sell-yes',
  qty: 100,
  limitPriceCents: 66,         // 66 cents
  payer: walletPubkey,
  wallet,
  connection,
});

// Bid at $0.64 (buy Yes with USDC)
await buildAndSendTrade({
  market: marketPda,
  side: 'buy-yes',
  qty: 100,
  limitPriceCents: 64,
  payer: walletPubkey,
  wallet,
  connection,
});
```

```ts
// 4. Cancel + re-quote on drift
import { buildAndSendCancelOrder } from '@/lib/cancel-order';

await buildAndSendCancelOrder({
  market: marketPda,
  orderId,                     // from your order-tracking map
  payer: walletPubkey,
  wallet,
  connection,
});
// Then re-quote at the new fair value.
```

### A minimal quoter loop

```ts
import { Connection } from '@solana/web3.js';
import { buildAndSendMintPair, buildAndSendTrade } from '@/lib/composite-tx';
import { buildAndSendCancelOrder } from '@/lib/cancel-order';
import { useOrderBook } from '@/lib/markets-client';

async function runQuoter(market, wallet, connection) {
  // 1. Bootstrap inventory.
  await buildAndSendMintPair({ market, qty: 1000, payer: wallet.publicKey, wallet, connection });

  let lastQuoteAt = 0;
  const SPREAD_CENTS = 2;
  const CLIP_SIZE = 100;
  const REQUOTE_INTERVAL_MS = 30_000;

  setInterval(async () => {
    // 2. Get the current book.
    const book = await getOrderBook(connection, market);
    const midCents = Math.round(((book.bestBid?.priceCents ?? 50) + (book.bestAsk?.priceCents ?? 50)) / 2);

    // 3. Cancel old quotes.
    await cancelAllMyOrders(connection, market, wallet);

    // 4. Post new quotes.
    const bidCents = midCents - SPREAD_CENTS / 2;
    const askCents = midCents + SPREAD_CENTS / 2;

    await buildAndSendTrade({
      market, side: 'buy-yes', qty: CLIP_SIZE, limitPriceCents: bidCents,
      payer: wallet.publicKey, wallet, connection
    });
    await buildAndSendTrade({
      market, side: 'sell-yes', qty: CLIP_SIZE, limitPriceCents: askCents,
      payer: wallet.publicKey, wallet, connection
    });

    lastQuoteAt = Date.now();
  }, REQUOTE_INTERVAL_MS);
}
```

This is a sketch — real production code needs:
- Inventory tracking and balancing logic (don't drift more than ±200 pairs from balanced).
- Cancel-on-drift logic (cancel-and-replace on >50 bps moves in the underlying).
- Self-trade prevention (don't fill your own resting orders).
- Error handling for the sweep loop (orders that race with takers may fail).
- Logging and P&L attribution per fill.

A more complete reference implementation is being developed in `scripts/mm-sdk.ts` (work in progress by another team agent).

---

## 7. Adverse selection — the real cost

The naive "MM captures spread" picture ignores adverse selection: the fills you get are systematically biased toward the directionally-informed taker. If a Yes price is $0.65 and someone aggressively crosses your $0.66 ask, they probably know something — perhaps the underlying just ticked up on a news headline. By the time your fill clears, the fair value is $0.68 and you've just sold a $0.68 thing for $0.66.

Adverse selection on Meridian is bounded compared to vanilla options MM because:
- 0DTE expiry: information advantage decays within hours, not weeks.
- Pyth oracle is the same data everyone uses; informational moats in single-name MAG7 equities are narrow.
- The on-chain order book is fully transparent; you see what's happening to the same data feed as your counterparty.

But it's not zero. Empirically, on similar 0DTE prediction markets (Polymarket, Kalshi), MMs report 30–60% of gross spread is given back to adverse selection. Plan accordingly: if your gross spread per round-trip is 2¢, your net edge is probably 0.8–1.4¢.

---

## 8. Operational checklist

For a serious MM bot on Meridian devnet (or future mainnet):

- [ ] Funded admin SOL wallet for transaction fees (~0.1 SOL per 100 quotes; budget accordingly).
- [ ] USDC inventory pre-positioned in a dedicated MM wallet.
- [ ] Quote-cancel infrastructure: order-ID tracking, batched cancels, watchdog for stuck orders.
- [ ] Inventory monitoring: alert if net pair imbalance exceeds X.
- [ ] Pyth feed monitoring: pause quoting if Pyth confidence widens beyond your fair-value-error tolerance.
- [ ] Pre-close behavior: as 4:00 PM ET approaches, *step away from strikes near current spot* to avoid pin risk.
- [ ] Settlement procedure: after 4:05 PM, `redeem` winning side, redeem-pair any remaining balanced inventory.
- [ ] Daily P&L reconciliation: gross spread captured, adverse selection cost, inventory P&L, hedge P&L (if hedging), fees.

---

## 9. Further reading

- [docs/FOR_OPTIONS_TRADERS.md](FOR_OPTIONS_TRADERS.md) §6 — capital efficiency derivation.
- [docs/RISKS.md](RISKS.md) §3 — order book bootstrap risk and operator-provided initial liquidity.
- [docs/RISKS.md](RISKS.md) §6 — Buy-No composite-tx capital flow (impacts maker quoting on the No side).
- [IMPLEMENTATION_PLAN.md §3](IMPLEMENTATION_PLAN.md) — fee model rationale (parabolic taker fee, maker rebate).
- [IMPLEMENTATION_PLAN.md §14.4 #4 + #6](IMPLEMENTATION_PLAN.md) — capital-efficiency framing for Peak6 evaluators and the MM SDK roadmap.

---

*If you're a market making firm interested in providing liquidity on Meridian, contact the project author (email in the repo footer). For mainnet, we'd want to coordinate around initial liquidity, fee tiers, and operational expectations.*
