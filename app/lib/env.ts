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
  programId: process.env.NEXT_PUBLIC_MERIDIAN_PROGRAM_ID || "",
  usdcMint: process.env.NEXT_PUBLIC_USDC_MINT || "",
  appName: process.env.NEXT_PUBLIC_APP_NAME || "Meridian",
  appUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
};
