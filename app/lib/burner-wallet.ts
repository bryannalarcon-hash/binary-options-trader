"use client";

/**
 * Burner (demo) wallet adapter.
 *
 * A no-install wallet for the devnet/localnet demo: it generates a Solana
 * keypair in the browser, persists the secret in localStorage, and signs
 * transactions locally (no extension, no popup). It implements the standard
 * `@solana/wallet-adapter-base` signer interface, so the rest of the app
 * (useWallet, AnchorProvider, composite-tx, …) works against it unchanged.
 *
 * Security note: the secret key lives in the browser's localStorage. This is
 * fine for DEVNET/LOCALNET play-money demos (no real funds), and is NOT a
 * pattern for mainnet. Clearing the secret = losing the burner (it's disposable
 * by design — that's the point).
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

/** Adapter name for demo account `index` (1, 2, …). */
export function burnerWalletName(index: number): WalletName<string> {
  return `Demo Wallet ${index}` as WalletName<string>;
}
/** True if a wallet-adapter name is one of our burner demo accounts. */
export function isBurnerName(name: string | undefined | null): boolean {
  return !!name && /^Demo Wallet \d+$/.test(name);
}
/** Back-compat default (account 1). */
export const BurnerWalletName = burnerWalletName(1);

const lsKey = (index: number) => `meridian.burner.secretKey.v${index}`;

// Inline caret-mark icon (purple gradient "›") so it renders in the wallet modal.
const ICON =
  "data:image/svg+xml;base64," +
  (typeof window === "undefined"
    ? ""
    : window.btoa(
        `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">` +
          `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
          `<stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#22d3ee"/>` +
          `</linearGradient></defs>` +
          `<rect width="28" height="28" rx="7" fill="url(#g)"/>` +
          `<path d="M10 8l6 6-6 6" fill="none" stroke="#fff" stroke-width="2.4" ` +
          `stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      ));

/** Load the persisted burner keypair for `index`, or generate + persist one. */
export function loadOrCreateBurner(index: number): Keypair {
  if (typeof window === "undefined") return Keypair.generate();
  const key = lsKey(index);
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const bytes = Uint8Array.from(JSON.parse(raw) as number[]);
      return Keypair.fromSecretKey(bytes);
    }
  } catch {
    /* corrupt entry — fall through and regenerate */
  }
  const kp = Keypair.generate();
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(kp.secretKey)));
  } catch {
    /* localStorage unavailable (private mode) — burner is ephemeral this load */
  }
  return kp;
}

/** Parse the account index out of a "Demo Wallet N" adapter name. */
export function burnerIndexFromName(name: string | null | undefined): number | null {
  const m = name?.match(/^Demo Wallet (\d+)$/);
  return m ? Number(m[1]) : null;
}

/**
 * The demo wallet's secret key as a base58 string — the format Phantom /
 * Solflare's "Import private key" accepts. Lets a user move the in-browser demo
 * wallet into an external wallet app. Returns null if the burner doesn't exist
 * yet (connect once first). DEVNET/LOCALNET demo funds only — never a real key.
 */
export function getBurnerSecretBase58(index: number): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(lsKey(index));
    if (!raw) return null;
    const bytes = Uint8Array.from(JSON.parse(raw) as number[]);
    return utils.bytes.bs58.encode(Buffer.from(bytes));
  } catch {
    return null;
  }
}

/** Forget burner `index` (used by "Reset demo wallet"). */
export function clearBurner(index: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(lsKey(index));
  } catch {
    /* noop */
  }
}

export class BurnerWalletAdapter extends BaseSignerWalletAdapter {
  readonly name: WalletName<string>;
  url = "https://meridian-app-production-f15c.up.railway.app";
  icon = ICON;
  readonly supportedTransactionVersions = new Set(["legacy", 0] as const);

  private readonly _index: number;
  private _keypair: Keypair | null = null;
  private _publicKey: PublicKey | null = null;
  private _connecting = false;
  private _readyState: WalletReadyState =
    typeof window === "undefined"
      ? WalletReadyState.Unsupported
      : WalletReadyState.Installed;

  constructor(index = 1) {
    super();
    this._index = index;
    this.name = burnerWalletName(index);
  }

  get publicKey(): PublicKey | null {
    return this._publicKey;
  }

  get connecting(): boolean {
    return this._connecting;
  }

  get readyState(): WalletReadyState {
    return this._readyState;
  }

  /** Expose the live keypair for trusted same-origin helpers (e.g. faucet). */
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
      const kp = loadOrCreateBurner(this._index);
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
    // Keep the secret in localStorage so the same demo wallet returns on
    // reconnect; use clearBurner() to truly discard it.
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
