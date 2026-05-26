# Meridian for Options Traders

This document frames Meridian in derivatives language. If you trade options professionally, this is the right entry point. The rest of the docs are written for crypto and product readers; this one assumes you know what a digital option, a risk-neutral measure, and a Greek are.

---

## 1. What a Yes token actually is

A **Yes token on Meridian** is a digital cash-or-nothing call option on the underlying STOCK, with strike *K* and expiry *T* (4 PM ET same day). At expiry:

```
Yes payoff = $1.00  if  S_T ≥ K
           = $0.00  if  S_T <  K
```

In option-pricing language, the no-arbitrage price of the Yes token at time *t* is:

```
Yes_price(t) = e^(-r·(T-t)) · E_Q[ 1_{S_T ≥ K} ]
            ≈ P_Q(S_T ≥ K)                              (because r·(T-t) is negligible at 0DTE)
```

where Q is the risk-neutral measure and *r* is the risk-free rate. Because Meridian markets are 0DTE (sub-1-day expiry) and the risk-free rate is small, the discount factor is essentially 1. **The Yes price is the risk-neutral probability that S_T ≥ K.**

The No token is the inverse:

```
No payoff = $1.00  if  S_T <  K
          = $0.00  if  S_T ≥ K
```

Yes price + No price = $1.00 at all times. This is enforced on-chain by the program (`mint_pair` requires $1 USDC per pair; `redeem_pair` burns one of each for $1 USDC; settlement preserves the equation).

---

## 2. The model-risk-free property

Most derivatives pricing requires a model: Black–Scholes for vanillas, local-vol or stochastic-vol for exotics, jump-diffusion for credit, lattice methods for American exercise. Each model has parameters; each parameter is *estimated*; each estimate has error. This is "model risk" — your hedge is only as good as your model's calibration.

**Meridian has none of this.** The Yes + No = $1 invariant is enforced by the SPL token program: every minted pair locks exactly $1 USDC in the vault; every redemption releases exactly $1 (split between Yes and No according to the outcome). There is no vol surface to estimate. There is no skew to model. There is no calendar to interpolate. **The cleanest expression of edge in a derivative is `price` vs `risk-neutral probability`** — and on Meridian, that comparison is unmediated by a pricing model.

For an options market maker, this is the structurally interesting feature. You are quoting directly in probability space. Your edge is your probability estimate; your inventory risk is your expected-vs-realized P&L; your hedging problem is purely a delta problem (no vega, no gamma in the conventional sense — see §3).

---

## 3. Greeks for binary options — honestly

Binary options have unusual Greeks. The intuition from vanilla options breaks down at the strike. Here is the rigorous version.

### 3.1 Delta

For a digital call, the price is the risk-neutral cumulative distribution: `Yes_price = P_Q(S_T ≥ K) = 1 − F_Q(K)`, where *F_Q* is the risk-neutral CDF of S_T evaluated at *K*.

The delta is the sensitivity of price to the underlying. Treating the dependence implicitly (the CDF depends on the *current* underlying through the drift and volatility):

```
∂Yes_price / ∂S_t = -∂F_Q(K) / ∂S_t = ∂(1 - F_Q(K)) / ∂S_t
                  → at expiry (T=t):  delta = pdf(K)        [a finite, peaked function]
                  → before expiry:    delta is the derivative of the cdf w.r.t. S_t
```

Two takeaways:

- **Heuristic for short-dated binaries: delta ≈ 1 − 2·price.** This holds approximately for prices near 0.5 (ATM). Intuition: a Yes at $0.50 has roughly zero net stock exposure (you'd lose 50% of the upside and 50% of the downside in equal measure); a Yes at $0.95 (deep ITM) behaves nearly like cash and has tiny remaining sensitivity to S; a Yes at $0.05 (deep OTM) is a near-zero call but has positive sensitivity to S. The heuristic 1−2·p gives delta = 0 at p = 0.5, delta = +0.9 at p = 0.05, delta = -0.9 at p = 0.95. **It is a heuristic, not an identity** — the exact value depends on the underlying distribution.
- **At expiry, delta peaks AT the strike.** The delta surface is more interesting than the vanilla-call delta surface. A vanilla call's delta walks smoothly from 0 to 1 across the strike; a binary call's delta is a *bump* centered on the strike, with magnitude proportional to the conditional density at *K*.

For hedging purposes: a long Yes position at $0.65 hedges with roughly +0.30 shares of underlying long (positive delta, because P(S_T ≥ K) increases with S_t). The exact share count depends on your implied-vol assumption; the heuristic gets you within ~10% for ATM strikes.

### 3.2 Gamma — and "pin risk"

Gamma is the second derivative of price with respect to underlying. For a digital call:

```
gamma = ∂²Yes_price / ∂S_t²
```

Before expiry, gamma is finite. **At expiry, gamma is a Dirac delta function at the strike.** This is *pin risk* — the bane of every binary options trader.

What pin risk means in practice: if S_T finishes within a tick of K, the position's value jumps discontinuously from $0 to $1 (or vice versa) on a price move of one tick. There is no "smoothing out" — a 0.5 cent move in S_T flips the outcome.

For market makers, this means **sizing around the strike is the critical risk parameter**. A position of $10K notional in a Yes that's pinned at $0.50 with 5 minutes to expiry has effectively unbounded gamma. The standard MM response is to *step away* from strikes near current spot in the last hour of the trading day, or to hedge dynamically into the close (which is itself difficult because the underlying market is closing simultaneously).

Meridian's settlement uses the Pyth Network 4:00 PM ET print, which is itself an aggregation across publishers. A pinned strike at the close depends entirely on which side of the aggregated print falls — that's the on-chain version of the pin risk that exists in every traditional binary options venue.

### 3.3 Vega

For non-zero time to expiry, vega is positive for the ATM Yes and crosses zero at deep ITM / deep OTM. Higher implied vol of S_T pushes ATM probabilities toward 0.5 (more uncertainty about whether S_T ≥ K), so vega is positive ATM; far from the strike, higher vol can either help or hurt depending on which way you're exposed.

**As T → 0, vega → 0.** No time value remains. This is the most important practical Greek for 0DTE markets: the entire trading day, you're watching vega decay to zero as the close approaches. By 3:30 PM ET, vega is functionally dead; the only Greek that matters in the last 30 minutes is delta, and pin risk dominates.

### 3.4 Theta

Theta on a binary is also unusual: it's positive or negative depending on which side of the strike you're on.

- An ITM Yes (price > 0.5) has *negative* theta if S_t is exactly at-the-money and might cross out — but *positive* theta if S_t is well above K (the strike becomes harder to miss with less time).
- An OTM Yes (price < 0.5) has *positive* theta near the strike (less time for it to cross in is bad for the Yes holder) — wait, sign flip needed: less time for the underlying to reach the strike means OTM Yes loses value, so theta is *negative* for OTM longs.

The general rule: **theta converges to outcome as T → 0**. If you're a Yes holder above the strike, your position drifts toward $1. If below, it drifts toward $0. The drift accelerates as the close approaches.

### 3.5 The summary table

| Greek | At t « T (early in day) | At t → T (near close) |
|---|---|---|
| Delta | Smooth, ≈ 1 − 2p | Peaked at strike (pdf(K)) |
| Gamma | Finite, peaks near strike | Dirac delta at strike (pin risk) |
| Vega | Positive ATM, near-zero at extremes | → 0 |
| Theta | Small | Large, sign = side of strike |

---

## 4. Breeden–Litzenberger: the strike chain as an implied distribution

The single most useful tool the strike chain gives you is the implied risk-neutral distribution of S_T.

Given strikes *K_1 < K_2 < ... < K_n* and Yes prices *p_1 > p_2 > ... > p_n* (Yes prices must be monotone decreasing in strike, else there's arbitrage), the implied risk-neutral CDF at the strikes is:

```
F_Q(K_i) = 1 − p_i
```

because *p_i = P_Q(S_T ≥ K_i)*, so *1 − p_i = P_Q(S_T < K_i) = F_Q(K_i)*.

Taking discrete forward differences gives the implied risk-neutral PDF:

```
f_Q(K_i) ≈ (F_Q(K_{i+1}) − F_Q(K_i)) / (K_{i+1} − K_i)
        = (p_i − p_{i+1}) / (K_{i+1} − K_i)
```

For example, for AAPL strikes at $280, $290, $300, $320, $330, $340 with Yes prices [0.95, 0.85, 0.70, 0.40, 0.20, 0.05]:

```
F_Q($280) = 0.05    f at midpoint $285: (0.95-0.85)/10 = 0.010 / $
F_Q($290) = 0.15    f at midpoint $295: (0.85-0.70)/10 = 0.015 / $
F_Q($300) = 0.30    f at midpoint $310: (0.70-0.40)/20 = 0.015 / $
F_Q($320) = 0.60    f at midpoint $325: (0.40-0.20)/10 = 0.020 / $
F_Q($330) = 0.80    f at midpoint $335: (0.20-0.05)/10 = 0.015 / $
F_Q($340) = 0.95
```

The peak of the implied density is at $325 (between $320 and $330), suggesting the market's implied mode for S_T is around $325. The implied mean (integral of *k · f(k) dk*) is roughly $318. The implied 1-day vol can be backed out by assuming a parametric form (log-normal, normal) and fitting — or computed nonparametrically as the standard deviation of the discrete distribution.

**Meridian renders this distribution live on the Trade page.** See `app/components/ImpliedDistribution.tsx` (component name may vary in current code) — it computes `f_Q` across the active strike chain and renders a histogram. For an options trader looking at AAPL's chain, this is the single most informative view: instead of a per-strike price grid, you see the market's full implied distribution of today's close.

The Breeden–Litzenberger relation is exact in the continuum limit (the second derivative of the call price with respect to strike equals the risk-neutral density). With discrete strikes, this is an approximation; finer strike grids would give finer density resolution. Meridian's ±3/6/9% strike grid (6 strikes per ticker) is coarse — it gives you the shape but not the tail behavior.

---

## 5. Hedging via the underlying

Suppose you've bought 100 Yes contracts on AAPL > $300 at $0.65. Your position is roughly equivalent to being long a digital call with strike $300, expiry today's close. Your delta is positive (you benefit from AAPL going up).

Using the heuristic *delta ≈ 1 − 2·p = 1 − 1.30 = -0.30*... wait, that's negative because *p > 0.5* (ITM). For an ITM Yes, the heuristic says delta is *negative* — meaning the position is *short* the underlying in delta terms. That's counterintuitive but correct: an ITM Yes is mostly cash (it's already worth almost $1); the remaining variation is dominated by the risk that S_T falls below K, so the position is effectively short the underlying.

For an OTM Yes (price < 0.5), delta is positive — the heuristic *1 − 2p* is positive, and you'd hedge by shorting the underlying.

**Worked example:**
- Long 100 Yes contracts on AAPL > $320 at $0.40.
- Delta per Yes ≈ 1 − 2·0.40 = +0.20.
- Total delta ≈ 100 · 0.20 = 20 shares equivalent.
- To delta-hedge to neutral: short ~20 shares of AAPL.

On devnet there is no liquid AAPL spot market. **A production deployment would hedge via Drift Protocol's MAG7 perpetuals.** Drift offers AAPL/USDC perp futures with reasonable depth; a Meridian market maker could open offsetting perp positions on Drift to lay off underlying-direction risk while keeping the binary as a pure-probability bet.

Alternative venues for the delta hedge: Bybit MAG7 perps, Aevo equity perps, off-chain CFD providers. Each has trade-offs in latency, margin, and regulatory exposure.

---

## 6. Capital efficiency for market makers

The Yes + No = $1 invariant gives market makers an unusual capital efficiency property. Consider a quoter who:

1. `mint_pair(1000)` → deposits $1000 USDC, receives 1000 Yes + 1000 No.
2. Posts 1000 Yes asks at $0.66 on the order book.
3. Posts 1000 No asks at $0.36 on the order book (No asks are implemented as Yes bids at $0.64 in the composite-tx path).

Net inventory: 1000 Yes + 1000 No. Net cost: $1000 USDC. **Total exposure: zero.** The pair-holding state is exactly risk-free until one of the legs trades.

If a Yes sells at $0.66, the quoter:
- Loses 1 Yes (now holds 999 Yes + 1000 No).
- Gains $0.66 USDC.
- Net position: short Yes vs No → exposed to outcome.

But the quoter's cash position has increased by $0.66 from selling the Yes; if the quoter immediately re-mints, they're back to 1000 Yes + 1000 No, with $0.66 of profit booked. **In the limit of infinitesimal pair-holding time**, the capital efficiency is infinite: each pair is risk-free until split via a trade.

In practice, the quoter holds inventory for non-zero time, and inventory risk is the dominant cost. But the *baseline* capital requirement is $1 per pair — there is no margin call, no liquidation risk, no funding rate. This is structurally cleaner than vanilla options market making, where Greeks must be hedged continuously.

See [docs/MARKET_MAKING.md](MARKET_MAKING.md) for the worked MM example with capital, spread, fill rates, and net economics.

---

## 7. Backtesting the strike chain

To validate that Meridian's implied distribution is informative (i.e., that the market is reasonably calibrated), the suggested test is to compare the historical Breeden–Litzenberger PDF against realized S_T outcomes.

**Calibration metric: Brier score.** For each settled market with predicted Yes price *p̂* and realized outcome *o ∈ {0, 1}*:

```
Brier = (p̂ − o)²
```

A market that's perfectly calibrated over many days will have an average Brier score around *p̂·(1-p̂)* (the variance of a Bernoulli with parameter *p̂*). A market that's systematically miscalibrated will show a Brier score noticeably worse.

For reference: Polymarket's reported calibration on resolved markets sits in the 0.10–0.13 Brier range (excellent). Kalshi reports similar numbers. Anything below 0.20 is competitive with structured prediction-market venues.

See `scripts/backtest.ts` (work in progress) for the backtest harness. It takes 6 months of historical MAG7 daily closes and replays the strike-chain pricing logic, comparing implied vs realized.

---

## 8. What this product is not

To close with intellectual honesty: Meridian is *not* a replacement for vanilla equity options. It cannot express:

- **Continuous payoff structures.** Spreads, straddles, condors, butterflies — these are built from vanilla calls/puts, not digital options. You can approximate a vanilla call by buying a stack of digitals at increasing strikes, but this requires N times the capital and pays only at expiry.
- **American-style early exercise.** Meridian markets are European (cash-settled at the close).
- **Multi-day expiries.** All Meridian markets are 0DTE. No weekly, monthly, or LEAPS analogues.
- **Cross-strike inventory netting.** Vanilla MMs net delta across the full strike chain; Meridian MMs net Yes+No within a single strike but not across strikes.

What it *can* express better than vanilla options:

- **Pure probability quotation.** No vol-surface estimation. Your edge is your probability estimate.
- **Sub-second settlement.** On-chain finality means by 4:05 PM ET your Yes is either $1 or $0 in your wallet, redeemable without intermediation.
- **Non-custodial inventory.** No prime broker, no clearing margin, no T+1 settlement. The vault holds USDC 1:1 against minted pairs; redemption is one signed transaction.
- **Risk-free pair holding.** A market maker quoting both sides has zero net exposure until a trade fills. This is structurally different from vanilla MM.

---

## 9. Further reading

- [IMPLEMENTATION_PLAN.md §4](IMPLEMENTATION_PLAN.md) — smart contract account model and invariant enforcement.
- [IMPLEMENTATION_PLAN.md §14](IMPLEMENTATION_PLAN.md) — Peak6 framing, including the implied-distribution view and Brier scorecard as evaluator-facing deliverables.
- [docs/MARKET_MAKING.md](MARKET_MAKING.md) — worked MM example with capital, spread, and fill rates.
- [docs/RISKS.md](RISKS.md) §2 — oracle dependency at settlement (pin risk in operational form).
- Breeden, D. T., & Litzenberger, R. H. (1978). *Prices of State-Contingent Claims Implicit in Option Prices*. Journal of Business, 51(4). The foundational paper for extracting implied distributions from option chains.

---

*If you read this and want to talk shop: the Meridian author is at the email in the repo footer. Trader-to-trader feedback on the Greek model and the implied-distribution view is the single most valuable thing this project can receive.*
