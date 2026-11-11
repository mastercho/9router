import { PERCH_CONFIG } from "../constants/oauth.js";

const TIMEOUT_MS = 20_000;

async function readJson(res) {
  const raw = await res.text().catch(() => "");
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Perch AI subscription login — Supabase PKCE (same as perchai-cli / perch2api).
 * prepareConfig loads supabaseUrl + anon key from cli-auth/config.
 *
 * Callback MUST be http://127.0.0.1:<port>/callback (Perch redirectHost).
 * On Unraid/remote Docker the browser hits the user's PC loopback — paste the
 * failed callback URL into the OAuth modal to finish exchange.
 */
const perch = {
  config: PERCH_CONFIG,
  flowType: "authorization_code_pkce",
  fixedPort: PERCH_CONFIG.fixedPort || 45871,
  callbackPath: PERCH_CONFIG.callbackPath || "/callback",

  prepareConfig: async (config) => {
    const appUrl = (config.appUrl || "https://app.perchai.app").replace(/\/+$/, "");
    const cliVersion = config.cliVersion || "2.4.118";
    const cfgRes = await fetch(config.cliAuthConfigUrl || `${appUrl}/api/perch-terminal/cli-auth/config`, {
      headers: { Accept: "application/json", "User-Agent": `perchai-cli/${cliVersion}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const cfg = await readJson(cfgRes);
    if (!cfgRes.ok || !cfg?.supabaseUrl || !cfg?.supabaseAnonKey) {
      throw new Error(`Perch cli-auth/config failed: HTTP ${cfgRes.status}`);
    }
    const provider = Array.isArray(cfg.providers) && cfg.providers.includes("google")
      ? "google"
      : (cfg.providers?.[0] || "google");
    const redirectHost = String(cfg.redirectHost || "127.0.0.1").trim() || "127.0.0.1";
    return {
      ...config,
      appUrl,
      cliVersion,
      redirectHost,
      supabaseUrl: String(cfg.supabaseUrl).replace(/\/+$/, ""),
      supabaseAnonKey: cfg.supabaseAnonKey,
      oauthProvider: provider,
      authorizeUrl: `${String(cfg.supabaseUrl).replace(/\/+$/, "")}/auth/v1/authorize`,
      tokenUrl: `${String(cfg.supabaseUrl).replace(/\/+$/, "")}/auth/v1/token?grant_type=pkce`,
      clientId: cfg.supabaseAnonKey,
    };
  },

  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    const params = new URLSearchParams({
      provider: config.oauthProvider || "google",
      redirect_to: redirectUri,
      code_challenge: codeChallenge,
      // Supabase / GoTrue expect uppercase S256 (perchai-cli / perch2api).
      code_challenge_method: "S256",
      apikey: config.supabaseAnonKey || config.clientId,
    });
    if (state) params.set("state", state);
    if ((config.oauthProvider || "google") === "google") {
      params.set("prompt", "select_account");
    }
    return `${config.authorizeUrl}?${params.toString()}`;
  },

  exchangeToken: async (config, code, _redirectUri, codeVerifier) => {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`,
      },
      body: JSON.stringify({
        auth_code: code,
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await readJson(response);
    // Some GoTrue responses nest under session; perch2api accepts either.
    const tokens = data?.session && data.session.access_token ? data.session : data;
    if (!response.ok || !tokens?.access_token) {
      throw new Error(
        `Perch token exchange failed: HTTP ${response.status} ${data?.error_description || data?.msg || data?.error || ""}`.trim(),
      );
    }
    // Preserve user on the object mapTokens expects.
    if (!tokens.user && data?.user) tokens.user = data.user;
    return tokens;
  },

  // mapTokens receives tokens; prepareConfig values are not re-passed here, so
  // bake known Supabase defaults (overwritten on refresh from live config).
  mapTokens: (tokens) => {
    const email = tokens.user?.email || null;
    const userId = tokens.user?.id || null;
    const expiresIn = typeof tokens.expires_in === "number"
      ? tokens.expires_in
      : (typeof tokens.expires_at === "number"
        ? Math.max(60, tokens.expires_at - Math.floor(Date.now() / 1000))
        : 3600);
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresIn,
      email,
      displayName: email,
      providerSpecificData: {
        authMethod: "supabase_pkce",
        appUrl: "https://app.perchai.app",
        supabaseUrl: "https://zlfuvsfjtgsdtqcaykia.supabase.co",
        // Publishable anon key from cli-auth/config (same as perchai-cli).
        supabaseAnonKey: "sb_publishable_w4R_pNkUpygBFIljZCoOlA_67ACg0FO",
        cliVersion: "2.4.118",
        clientSurface: "cli",
        lane: "code",
        userId,
        email,
        expiresAt: typeof tokens.expires_at === "number"
          ? tokens.expires_at
          : Math.floor(Date.now() / 1000) + expiresIn,
      },
    };
  },
};

export default perch;
