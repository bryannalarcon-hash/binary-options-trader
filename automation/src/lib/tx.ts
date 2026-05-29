import {
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

/**
 * Send a transaction and confirm it via HTTP polling (`getSignatureStatuses`)
 * instead of web3.js's default WebSocket confirmation.
 *
 * Why: on a throttled free-tier RPC (Helius devnet) the WS confirmation path
 * stalls — each `sendAndConfirm` waits out the full `confirmTransactionInitial-
 * Timeout` (and surfaces 429s as unhandled rejections that crash the service).
 * Empirically this dragged a single market write to ~4 min. HTTP status polling
 * is ~0.2s/poll and never opens a subscription, so writes confirm in ~1-2s and
 * never touch the WS. `skipPreflight` avoids a second simulate round-trip.
 */
export async function sendHttp(
  connection: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
  opts: { signers?: Keypair[]; timeoutMs?: number; pollMs?: number } = {},
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(payer, ...(opts.signers ?? []));

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 5,
  });

  const timeoutMs = opts.timeoutMs ?? 45_000;
  const pollMs = opts.pollMs ?? 500;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = (await connection.getSignatureStatuses([sig])).value[0];
    if (st) {
      if (st.err) throw new Error(`tx ${sig} failed on-chain: ${JSON.stringify(st.err)}`);
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
        return sig;
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`tx ${sig} confirmation timed out after ${timeoutMs}ms`);
}
