import { Connection } from "@solana/web3.js";

import { env } from "./env";

let _conn: Connection | null = null;

/**
 * Returns a process-wide singleton `Connection`.
 * Created lazily so server-side and client-side both work.
 */
export function getConnection(): Connection {
  if (_conn) return _conn;
  const rpc = env.rpcUrl || "http://localhost:8899";
  _conn = new Connection(rpc, { commitment: "confirmed" });
  return _conn;
}
