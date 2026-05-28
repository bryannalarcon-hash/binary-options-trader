import { expect } from "chai";

import { isAdminKeyServable } from "../../app/lib/admin-key-gate";

/**
 * Regression: the "Admin (demo)" wallet was localnet-only, so the devnet Railway
 * demo had no way to act as config.admin (every admin action reverted). The gate
 * must now SERVE on localnet + devnet and REFUSE only on mainnet.
 */
describe("admin-key gate (isAdminKeyServable)", () => {
  it("serves on devnet (the bug: was refused before)", () => {
    expect(
      isAdminKeyServable(
        "devnet",
        "https://devnet.helius-rpc.com/?api-key=x",
      ),
    ).to.equal(true);
  });

  it("serves on localnet", () => {
    expect(isAdminKeyServable("localnet", "http://localhost:8899")).to.equal(true);
  });

  it("serves when cluster is unset but RPC is localhost", () => {
    expect(isAdminKeyServable("", "http://127.0.0.1:8899")).to.equal(true);
    expect(isAdminKeyServable(undefined, undefined)).to.equal(true);
  });

  it("refuses on mainnet-beta cluster", () => {
    expect(
      isAdminKeyServable("mainnet-beta", "https://api.mainnet-beta.solana.com"),
    ).to.equal(false);
  });

  it("refuses on a mainnet RPC even if cluster is blank", () => {
    expect(isAdminKeyServable("", "https://mainnet.helius-rpc.com/?api-key=x")).to.equal(
      false,
    );
  });
});
