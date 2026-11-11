import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/oauth/constants/oauth.js", () => ({
  PERCH_CONFIG: {
    appUrl: "https://app.perchai.app",
    cliAuthConfigUrl: "https://app.perchai.app/api/perch-terminal/cli-auth/config",
    callbackPath: "/callback",
    fixedPort: 45871,
    cliVersion: "2.4.118",
  },
}));

import perch from "../../src/lib/oauth/providers/perch.js";
import { readFileSync } from "node:fs";

describe("perch oauth provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses 127.0.0.1 loopback callback path and fixed port", () => {
    expect(perch.flowType).toBe("authorization_code_pkce");
    expect(perch.fixedPort).toBe(45871);
    expect(perch.callbackPath).toBe("/callback");
  });

  it("builds authorize URL with S256 and redirect_to", () => {
    const url = perch.buildAuthUrl(
      {
        authorizeUrl: "https://example.supabase.co/auth/v1/authorize",
        supabaseAnonKey: "anon",
        oauthProvider: "google",
      },
      "http://127.0.0.1:45871/callback",
      "state-1",
      "challenge-1",
    );
    const u = new URL(url);
    expect(u.searchParams.get("redirect_to")).toBe("http://127.0.0.1:45871/callback");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(u.searchParams.get("provider")).toBe("google");
  });

  it("unwraps nested session from token exchange", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        session: {
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          user: { id: "u1", email: "a@b.c" },
        },
      }),
    });

    const tokens = await perch.exchangeToken(
      {
        tokenUrl: "https://example.supabase.co/auth/v1/token?grant_type=pkce",
        supabaseAnonKey: "anon",
      },
      "auth-code",
      "http://127.0.0.1:45871/callback",
      "verifier",
    );
    expect(tokens.access_token).toBe("at");
    expect(tokens.user.email).toBe("a@b.c");

    const mapped = perch.mapTokens(tokens);
    expect(mapped.accessToken).toBe("at");
    expect(mapped.email).toBe("a@b.c");
  });

  it("wires perch into OAuth start-proxy / modal loopback redirect", () => {
    const route = readFileSync(new URL("../../src/app/api/oauth/[provider]/[action]/route.js", import.meta.url), "utf8");
    expect(route).toMatch(/startPerchProxy/);
    expect(route).toMatch(/registerPerchSession/);
    expect(route).toMatch(/"perch"/);

    const modal = readFileSync(new URL("../../src/shared/components/OAuthModal.js", import.meta.url), "utf8");
    expect(modal).toMatch(/127\.0\.0\.1:45871\/callback/);
    expect(modal).toMatch(/perchServerSide/);
  });
});
