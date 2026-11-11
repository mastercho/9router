import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getPerchUsage } from "../../open-sse/services/usage/perch.js";
import { readFileSync } from "node:fs";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("getPerchUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks for OAuth when token missing", async () => {
    const usage = await getPerchUsage(null, null, {});
    expect(usage.message).toMatch(/signed-in session|OAuth/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("maps monthly PT allowance into quotas", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(200, {
      monthly_usd: 1.25,
      monthly_manual_usd: 0,
      daily_usd: 0.1,
      weekly_usd: 0.5,
      daily_calls: 3,
      weekly_calls: 12,
      monthly_calls: 40,
      monthly_tokens: 12000,
      period_start: "2026-11-01T00:00:00.000Z",
    }));

    const usage = await getPerchUsage("access-token", null, {
      supabaseUrl: "https://zlfuvsfjtgsdtqcaykia.supabase.co",
      supabaseAnonKey: "anon",
      email: "u@example.com",
    });

    expect(usage.plan).toMatch(/Perch/i);
    expect(usage.quotas["Perch Tokens · month"]).toMatchObject({
      used: 1250, // ceil(1.25 / 0.001)
      total: 20_000,
      remaining: 18_750,
    });
    expect(usage.quotas.Today.display).toMatch(/PT/);
  });

  it("is registered in usage.js dispatch map", () => {
    const src = readFileSync(new URL("../../open-sse/services/usage.js", import.meta.url), "utf8");
    expect(src).toMatch(/perch:\s*\(c\)\s*=>\s*getPerchUsage/);
  });
});
