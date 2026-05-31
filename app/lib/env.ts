/**
 * Public env reader for the Next.js frontend.
 * Only NEXT_PUBLIC_* values are visible in the browser.
 */

const required = (name: string, value: string | undefined): string => {
  if (!value) {
    if (typeof window !== "undefined") {
      // soft-fail at runtime in the browser — log but don't throw
      // eslint-disable-next-line no-console
      console.warn(`[env] Missing ${name}`);
    }
    return "";
  }
  return value;
};

export const env = {
  cluster: required(
    "NEXT_PUBLIC_SOLANA_CLUSTER",
    process.env.NEXT_PUBLIC_SOLANA_CLUSTER,
  ),
  rpcUrl: required(
    "NEXT_PUBLIC_SOLANA_RPC_URL",
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
  ),
  // Optional secondary RPC (e.g. a second Helius key) the failover layer falls
  // back to when the primary returns 429 / "max usage reached". Empty is fine —
  // the public cluster RPC is always used as a last-resort fallback.
  fallbackRpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL_FALLBACK || "",
  programId: process.env.NEXT_PUBLIC_MERIDIAN_PROGRAM_ID || "",
  usdcMint: process.env.NEXT_PUBLIC_USDC_MINT || "",
  appName: process.env.NEXT_PUBLIC_APP_NAME || "Meridian",
  appUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
  // Automation faucet endpoint (devnet/localnet only) used to fund the demo
  // burner wallet with SOL + test USDC. Empty disables the demo-wallet funding.
  faucetUrl: process.env.NEXT_PUBLIC_FAUCET_URL || "",
};
