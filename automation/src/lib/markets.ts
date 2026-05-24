import { type Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { ctx } from "../logger";

const log = ctx("markets");

export interface MarketSummary {
  address: PublicKey;
  ticker: string;
  strike: number;
  expiryTs: number;
  oracle: PublicKey;
  settled: boolean;
}

/**
 * Enumerate every `Market` account owned by the program. Best done sparingly —
 * full program-account scans are heavy on RPC. For Phase-4 demo loads (a few
 * dozen markets) this is fine.
 */
export async function fetchAllMarkets(
  program: Program,
): Promise<MarketSummary[]> {
  // `program.account.market` reads the IDL "Market" account type lower-cased.
  // If the contract names it differently we surface a clear error.
  const accessor: { all: () => Promise<Array<{ publicKey: PublicKey; account: Record<string, unknown> }>> } | undefined =
    (program.account as Record<string, unknown>).market as
      | { all: () => Promise<Array<{ publicKey: PublicKey; account: Record<string, unknown> }>> }
      | undefined;

  if (!accessor || typeof accessor.all !== "function") {
    log.warn(
      "program.account.market not available — IDL likely missing the Market account schema",
    );
    return [];
  }

  const raw = await accessor.all();
  return raw.map((entry) => {
    const a = entry.account as {
      ticker: string;
      strike: { toNumber?: () => number; toString?: () => string } | number;
      expiryTs: { toNumber?: () => number; toString?: () => string } | number;
      oracle: PublicKey;
      settled: boolean;
    };
    return {
      address: entry.publicKey,
      ticker: a.ticker,
      strike: bnToNumber(a.strike),
      expiryTs: bnToNumber(a.expiryTs),
      oracle: a.oracle,
      settled: a.settled,
    };
  });
}

/** Just the open (unsettled) markets. */
export async function fetchOpenMarkets(
  program: Program,
): Promise<MarketSummary[]> {
  const all = await fetchAllMarkets(program);
  return all.filter((m) => !m.settled);
}

function bnToNumber(
  v: { toNumber?: () => number; toString?: () => string } | number,
): number {
  if (typeof v === "number") return v;
  if (v && typeof v.toNumber === "function") {
    try {
      return v.toNumber();
    } catch {
      // Strikes/timestamps fit in number range; this should rarely throw.
    }
  }
  if (v && typeof v.toString === "function") return Number(v.toString());
  return Number(v);
}
