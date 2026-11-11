import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getVeniceUsage } from "../../open-sse/services/usage/venice.js";
import { readFileSync } from "node:fs";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("getVeniceUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks for a key when missing", async () => {
    const usage = await getVeniceUsage(null);
    expect(usage.message).toMatch(/API key/i);
  });

  it("explains ADMIN key requirement on 401", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(401, { error: "Admin API key required" }));
    const usage = await getVeniceUsage("inf-key");
    expect(usage.message).toMatch(/ADMIN/i);
    expect(usage.plan).toMatch(/API credits/i);
  });

  it("maps DIEM and bundled credits", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(200, {
      canConsume: true,
      consumptionCurrency: "DIEM",
      balances: {
        diem: 40,
        usd: 2.5,
        bundledCredits: 10,
        earnedCredits: null,
      },
      diemEpochAllocation: 100,
    }));
    const usage = await getVeniceUsage("admin-key");
    expect(usage.quotas.DIEM).toMatchObject({ used: 60, total: 100, remaining: 40 });
    expect(usage.quotas["Bundled credits"].remaining).toBe(10);
    expect(usage.quotas.USD.display).toBe("$2.50");
    expect(usage.balance).toMatch(/DIEM/);
  });

  it("is registered in usage.js", () => {
    const src = readFileSync(new URL("../../open-sse/services/usage.js", import.meta.url), "utf8");
    expect(src).toMatch(/venice:\s*\(c\)\s*=>\s*getVeniceUsage/);
  });
});
