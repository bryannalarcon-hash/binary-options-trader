"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";

import { env } from "@/lib/env";
import { fmtUsdDollars, shortKey } from "@/lib/format";
import { useMounted } from "@/lib/use-mounted";
import { useUsdcBalance } from "@/lib/usdc";

import { Wordmark, IconSettings, IconBolt, Button } from "@/components/caret";
import { SettingsPanel } from "./SettingsPanel";
import { DemoWalletControls } from "./DemoWalletControls";
import { WalletConnectModal } from "./WalletConnectModal";

const NAV = [
  { href: "/markets", label: "Markets" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/portfolio/mm", label: "Market Maker" },
  { href: "/history", label: "History" },
  { href: "/admin", label: "Admin", icon: true },
];

/**
 * Top navigation — caret style (ports prototype/js/nav.jsx into the live app).
 *
 * Layout:
 *   - Wordmark on left → /
 *   - Nav links (Markets / Portfolio / Market Maker / History) center
 *     with an underline on the active route
 *   - Cluster pill + wallet button + settings cog on right
 *
 * Trade route handling: when the user is on /trade/* we light up "Markets"
 * since there's no dedicated /trade index. (Markets-then-trade is the
 * canonical flow per the PRD.)
 */
/**
 * Track the phone/small-tablet breakpoint (≤720px). Returns false during SSR
 * and first paint (desktop layout), then corrects on mount — so the markup is
 * stable for hydration and we never ship a fixed-width row that overflows a
 * phone.
 */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 720px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return isMobile;
}

export function Header() {
  const pathname = usePathname() ?? "";
  const mounted = useMounted();
  const wallet = useWallet();
  const usdc = useUsdcBalance();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const isMobile = useIsMobile();

  // Close the mobile menu whenever the route changes.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const connected = mounted && wallet.connected;
  const publicKey = mounted ? wallet.publicKey : null;
  const disconnect = wallet.disconnect;

  // Demo-wallet funding is MANUAL — use the "Fund demo wallet" button in the
  // "Demo N ⚙" panel (DemoWalletControls). We intentionally do NOT auto-fund on
  // connect.

  function isActive(href: string): boolean {
    if (href === "/portfolio") {
      // Differentiate /portfolio from /portfolio/mm
      return pathname === "/portfolio";
    }
    if (href === "/portfolio/mm") {
      return pathname.startsWith("/portfolio/mm");
    }
    if (href === "/markets") {
      // Light up "Markets" when browsing or trading.
      return pathname.startsWith("/markets") || pathname.startsWith("/trade");
    }
    return pathname.startsWith(href);
  }

  // Wallet button (connect or connected-pill) — stays visible at every width.
  const walletButton =
    connected && publicKey ? (
      <button
        type="button"
        onClick={() => void disconnect()}
        title="Click to disconnect"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px 6px 8px",
          background: "var(--bg-elev)",
          border: "1px solid var(--line)",
          borderRadius: 999,
          color: "var(--text)",
          fontFamily: "var(--mono)",
          fontSize: 12,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: "50%",
            flexShrink: 0,
            background:
              "linear-gradient(135deg, var(--accent), oklch(0.6 0.2 290))",
          }}
        />
        {shortKey(publicKey.toBase58())}
        {usdc.cents != null && (
          <>
            <span style={{ color: "var(--text-3)" }}>·</span>
            <span style={{ color: "var(--text-2)" }}>
              {usdc.loading ? "…" : fmtUsdDollars(usdc.cents / 100)}
            </span>
          </>
        )}
      </button>
    ) : (
      <Button primary onClick={() => setConnectOpen(true)}>
        Connect Wallet
      </Button>
    );

  const clusterPill = (
    <span
      className="pill"
      style={{ borderRadius: 6, fontSize: 10, padding: "4px 7px" }}
      title={env.rpcUrl}
    >
      <span
        className="dot"
        style={{ background: "var(--up)", boxShadow: "0 0 6px var(--up)" }}
      />
      {env.cluster || "Devnet"}
    </span>
  );

  const settingsButton = (
    <button
      type="button"
      onClick={() => setSettingsOpen(true)}
      aria-label="Settings"
      title="Settings"
      style={{
        width: 36,
        height: 36,
        padding: 0,
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "1px solid var(--line-soft)",
        borderRadius: 8,
        color: "var(--text-2)",
        cursor: "pointer",
      }}
    >
      <IconSettings size={15} />
    </button>
  );

  return (
    <>
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 100,
          background:
            "color-mix(in oklch, var(--bg) 80%, transparent)",
          backdropFilter: "blur(14px) saturate(120%)",
          WebkitBackdropFilter: "blur(14px) saturate(120%)",
          borderBottom: "1px solid var(--line-soft)",
        }}
      >
        <div
          className="hdr-inner"
          style={{
            maxWidth: 1480,
            margin: "0 auto",
            padding: "14px 40px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 24,
          }}
        >
          <Link href="/" style={{ display: "flex", alignItems: "center" }} aria-label="Meridian home">
            <Wordmark size={17} />
          </Link>

          {!isMobile && (
            <nav style={{ display: "flex", gap: 4 }}>
              {NAV.map((it) => {
                const active = isActive(it.href);
                return (
                  <Link
                    key={it.href}
                    href={it.href}
                    style={{
                      background: "transparent",
                      border: 0,
                      padding: "8px 14px",
                      fontSize: 13,
                      fontWeight: 500,
                      color: active ? "var(--text)" : "var(--text-3)",
                      position: "relative",
                      transition: "color .12s",
                      whiteSpace: "nowrap",
                      textDecoration: "none",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                    }}
                  >
                    {it.icon && <IconBolt size={12} />}
                    {it.label}
                    {active && (
                      <span
                        style={{
                          position: "absolute",
                          bottom: -15,
                          left: "20%",
                          right: "20%",
                          height: 2,
                          background: "var(--accent)",
                          borderRadius: 2,
                        }}
                      />
                    )}
                  </Link>
                );
              })}
            </nav>
          )}

          {/* Right controls — full set on desktop; condensed (wallet + menu)
              on phones, with the rest moved into the slide-down menu. */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {!isMobile && clusterPill}
            {walletButton}
            {!isMobile && <DemoWalletControls />}
            {!isMobile && settingsButton}

            <button
              type="button"
              className="hdr-burger"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              style={{
                width: 38,
                height: 38,
                padding: 0,
                flexShrink: 0,
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: "1px solid var(--line-soft)",
                borderRadius: 8,
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              {menuOpen ? <CloseGlyph /> : <BurgerGlyph />}
            </button>
          </div>
        </div>

        {/* Mobile slide-down menu */}
        {isMobile && menuOpen && (
          <div className="hdr-menu" role="navigation" aria-label="Mobile">
            {NAV.map((it) => (
              <Link
                key={it.href}
                href={it.href}
                className={isActive(it.href) ? "on" : undefined}
                onClick={() => setMenuOpen(false)}
              >
                {it.icon && <IconBolt size={13} />}
                {it.label}
              </Link>
            ))}
            <div className="hdr-menu-tools">
              {clusterPill}
              <DemoWalletControls />
              <button
                type="button"
                className="hdr-menu-item"
                style={{ width: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px" }}
                onClick={() => {
                  setMenuOpen(false);
                  setSettingsOpen(true);
                }}
              >
                <IconSettings size={15} />
                Settings
              </button>
            </div>
          </div>
        )}
      </header>
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <WalletConnectModal open={connectOpen} onClose={() => setConnectOpen(false)} />
    </>
  );
}

/** Hamburger / close glyphs (3-line and X) for the mobile menu toggle. */
function BurgerGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <line x1="2.5" y1="4.5" x2="13.5" y2="4.5" />
      <line x1="2.5" y1="8" x2="13.5" y2="8" />
      <line x1="2.5" y1="11.5" x2="13.5" y2="11.5" />
    </svg>
  );
}
function CloseGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" />
      <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" />
    </svg>
  );
}
