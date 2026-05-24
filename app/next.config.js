/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow Solana / wallet-adapter packages that ship ESM.
  transpilePackages: [
    "@solana/wallet-adapter-base",
    "@solana/wallet-adapter-react",
    "@solana/wallet-adapter-react-ui",
    "@solana/wallet-adapter-wallets",
  ],
  webpack: (config) => {
    // wallet adapters import node-only modules — stub them in the browser.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
      crypto: false,
    };
    return config;
  },
  reactStrictMode: true,
};

module.exports = nextConfig;
