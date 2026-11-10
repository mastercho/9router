import os from "node:os";
import { OPENDESIGN_CONFIG } from "../constants/oauth.js";

const TIMEOUT_MS = 20_000;

async function readJson(res) {
  const raw = await res.text().catch(() => "");
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return { __text: raw };
  }
}

function said(body, fallback) {
  const raw = body?.error?.message ?? body?.message ?? body?.error ?? body?.__text;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.startsWith("<")) return fallback;
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/**
 * OpenDesign Cloud device authorization (same shape as `vela login` /
 * opencode-opendesign-auth): control plane issues deviceId + deviceSecret,
 * user approves activationUrl, poll returns runtimeKey (sk-amr-…) + controlKey.
 */
const opendesign = {
  config: OPENDESIGN_CONFIG,
  flowType: "device_code",

  requestDeviceCode: async (config) => {
    const base = (config.controlBaseUrl || "https://amr-api.open-design.ai").replace(/\/+$/, "");
    const url = config.deviceAuthUrl || `${base}/api/v1/cli/device-authorizations`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "9router-opendesign/1.0",
      },
      body: JSON.stringify({
        cliVersion: config.cliVersion || "0.1.4",
        host: os.hostname() || "9router",
        profile: config.profile || "prod",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await readJson(response);
    if (!response.ok || !data?.deviceId || !data?.deviceSecret) {
      throw new Error(
        `OpenDesign device auth failed: HTTP ${response.status} (${said(data, "no device authorization")})`,
      );
    }
    const userCode = String(data.userCode || "").trim();
    const activationUrl = String(data.activationUrl || "").trim();
    const interval = Number(data.pollIntervalSeconds) > 0 ? Number(data.pollIntervalSeconds) : 2;
    const expiresAt = Date.parse(data.expiresAt || "") || Date.now() + 10 * 60_000;
    return {
      device_code: String(data.deviceId),
      user_code: userCode || String(data.deviceId).slice(0, 8).toUpperCase(),
      verification_uri: activationUrl || `${config.activationHost || "https://open-design.ai"}/cloud/cli/activate`,
      verification_uri_complete: activationUrl || undefined,
      expires_in: Math.max(60, Math.floor((expiresAt - Date.now()) / 1000)),
      interval,
      _odDeviceSecret: String(data.deviceSecret),
      _odDeviceId: String(data.deviceId),
    };
  },

  pollToken: async (config, deviceCode, _codeVerifier, extraData) => {
    const deviceId = deviceCode || extraData?._odDeviceId;
    const deviceSecret = extraData?._odDeviceSecret;
    if (!deviceId || !deviceSecret) {
      return {
        ok: false,
        data: { error: "invalid_request", error_description: "Missing deviceId/deviceSecret" },
      };
    }
    const base = (config.controlBaseUrl || "https://amr-api.open-design.ai").replace(/\/+$/, "");
    const url = `${base}/api/v1/cli/device-authorizations/${encodeURIComponent(deviceId)}/token`;
    let response;
    let data;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "9router-opendesign/1.0",
        },
        body: JSON.stringify({ deviceSecret }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      data = await readJson(response);
    } catch (err) {
      return {
        ok: false,
        data: { error: "authorization_pending", error_description: err.message },
      };
    }

    const runtimeKey = String(data?.runtimeKey || data?.user?.runtimeKey || "").trim();
    const controlKey = String(data?.controlKey || data?.user?.controlKey || "").trim();
    if (runtimeKey && controlKey) {
      const email = String(data?.user?.email || "").trim();
      const userId = String(data?.user?.id || data?.user?.appUserId || "").trim();
      return {
        ok: true,
        data: {
          access_token: runtimeKey,
          refresh_token: null,
          // Keys do not expire; keep a long TTL so refresh logic stays quiet.
          expires_in: 365 * 24 * 60 * 60,
          _odControlKey: controlKey,
          _odEmail: email,
          _odUserId: userId,
        },
      };
    }

    const status = String(data?.status || "").toLowerCase();
    if (
      response.status === 404 ||
      ["expired", "canceled", "cancelled", "denied", "rejected"].includes(status)
    ) {
      return {
        ok: false,
        data: {
          error: "access_denied",
          error_description: `OpenDesign sign-in ${status || "not found"} — start again`,
        },
      };
    }
    if (response.status === 401) {
      return {
        ok: false,
        data: {
          error: "access_denied",
          error_description: said(data, "approval no longer valid"),
        },
      };
    }
    return { ok: false, data: { error: "authorization_pending" } };
  },

  mapTokens: (tokens) => {
    const email = (tokens._odEmail || "").trim();
    const userId = tokens._odUserId || "";
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresIn: tokens.expires_in,
      email: email || (userId ? `opendesign-${userId}` : null),
      displayName: email || null,
      providerSpecificData: {
        authMethod: "device",
        controlKey: tokens._odControlKey || "",
        userId,
        // Runtime key is also the Bearer used for amr-link inference.
        runtimeKey: tokens.access_token,
      },
    };
  },
};

export default opendesign;
