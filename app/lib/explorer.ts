/**
 * Solana Explorer link helper. Honors NEXT_PUBLIC_SOLANA_CLUSTER so links
 * resolve to the right cluster (mainnet | devnet | localnet).
 */

import { env } from "./env";

const CLUSTER_TO_QUERY: Record<string, string> = {
  mainnet: "",
  "mainnet-beta": "",
  devnet: "?cluster=devnet",
  testnet: "?cluster=testnet",
  localnet: "?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899",
};

export function explorerTx(signature: string): string {
  const q = CLUSTER_TO_QUERY[env.cluster] ?? CLUSTER_TO_QUERY.devnet;
  return `https://explorer.solana.com/tx/${signature}${q}`;
}

export function explorerAddress(address: string): string {
  const q = CLUSTER_TO_QUERY[env.cluster] ?? CLUSTER_TO_QUERY.devnet;
  return `https://explorer.solana.com/address/${address}${q}`;
}
