"use client";

/**
 * Admin (demo) wallet adapter.
 *
 * A no-install wallet that loads the on-chain CONFIG ADMIN / oracle authority
 * keypair so an operator can run the demo end-to-end from the browser — push
 * oracle prices, settle markets, create markets, pause — without importing a
 * key into an extension. Same UX as the Demo Wallet burners.
 *
 * The secret is fetched at connect time from /api/admin-key, which is HARD-GATED
 * to localnet (the route refuses to serve off localhost). The key is a throwaway
 * localnet dev key — NOT the program upgrade authority, no real funds — and is
 * never bundled into client JS.
 */

import {
  BaseSignerWalletAdapter,
  WalletReadyState,
  WalletNotConnectedError,
  WalletConnectionError,
  WalletError,
  type WalletName,
} from "@solana/wallet-adapter-base";
import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";

export const AdminWalletName = "Admin (demo)" as WalletName<string>;

export function isAdminWalletName(name: string | undefined | null): boolean {
  return name === "Admin (demo)";
}

// Inline amber gradient shield-ish glyph so it stands out from the demo wallets.
const ICON =
  "data:image/svg+xml;base64," +
  (typeof window === "undefined"
    ? ""
    : window.btoa(
        `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">` +
          `<defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1">` +
          `<stop offset="0" stop-color="#f5a524"/><stop offset="1" stop-color="#f53d3d"/>` +
          `</linearGradient></defs>` +
          `<rect width="28" height="28" rx="7" fill="url(#a)"/>` +
          `<path d="M14 7l5 2v4c0 3-2 5-5 6-3-1-5-3-5-6V9l5-2z" fill="none" stroke="#fff" ` +
          `stroke-width="2" stroke-linejoin="round"/></svg>`,
      ));

export class AdminWalletAdapter extends BaseSignerWalletAdapter {
  readonly name = AdminWalletName;
  url = "https://meridian-app-production-f15c.up.railway.app";
  icon = ICON;
  readonly supportedTransactionVersions = new Set(["legacy", 0] as const);

  private _keypair: Keypair | null = null;
  private _publicKey: PublicKey | null = null;
  private _connecting = false;
  private _readyState: WalletReadyState =
    typeof window === "undefined"
      ? WalletReadyState.Unsupported
      : WalletReadyState.Installed;

  get publicKey(): PublicKey | null {
    return this._publicKey;
  }
  get connecting(): boolean {
    return this._connecting;
  }
  get readyState(): WalletReadyState {
    return this._readyState;
  }
  /** Live keypair for trusted same-origin helpers. */
  get keypair(): Keypair | null {
    return this._keypair;
  }

  async connect(): Promise<void> {
    try {
      if (this.connected || this.connecting) return;
      if (this._readyState !== WalletReadyState.Installed) {
        throw new WalletNotConnectedError();
      }
      this._connecting = true;
      const res = await fetch("/api/admin-key", { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `admin key unavailable (${res.status})`);
      }
      const { secret } = (await res.json()) as { secret?: string };
      if (!secret) throw new Error("admin key not provided");
      const bytes = utils.bytes.bs58.decode(secret);
      const kp = Keypair.fromSecretKey(Uint8Array.from(bytes));
      this._keypair = kp;
      this._publicKey = kp.publicKey;
      this.emit("connect", kp.publicKey);
    } catch (err: unknown) {
      const wErr =
        err instanceof WalletError
          ? err
          : new WalletConnectionError(
              err instanceof Error ? err.message : String(err),
              err,
            );
      this.emit("error", wErr);
      throw wErr;
    } finally {
      this._connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    this._keypair = null;
    this._publicKey = null;
    this.emit("disconnect");
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
  ): Promise<T> {
    const kp = this._keypair;
    if (!kp) throw new WalletNotConnectedError();
    if (transaction instanceof VersionedTransaction) {
      transaction.sign([kp]);
    } else {
      (transaction as Transaction).partialSign(kp);
    }
    return transaction;
  }
}
