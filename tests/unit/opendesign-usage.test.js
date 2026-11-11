import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getOpenDesignUsage } from "../../open-sse/services/usage/opendesign.js";
import { readFileSync } from "node:fs";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("getOpenDesignUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks for OAuth when control key is missing", async () => {
    const usage = await getOpenDesignUsage("sk-amr-only", null, {});
    expect(usage.message).toMatch(/OAuth/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("maps Design Plan windows into quotas", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(200, { activeWorkspaceId: "ws_1", personalMembershipTier: "plus" }))
      .mockResolvedValueOnce(jsonResponse(200, {
        balanceUsd: 1.25,
        codingPlan: {
          eligible: true,
          windows: [
            {
              durationSeconds: 5 * 3600,
              usedCredits: 10,
              limitCredits: 100,
              resetsAt: "2026-11-11T10:00:00.000Z",
            },
            {
              durationSeconds: 7 * 24 * 3600,
              usedCredits: 40,
              limitCredits: 200,
              resetsAt: "2026-11-17T10:00:00.000Z",
            },
          ],
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, { membershipTier: "plus" }));

    const usage = await getOpenDesignUsage(null, null, { controlKey: "vela_ctrl_test" });
    expect(usage.plan).toMatch(/Design Plan Plus/i);
    expect(usage.balance).toBe("$1.25");
    expect(usage.quotas["5 hours"]).toMatchObject({
      used: 10,
      total: 100,
      remaining: 90,
    });
    expect(usage.quotas["7 days"]).toMatchObject({
      used: 40,
      total: 200,
      remaining: 160,
    });
  });

  it("shows Free wallet trial balance when Design Plan is not eligible", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(200, { activeWorkspaceId: "ws_free", personalMembershipTier: "free" }))
      .mockResolvedValueOnce(jsonResponse(200, {
        balanceUsd: "0.37",
        codingPlan: {
          eligible: false,
          windows: [],
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, { membershipTier: "free", balanceUsd: "0.37" }));

    const usage = await getOpenDesignUsage(null, null, { controlKey: "vela_ctrl_free" });
    expect(usage.plan).toMatch(/Free/i);
    expect(usage.balance).toBe("$0.37");
    expect(usage.quotas.Wallet).toMatchObject({
      remaining: 0.37,
      display: "$0.37 remaining",
    });
    expect(usage.message).toMatch(/trial\/top-up|Wallet/i);
    expect(usage.message).not.toMatch(/no Design Plan allowance — requests draw on wallet balance/);
  });

  it("is registered in usage.js dispatch map", () => {
    const src = readFileSync(new URL("../../open-sse/services/usage.js", import.meta.url), "utf8");
    expect(src).toMatch(/opendesign:\s*\(c\)\s*=>\s*getOpenDesignUsage/);
  });
});
