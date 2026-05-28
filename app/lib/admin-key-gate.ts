/**
 * Pure gate for whether `/api/admin-key` may serve the in-browser "Admin (demo)"
 * wallet its secret.
 *
 * The admin key is a THROWAWAY devnet/localnet dev key — no real funds, NOT the
 * program upgrade authority. We expose it on localnet + devnet so operators can
 * run the lifecycle (oracle / settle / create-market) from the browser demo, but
 * we HARD-REFUSE on mainnet so a real key can never leak from a mainnet build.
 *
 * Kept React/Next-free so it's unit-testable in isolation (tests/unit).
 */
export function isAdminKeyServable(
  cluster: string | undefined,
  rpcUrl: string | undefined,
): boolean {
  const c = (cluster ?? "").trim().toLowerCase();
  const rpc = (rpcUrl ?? "").trim().toLowerCase();
  const isMainnet =
    c === "mainnet-beta" ||
    c === "mainnet" ||
    rpc.includes("mainnet");
  return !isMainnet;
}
