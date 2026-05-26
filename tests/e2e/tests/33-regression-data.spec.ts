/**
 * 33-regression-data.spec.ts
 *
 * REAL on-chain DATA-INTEGRITY regression suite for Meridian (Solana localnet @
 * http://localhost:3000). NO mocks — every assertion drives the live UI / live
 * HTTP services and is cross-checked against on-chain truth read directly via
 * the automation anchor context.
 *
 * TICKER (for any position we open): META — a value-stable MAG7 ticker. Sibling
 * agents own other tickers; using a private ticker keeps our resting orders /
 * positions from colliding on the shared on-chain books.
 *
 * The four items under test (one `test(...)` each, the originating bug cited
 * inline):
 *
 *   #5  Frontend display layer was MOCKED (fake AAPL $220 vs real ~$309) before
 *       de-mocking. REGRESSION: /markets and /trade/META leak NO fake/placeholder
 *       text; META's shown oracle spot is a REAL $NNN.NN > 0 and matches the
 *       on-chain oracle; several MAG7 tickers show DISTINCT real spots (not one
 *       hardcoded number).
 *
 *   #18 App served a STALE NEXT_PUBLIC_USDC_MINT (started before bootstrap
 *       rewrote it) → $0 balances + AccountNotInitialized(3012) on trades.
 *       REGRESSION: connectAndFund the demo wallet and assert the HEADER USDC
 *       becomes >= 1 — proves the app's mint matches the mint the faucet/admin
 *       actually minted (a stale mint would show $0 forever).
 *
 *   #17 Faucet returned TokenAccountNotFoundError every time (stale duplicate
 *       automation w/ wrong mint). REGRESSION: a direct faucet smoke test —
 *       POST :3001/faucet with a FRESH random base58 pubkey and assert the JSON
 *       has ok:true and usdc>0.
 *
 *   PORTFOLIO MATH + "Winning vs losing" inconsistency: open a META position
 *       with a REAL cost basis (a crossing BUY fill via a 2-context maker→taker
 *       flow — Quick Mint alone yields NO cost basis, see positions-client
 *       deriveCostBasis which intentionally skips mint_pair). On /portfolio
 *       assert the open-position row math is self-consistent
 *       (Cost = qty×avg/100, Value = qty×mark/100, Unrealized = Value−Cost) and
 *       DOCUMENT the known inconsistency: the "Winning" pill (ITM: spot>strike)
 *       can disagree with the header "Win rate" (counts winners by mark>entry).
 *       We lock in current behavior with SOFT assertions — we do NOT fail on the
 *       inconsistency so a future UI reconciliation is intentional.
 *
 * Source the selectors mirror:
 *   - app/app/portfolio/page.tsx       (open-position table + Win rate summary)
 *   - app/app/portfolio/mm/page.tsx    (Quick Mint "Mint Pairs", Quote Both Sides)
 *   - app/app/trade/[ticker]/[strike]/TradePageClient.tsx (header "· spot $NNN.NN")
 *   - app/components/caret/fmt.ts      (fmt$ → "$N,NNN.NN")
 *   - automation/src/faucet.ts         (POST /faucet → { ok, usdc, ... })
 */

import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { Keypair } from "@solana/web3.js";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  connectAndFund,
  connectDemoWallet,
  headerUsdc,
} from "../fixtures/demo-wallet";

const TICKER = "META";
const AUTOMATION = process.env.E2E_AUTOMATION_URL || "http://localhost:3001";

// MAG7 tickers we assert resolve to REAL distinct oracle spots. (TSLA/NVDA are
// mutated by sibling swarms, so we read them as on-chain truth — not pinned —
// but still include them for the "distinct values" leak check on the UI.)
const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "META"] as const;

// -----------------------------------------------------------------------------
// On-chain oracle truth — read the SAME OracleAccount PDAs the app reads
// (seeds ["oracle", ticker], price in cents, expo -2) via the automation anchor
// context, in a one-shot child process. This is the ground truth the UI's
// displayed spot must match. NOT a mock — a direct RPC read of the validator.
// -----------------------------------------------------------------------------
let ORACLE_TRUTH: Record<string, number> | null = null;

/** Repo root = tests/.. (this file lives at tests/e2e/tests/). */
function repoRoot(): string {
  return path.resolve(__dirname, "..", "..", "..");
}

/**
 * Read every MAG7 ticker's on-chain oracle spot (USD) by executing a tiny tsx
 * script that reuses automation's anchor context. Returns { TICKER: spotUsd }.
 * Cached for the run. Throws (fails the test) if the read can't be performed —
 * we never silently fall back to a guess.
 */
function readOnChainOracleSpots(): Record<string, number> {
  if (ORACLE_TRUTH) return ORACLE_TRUTH;
  const root = repoRoot();
  const tsxBin = path.join(root, "automation", "node_modules", ".bin", "tsx");
  const script = path.join(root, "tests", "e2e", "scripts", `.oracle-${process.pid}.ts`);
  const body = `
import { buildAnchorContext } from "../../../automation/src/lib/anchor";
import { env } from "../../../automation/src/env";
import { PublicKey } from "@solana/web3.js";
const ORACLE_SEED = Buffer.from("oracle");
const num = (v: any) =>
  typeof v === "number" ? v : v?.toNumber ? v.toNumber() : Number(v?.toString?.() ?? v);
async function main() {
  const anchor = buildAnchorContext(env.adminKeypairPath);
  const program = anchor.program;
  const pid = program.programId;
  const tickers = ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "NVDA"];
  const out: Record<string, number> = {};
  for (const t of tickers) {
    const [pda] = PublicKey.findProgramAddressSync(
      [ORACLE_SEED, Buffer.from(t, "utf8")], pid);
    try {
      const a: any = await (program.account as any).oracleAccount.fetch(pda);
      out[t] = num(a.price) / 100;
    } catch { /* missing oracle — omit */ }
  }
  console.log(JSON.stringify(out));
}
main().catch((e) => { console.error(e); process.exit(1); });
`;
  fs.writeFileSync(script, body, "utf8");
  try {
    const stdout = execFileSync(tsxBin, [script], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
    const json = stdout.trim().split("\n").pop() || "{}";
    ORACLE_TRUTH = JSON.parse(json) as Record<string, number>;
    return ORACLE_TRUTH;
  } finally {
    try {
      fs.unlinkSync(script);
    } catch {
      /* best effort */
    }
  }
}

/** All MAG7 cards/labels render their spot via fmt$ → "$N,NNN.NN". */
function dollarsFromText(text: string): number | null {
  const m = text.match(/\$([\d,]+\.\d{2})/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

test.describe("Regression: data integrity (REAL on-chain)", () => {
  test.beforeEach(({}, testInfo) => {
    // On-chain confirms + balance refresh + first-paint reads are slow.
    testInfo.setTimeout(120_000);
  });

  // ===========================================================================
  // ITEM #5 — De-mocked frontend display layer.
  // BUG: the frontend display layer was MOCKED (showed a fake AAPL $220 instead
  //      of the real ~$309) before de-mocking.
  // REGRESSION: /markets and /trade/META must leak NO fake/placeholder text; the
  //      META oracle spot shown is a real $NNN.NN > 0 matching the on-chain
  //      oracle; several MAG7 tickers show DISTINCT real spots (not one
  //      hardcoded number).
  // ===========================================================================
  test("ITEM5: no mock/placeholder leak; META spot is real & matches chain; MAG7 distinct", async ({
    page,
  }) => {
    // Ground truth straight off the validator.
    const truth = readOnChainOracleSpots();
    expect(truth.META, "on-chain META oracle should exist & be > 0").toBeGreaterThan(0);

    // --- /markets ---------------------------------------------------------
    await page.goto("/markets", { waitUntil: "domcontentloaded", timeout: 45_000 });
    await expect(page.getByRole("heading", { name: /^Markets$/i })).toBeVisible({
      timeout: 25_000,
    });
    // Wait for the on-chain oracle reads to paint at least one real "oracle spot".
    await expect(page.getByText(/oracle spot/i).first()).toBeVisible({ timeout: 25_000 });

    // Locate each MAG7 card and wait until its spot resolves to a real $NNN.NN.
    const cardFor = (sym: string) =>
      page
        .locator('div[role="link"]')
        .filter({ has: page.locator(".card") })
        .filter({ hasText: new RegExp(`\\b${sym}\\b`) })
        .first();

    const uiSpots: Record<string, number> = {};
    for (const sym of MAG7) {
      const card = cardFor(sym);
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(
          async () => dollarsFromText(await card.innerText()),
          {
            timeout: 45_000,
            intervals: [500, 1000, 2000, 3000],
            message: `${sym} oracle spot never resolved to a $NNN.NN value`,
          },
        )
        .not.toBeNull();
      uiSpots[sym] = dollarsFromText(await card.innerText())!;
      expect(uiSpots[sym], `${sym} spot must be a positive price`).toBeGreaterThan(0);
    }

    // (a) Several MAG7 tickers show DISTINCT real spots — a single hardcoded
    //     number (the old mock) would collapse these to one value.
    const distinct = new Set(MAG7.map((s) => uiSpots[s]));
    expect(
      distinct.size,
      `MAG7 spots must be distinct real values, got: ${JSON.stringify(uiSpots)}`,
    ).toBeGreaterThanOrEqual(4);

    // (b) Each UI spot matches the on-chain oracle within reason (rounding/format
    //     and any tick drift between read and paint). fmt$ is exact to 2dp, so a
    //     small absolute tolerance is plenty; mismatch = a stale/synthetic value.
    for (const sym of MAG7) {
      if (truth[sym] == null) continue;
      expect(
        Math.abs(uiSpots[sym] - truth[sym]),
        `${sym} UI spot ${uiSpots[sym]} should match on-chain ${truth[sym]}`,
      ).toBeLessThanOrEqual(1.0);
    }

    // (c) NO fake/placeholder text leaks on /markets. The old mock surfaced fake
    //     data; assert none of these synthetic-data sentinels appear (the
    //     literal "$220.00" check guards the specific old fake AAPL price).
    const marketsBody = await page.locator("body").innerText();
    expect(
      marketsBody,
      "markets page must not leak synthetic-data sentinels",
    ).not.toMatch(/lorem|placeholder|mock|stub|dummy|\$220\.00\b/i);

    // --- /trade/META ------------------------------------------------------
    await page.goto(`/trade/${TICKER}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForURL(new RegExp(`/trade/${TICKER}/\\d+`), { timeout: 40_000 });
    await expect(page.getByText(/^CONTRACT$/).first()).toBeVisible({ timeout: 25_000 });

    // The trade header renders "META · spot $610.42" (TICKER_NAME · spot fmt$).
    // Poll until the spot resolves to a real $NNN.NN, then compare to chain.
    await expect
      .poll(
        async () => {
          const body = await page.locator("body").innerText();
          const m = body.match(/spot\s*\$([\d,]+\.\d{2})/i);
          return m ? Number(m[1].replace(/,/g, "")) : null;
        },
        {
          timeout: 45_000,
          intervals: [500, 1000, 2000, 3000],
          message: "trade header META spot never resolved to a real $NNN.NN",
        },
      )
      .not.toBeNull();

    const tradeBody = await page.locator("body").innerText();
    const tradeSpot = Number(
      tradeBody.match(/spot\s*\$([\d,]+\.\d{2})/i)![1].replace(/,/g, ""),
    );
    expect(tradeSpot, "trade-page META spot must be > 0").toBeGreaterThan(0);
    expect(
      Math.abs(tradeSpot - truth.META),
      `trade-page META spot ${tradeSpot} should match on-chain ${truth.META}`,
    ).toBeLessThanOrEqual(1.0);

    // NO fake/placeholder leak on the trade page either. NB: we DON'T match a
    // bare "$220" — a real strike could coincidentally be $220 — only the exact
    // old-mock sentinel "$220.00" (META trades ~$610, so this can't false-fire
    // on legitimate price text here).
    expect(
      tradeBody,
      "trade page must not leak synthetic-data sentinels",
    ).not.toMatch(/lorem|placeholder|mock|stub|dummy|\$220\.00\b/i);
  });

  // ===========================================================================
  // ITEM #18 — Stale NEXT_PUBLIC_USDC_MINT guard.
  // BUG: the app was started BEFORE bootstrap rewrote NEXT_PUBLIC_USDC_MINT, so
  //      it served a STALE mint → header balance stuck at $0 and trades reverted
  //      with AccountNotInitialized(3012).
  // REGRESSION: /api/admin-key is admin-only, so we PROVE the served mint matches
  //      the on-chain mint operationally: fund Demo 1 via the faucet/admin and
  //      assert the HEADER USDC becomes >= 1. With a stale mint the app would
  //      read a DIFFERENT (empty) ATA and show $0 forever — the credit landing
  //      in the header is direct evidence the app's mint == the funded mint.
  // ===========================================================================
  test("ITEM18: funded balance lands in header (app mint == on-chain mint, not stale)", async ({
    page,
  }) => {
    await page.goto("/");
    // connectAndFund already polls headerUsdc >= 1; this is the core guard.
    await connectAndFund(page, 1, 1);

    // Re-assert explicitly (post-Escape) so the guard is unambiguous in the log:
    // a STALE mint would never credit the header.
    const credited = await headerUsdc(page);
    expect(
      credited,
      "header USDC must reflect the faucet credit — a stale NEXT_PUBLIC_USDC_MINT would stay $0",
    ).toBeGreaterThanOrEqual(1);
  });

  // ===========================================================================
  // ITEM #17 — Faucet smoke test.
  // BUG: the faucet returned TokenAccountNotFoundError on every call (a stale
  //      duplicate automation process held the WRONG mint, so the ATA it tried
  //      to mint into didn't match).
  // REGRESSION: POST :3001/faucet with a FRESH random base58 pubkey (no cooldown
  //      collision) and assert the JSON response has ok:true and usdc>0 — i.e.
  //      the live faucet actually mints, with no TokenAccountNotFound error.
  // ===========================================================================
  test("ITEM17: direct faucet POST returns ok:true with usdc>0 (no TokenAccountNotFound)", async ({
    page,
  }) => {
    // Fresh random pubkey → guaranteed not in the 20s per-address cooldown.
    const fresh = Keypair.generate().publicKey.toBase58();

    const resp = await page.request.post(`${AUTOMATION}/faucet`, {
      data: { address: fresh },
      headers: { "Content-Type": "application/json" },
      timeout: 60_000,
    });

    const status = resp.status();
    const json = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      usdc?: number;
      error?: string;
    };

    // The regressed faucet 500'd with "TokenAccountNotFound"; assert it did NOT.
    expect(
      json.error ?? "",
      "faucet must not surface a TokenAccountNotFound error",
    ).not.toMatch(/TokenAccountNotFound/i);

    expect(status, `faucet HTTP status (body: ${JSON.stringify(json)})`).toBe(200);
    expect(json.ok, "faucet response.ok must be true").toBe(true);
    expect(json.usdc, "faucet must credit usdc>0").toBeGreaterThan(0);
  });

  // ===========================================================================
  // PORTFOLIO MATH + "Winning vs losing" inconsistency.
  //
  // We open a META YES position WITH A REAL COST BASIS. NB: Quick Mint alone
  // produces NO basis — positions-client `deriveCostBasis` intentionally SKIPS
  // mint_pair events ("we DON'T fabricate a split"), so a mint-only position
  // shows Cost/Value/Unrealized = "—". To exercise the row math we need a real
  // BUY fill, so we run a 2-context maker→taker cross:
  //   - Demo 2 (maker): mint META pairs, then post a resting bid 56¢ + ask 64¢
  //     (size 20) → two-sided book so the MARK (book mid) is known.
  //   - Demo 1 (taker, the spec's connectAndFund(page,1,10)): LIMIT Buy YES @ 70
  //     crosses the 64¢ ask → a real fill at ~64¢ (known ENTRY). The maker's
  //     56¢ bid + remaining 64¢ ask keep the book two-sided so MARK stays known.
  //
  // On /portfolio we then assert the open-position ROW MATH is self-consistent:
  //   Cost = qty×avg/100, Value = qty×mark/100, Unrealized = Value − Cost.
  //
  // NOTE: the "Winning pill vs header Win-rate" definitional mismatch (ITM vs
  // mark-vs-entry) is being FIXED separately by the lead; this test no longer
  // documents/locks it — it asserts only the row-math identities.
  // ===========================================================================
  test("PORTFOLIO: open-position row math is self-consistent (Cost/Value/Unrealized)", async ({
    browser,
  }) => {
    test.setTimeout(120_000);

    const BID = 56;
    const ASK = 64;
    const MAKER_SIZE = 20;
    const TAKE_QTY = 10;

    // ----- Context A : maker (Demo 2) — mint inventory + quote both sides -----
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    try {
      await pageA.goto("/");
      await connectAndFund(pageA, 2, 5);

      // Resolve the live META ATM strike from the chain (never hardcode it).
      await pageA.goto(`/trade/${TICKER}`);
      await pageA.waitForURL(new RegExp(`/trade/${TICKER}/\\d+`), { timeout: 40_000 });
      const strike = Number(
        pageA.url().match(new RegExp(`/trade/${TICKER}/(\\d+)`))![1],
      );
      const strikeLabel = `$${(strike / 100).toFixed(2)}`;

      // Mint META pairs on the MM dashboard (Quick Mint = "Mint Pairs" card).
      await pageA.goto("/portfolio/mm");
      await expect(
        pageA.getByRole("heading", { name: /Market Maker/i }),
      ).toBeVisible({ timeout: 20_000 });

      // The "Mint Pairs" select is the LAST META-bearing <select> on the page.
      const selects = pageA.locator("select");
      const sCount = await selects.count();
      let mintSelect = selects.last();
      for (let i = sCount - 1; i >= 0; i--) {
        const s = selects.nth(i);
        const has = await s.locator("option", { hasText: TICKER }).count().catch(() => 0);
        if (has > 0) {
          mintSelect = s;
          break;
        }
      }
      const strikeOpt = mintSelect
        .locator("option")
        .filter({ hasText: TICKER })
        .filter({ hasText: strikeLabel });
      const useOpt =
        (await strikeOpt.count()) > 0
          ? strikeOpt.first()
          : mintSelect.locator("option", { hasText: TICKER }).first();
      const val = await useOpt.getAttribute("value");
      expect(val, "expected a META market option to mint against").toBeTruthy();
      await mintSelect.selectOption(val!);
      await mintSelect
        .locator("xpath=following::input[@type='number'][1]")
        .fill(String(MAKER_SIZE + 10));
      await pageA
        .getByRole("button", { name: new RegExp(`Mint\\s+${MAKER_SIZE + 10}\\s+pairs?`, "i") })
        .click();
      await expect(
        pageA.getByText(new RegExp(`Minted\\s+${MAKER_SIZE + 10}\\s+pair`, "i")).first(),
      ).toBeVisible({ timeout: 30_000 });

      // Post a resting bid (56¢) AND a resting ask (64¢) on the trade page so the
      // book is two-sided → MARK (book mid 60¢) is well-defined for the taker.
      await gotoStrike(pageA, strike);
      // Resting ASK @ 64 (the taker will cross this).
      await placeLimit(pageA, "Sell", ASK, MAKER_SIZE);
      await expect(
        pageA.getByText(new RegExp(`${MAKER_SIZE}\\s+YES\\s+resting`, "i")).first(),
      ).toBeVisible({ timeout: 30_000 });
      // Resting BID @ 56 (keeps a bid in the book after the cross → mark known).
      await placeLimit(pageA, "Buy", BID, MAKER_SIZE);
      await expect(
        pageA.getByText(new RegExp(`${MAKER_SIZE}\\s+YES\\s+resting`, "i")).first(),
      ).toBeVisible({ timeout: 30_000 });

      // ----- Context B : taker (Demo 1) — cross the ask to get a known basis ---
      const ctxB = await browser.newContext();
      const pageB = await ctxB.newPage();
      try {
        await pageB.goto("/");
        await connectAndFund(pageB, 1, 10); // spec: connectAndFund(page,1,10)
        await gotoStrike(pageB, strike);

        // LIMIT Buy YES @ 70 ≥ 64 ask → crosses → fill at the resting ask price.
        await placeLimit(pageB, "Buy", ASK + 6, TAKE_QTY);
        await expect(pageB.getByText(/Bought\s+\d+\s+YES/i).first()).toBeVisible({
          timeout: 30_000,
        });

        // ---- /portfolio : assert the META open-position row math ------------
        await pageB.goto("/portfolio");
        await expect(
          pageB.getByRole("heading", { name: /^Portfolio$/i }),
        ).toBeVisible({ timeout: 20_000 });

        // Find the META open-position row (qty/avg/mark/cost/value/unrealized).
        // Poll until the row exists AND its Cost/Value cells resolve to $ values
        // (entry from the fill + mark from the two-sided book).
        const metaRow = pageB
          .locator("table.tbl tbody tr")
          .filter({ hasText: new RegExp(`\\b${TICKER}\\b`) })
          .filter({ hasText: /YES/i })
          .first();

        await expect(metaRow).toBeVisible({ timeout: 25_000 });

        // The row cells, in order (see PositionRow):
        //   [0]=Contract  [1]=Side  [2]=Qty  [3]=Avg/Mark  [4]=Cost
        //   [5]=Value     [6]=Unrealized   [7]=Spot-vs-strike  [8]=Trade
        // Poll until Cost AND Value cells render real $ amounts.
        await expect
          .poll(
            async () => {
              const cost = await metaRow.locator("td").nth(4).innerText();
              const value = await metaRow.locator("td").nth(5).innerText();
              return (
                dollarsFromText(cost) != null && dollarsFromText(value) != null
              );
            },
            {
              timeout: 40_000,
              intervals: [1000, 2000, 3000],
              message:
                "META row Cost/Value never resolved — fill basis or book mid missing",
            },
          )
          .toBe(true);

        const cells = metaRow.locator("td");
        const qtyTxt = await cells.nth(2).innerText();
        const avgMarkTxt = await cells.nth(3).innerText(); // "64¢\n60¢" (avg / mark)
        const costTxt = await cells.nth(4).innerText();
        const valueTxt = await cells.nth(5).innerText();
        const unrealTxt = await cells.nth(6).innerText();

        const qty = Number(qtyTxt.replace(/[^\d]/g, ""));
        // Avg/Mark cell stacks two "N¢" values: first = avg (entry), second = mark.
        const centsAll = [...avgMarkTxt.matchAll(/(\d{1,3})\s*¢/g)].map((m) =>
          Number(m[1]),
        );
        const avg = centsAll[0];
        const mark = centsAll[1] ?? centsAll[0];
        const cost = dollarsFromText(costTxt)!;
        const value = dollarsFromText(valueTxt)!;
        // Unrealized may be signed with the minus either before OR after the $
        // ("+$0.40", "-$0.40", or "$-0.30" — fmt$ embeds the sign on negatives).
        const unrealMatch = unrealTxt.match(/(-?)\$(-?)([\d,]+\.\d{2})/);
        expect(unrealMatch, `unrealized cell parse: "${unrealTxt}"`).not.toBeNull();
        const unrealNeg = unrealMatch![1] === "-" || unrealMatch![2] === "-";
        const unreal =
          (unrealNeg ? -1 : 1) * Number(unrealMatch![3].replace(/,/g, ""));

        // 1) Cost = qty × avg / 100.
        expect(qty, "qty should be a positive integer").toBeGreaterThan(0);
        expect(avg, "avg (entry ¢) should parse").toBeGreaterThan(0);
        const expectCost = (qty * avg) / 100;
        expect(
          Math.abs(cost - expectCost),
          `Cost ${cost} should equal qty×avg/100 = ${expectCost} (qty=${qty}, avg=${avg}¢)`,
        ).toBeLessThanOrEqual(0.01);

        // 2) Value = qty × mark / 100.
        expect(mark, "mark (¢) should parse").toBeGreaterThan(0);
        const expectValue = (qty * mark) / 100;
        expect(
          Math.abs(value - expectValue),
          `Value ${value} should equal qty×mark/100 = ${expectValue} (qty=${qty}, mark=${mark}¢)`,
        ).toBeLessThanOrEqual(0.01);

        // 3) Unrealized = Value − Cost.
        expect(
          Math.abs(unreal - (value - cost)),
          `Unrealized ${unreal} should equal Value−Cost = ${(value - cost).toFixed(2)}`,
        ).toBeLessThanOrEqual(0.02);

        // Log the parsed row for visibility (no inconsistency assertions here —
        // the Winning-pill vs Win-rate reconciliation is owned by the lead's fix).
        // eslint-disable-next-line no-console
        console.log(
          `[ITEM portfolio] META row: qty=${qty} avg=${avg}¢ mark=${mark}¢ ` +
            `Cost=$${cost.toFixed(2)} Value=$${value.toFixed(2)} ` +
            `Unrealized=$${unreal.toFixed(2)} — all identities hold.`,
        );
      } finally {
        await ctxB.close();
      }
    } finally {
      await ctxA.close();
    }
  });
});

// -----------------------------------------------------------------------------
// Trade-page helpers (mirror the existing 30-regression-trading conventions).
// -----------------------------------------------------------------------------

/** Open the Trade panel on a known strike and wait for it to mount. */
async function gotoStrike(page: Page, strike: number): Promise<void> {
  await page.goto(`/trade/${TICKER}/${strike}`);
  await expect(page.getByText(/YES · closes ≥/i).first()).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Place a LIMIT order: side = "Buy" | "Sell", price (cents), qty. Ensures Limit
 * mode + the correct side are active, fills the inputs, submits, and clears the
 * first-trades confirm modal if it appears.
 */
async function placeLimit(
  page: Page,
  side: "Buy" | "Sell",
  cents: number,
  qty: number,
): Promise<void> {
  await page.getByRole("button", { name: /^Limit$/ }).click();
  await page.getByRole("button", { name: new RegExp(`^${side}$`) }).click();

  // Limit price is the 2nd number input (visible only in Limit mode); retry if a
  // concurrent book-load re-render drops the Limit click.
  const limitBtn = page.getByRole("button", { name: /^Limit$/ });
  const limitInput = page.locator("input[type='number']").nth(1);
  await expect
    .poll(
      async () => {
        if (await limitInput.isVisible().catch(() => false)) return true;
        if (await limitBtn.isVisible().catch(() => false)) {
          await limitBtn.click().catch(() => {});
        }
        return limitInput.isVisible().catch(() => false);
      },
      { timeout: 15_000, intervals: [500, 1000] },
    )
    .toBe(true);
  await limitInput.fill(String(cents));
  await page.locator("input[type='number']").first().fill(String(qty));

  const verb = side === "Buy" ? "Buy" : "Sell";
  await page.getByRole("button", { name: new RegExp(`${verb} YES ·`) }).click();

  // Clear the first-3-trades ConfirmTradeModal if present.
  const confirm = page.getByRole("button", { name: /^Confirm$/ });
  try {
    await confirm.waitFor({ state: "visible", timeout: 2_500 });
    await confirm.click();
  } catch {
    /* no modal — fine */
  }
}
