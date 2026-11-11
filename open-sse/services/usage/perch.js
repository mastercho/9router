/**
 * Perch AI usage — Settings → Usage meter via Supabase RPC
 * (same path as perchai-cli / perch2api).
 *
 * POST {supabaseUrl}/rest/v1/rpc/perch_ai_my_inference_usage_meter
 * Body: { p_day_start, p_week_start }
 * Auth: Bearer access_token + apikey = supabase anon key
 *
 * PT (Perch Tokens) = ceil(usd / 0.001). Starter default allowance = 20,000 PT.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { parseResetTime, toFiniteNumber } from "./shared.js";

const APP_URL = "https://app.perchai.app";
const CLI_AUTH_CONFIG = `${APP_URL}/api/perch-terminal/cli-auth/config`;
const DEFAULT_SB_URL = "https://zlfuvsfjtgsdtqcaykia.supabase.co";
const TIMEOUT_MS = 20_000;
const PT_PER_USD = 1000;
const DEFAULT_MONTHLY_PT = 20_000;

function text(v) {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function ptOf(usd) {
  const n = Number(usd);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n * PT_PER_USD) : 0;
}

function monthResetIso(periodStart) {
  const at = Date.parse(periodStart ?? "");
  if (!Number.isFinite(at)) return null;
  const d = new Date(at);
  d.setMonth(d.getMonth() + 1);
  return parseResetTime(d.toISOString());
}

async function resolveSupabase(providerSpecificData, proxyOptions) {
  const fromDataUrl = text(providerSpecificData?.supabaseUrl);
  const fromDataKey = text(providerSpecificData?.supabaseAnonKey || providerSpecificData?.supabaseKey);
  if (fromDataUrl && fromDataKey) {
    return { supabaseUrl: fromDataUrl.replace(/\/+$/, ""), supabaseKey: fromDataKey };
  }

  try {
    const res = await proxyAwareFetch(
      CLI_AUTH_CONFIG,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": `perchai-cli/${providerSpecificData?.cliVersion || "2.4.118"}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      proxyOptions,
    );
    const cfg = await res.json().catch(() => null);
    if (res.ok && cfg?.supabaseUrl && cfg?.supabaseAnonKey) {
      return {
        supabaseUrl: String(cfg.supabaseUrl).replace(/\/+$/, ""),
        supabaseKey: cfg.supabaseAnonKey,
      };
    }
  } catch {
    // fall through to baked defaults
  }
  return { supabaseUrl: DEFAULT_SB_URL, supabaseKey: "" };
}

function planLabel(meter, email) {
  const tier = text(meter?.plan) || text(meter?.tier) || text(meter?.subscription_tier);
  if (tier) return `Perch ${tier[0].toUpperCase()}${tier.slice(1)}`;
  // Heuristic: Starter is quoted as 20k PT; larger spend ceilings imply Pro/Ultra.
  const cap = toFiniteNumber(meter?.monthlyAllowancePt, DEFAULT_MONTHLY_PT);
  if (cap > 20_000 && cap <= 100_000) return "Perch Pro";
  if (cap > 100_000) return "Perch Ultra";
  return email ? `Perch (${email})` : "Perch Starter";
}

export async function getPerchUsage(
  accessToken = null,
  apiKey = null,
  providerSpecificData = null,
  proxyOptions = null,
) {
  const token = text(accessToken) || text(apiKey);
  if (!token) {
    return {
      plan: "Perch AI",
      message: "Perch usage needs a signed-in session. Reconnect with OAuth.",
    };
  }

  try {
    const { supabaseUrl, supabaseKey } = await resolveSupabase(providerSpecificData, proxyOptions);
    if (!supabaseKey) {
      return {
        plan: "Perch AI",
        message: "Could not load Perch Supabase anon key for the usage meter.",
      };
    }

    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);

    const res = await proxyAwareFetch(
      `${supabaseUrl}/rest/v1/rpc/perch_ai_my_inference_usage_meter`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          apikey: supabaseKey,
          Authorization: `Bearer ${token}`,
          "User-Agent": `perchai-cli/${providerSpecificData?.cliVersion || "2.4.118"}`,
        },
        body: JSON.stringify({
          p_day_start: dayStart.toISOString(),
          p_week_start: weekStart.toISOString(),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      proxyOptions,
    );

    if (res.status === 401 || res.status === 403) {
      return {
        plan: "Perch AI",
        message: "Perch refused the session for usage — reconnect with OAuth.",
      };
    }
    if (!res.ok) {
      return {
        plan: "Perch AI",
        message: `Perch usage meter error (${res.status}).`,
      };
    }

    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object") {
      return {
        plan: "Perch AI",
        message: "Perch usage meter returned no data.",
      };
    }

    const monthlyUsd = toFiniteNumber(json.monthly_usd, 0);
    const manualUsd = toFiniteNumber(json.monthly_manual_usd, 0);
    const dailyUsd = toFiniteNumber(json.daily_usd, 0);
    const weeklyUsd = toFiniteNumber(json.weekly_usd, 0);
    const monthlyPt = ptOf(monthlyUsd);
    const manualPt = ptOf(manualUsd);
    const usedPt = Math.max(0, monthlyPt - manualPt);
    const allowancePt = toFiniteNumber(
      json.monthly_allowance_pt ?? json.monthly_allowance_pt_cap ?? json.allowance_pt,
      DEFAULT_MONTHLY_PT,
    );
    const remaining = Math.max(0, allowancePt - usedPt);
    const resetAt = monthResetIso(json.period_start);

    const quotas = {
      "Perch Tokens · month": {
        used: usedPt,
        total: allowancePt,
        remaining,
        remainingPercentage: allowancePt > 0
          ? Math.max(0, Math.min(100, (remaining / allowancePt) * 100))
          : 0,
        resetAt,
        unlimited: false,
        display: `${usedPt.toLocaleString("en-US")} / ${allowancePt.toLocaleString("en-US")} PT`,
      },
    };

    // Secondary windows (informative; not hard plan gates on Starter).
    const dailyPt = ptOf(dailyUsd);
    if (dailyPt > 0 || toFiniteNumber(json.daily_calls, 0) > 0) {
      quotas["Today"] = {
        used: dailyPt,
        total: Math.max(dailyPt, 1),
        remaining: 0,
        remainingPercentage: 0,
        resetAt: null,
        unlimited: true,
        display: `${dailyPt.toLocaleString("en-US")} PT · ${toFiniteNumber(json.daily_calls, 0)} turns`,
      };
    }
    const weeklyPt = ptOf(weeklyUsd);
    if (weeklyPt > 0 || toFiniteNumber(json.weekly_calls, 0) > 0) {
      quotas["7 days"] = {
        used: weeklyPt,
        total: Math.max(weeklyPt, 1),
        remaining: 0,
        remainingPercentage: 0,
        resetAt: null,
        unlimited: true,
        display: `${weeklyPt.toLocaleString("en-US")} PT · ${toFiniteNumber(json.weekly_calls, 0)} turns`,
      };
    }

    const email = text(providerSpecificData?.email);
    return {
      plan: planLabel({
        plan: json.plan || json.tier,
        monthlyAllowancePt: allowancePt,
      }, email),
      quotas,
    };
  } catch (error) {
    return { message: `Perch usage error: ${error.message}` };
  }
}
