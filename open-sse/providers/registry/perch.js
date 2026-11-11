/**
 * Perch AI (perchai.app) — subscription Starter / Pro / Ultra via CLI session.
 *
 * Official product has no public chat API. This provider uses the same
 * Supabase PKCE login as perchai-cli, then calls
 * POST /api/perch-terminal/model-call (unofficial; may violate Perch ToS /
 * risk rate-limits). Prefer running your own account responsibly.
 */
export default {
  id: "perch",
  priority: 119,
  alias: "perch",
  aliases: ["perchai", "pc"],
  uiAlias: "pc",
  display: {
    name: "Perch AI",
    icon: "flutter_dash",
    color: "#0F766E",
    textIcon: "PC",
    website: "https://perchai.app",
    notice: {
      text: "Click Sign in with Perch. On Unraid paste the 127.0.0.1:45871/callback?code=… URL after login. Sends CLI persona + turn tickets (anti surface-gate). Unofficial model-call bridge — no public Perch chat API.",
      signupUrl: "https://perchai.app/pricing",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    // OpenAI-shaped locally; PerchExecutor rewrites to model-call upstream.
    baseUrl: "https://app.perchai.app/api/perch-terminal/model-call",
    format: "openai",
    headers: {
      Accept: "text/event-stream",
      "x-perch-locale": "en",
    },
  },
  models: [
    { id: "perch", name: "Roost Standard" },
    { id: "perch-standard-max", name: "Roost Standard Max" },
    { id: "perch-pro", name: "Roost Pro" },
    { id: "perch-pro-max", name: "Roost Pro Max" },
  ],
  oauth: {
    appUrl: "https://app.perchai.app",
    cliAuthConfigUrl: "https://app.perchai.app/api/perch-terminal/cli-auth/config",
    modelCallUrl: "https://app.perchai.app/api/perch-terminal/model-call",
    // PKCE against Supabase (provider google/github from config).
    // Must match Perch cli-auth redirectHost (127.0.0.1) + /callback.
    callbackPath: "/callback",
    fixedPort: 45871,
    cliVersion: "2.4.118",
    lane: "code",
    clientSurface: "cli",
  },
  features: {
    usage: true,
  },
};
