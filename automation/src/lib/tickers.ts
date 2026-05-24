/**
 * MAG7 ticker list. Mirror of `@meridian/types` `MAG7_TICKERS`, redeclared
 * here so this package keeps building even before `pnpm --filter @meridian/types build`
 * has run (the workspace dep resolves to dist/, which is generated, not source).
 */
export const MAG7_TICKERS = [
  "AAPL",
  "MSFT",
  "GOOGL",
  "AMZN",
  "NVDA",
  "META",
  "TSLA",
] as const;

export type Ticker = (typeof MAG7_TICKERS)[number];
