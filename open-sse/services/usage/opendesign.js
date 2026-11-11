/**
 * OpenDesign Cloud usage — Design Plan windows via amr-api control plane.
 *
 * Needs the OAuth control key (vela_ctrl_…). A pasted sk-amr-… API key alone
 * cannot read allowance (same limitation as opencode-opendesign-auth).
 *
 * Endpoints (observed from Open Design CLI / community auth plugins):
 *   GET  /api/v1/workspaces/current
 *   GET  /api/v1/workspaces/{id}/billing/preflight
 *   GET  /api/v1/billing/summary
 *
 * OpenDesign Design Plan (official billing help):
 *   - Go: live 5-hour + 7-day windows
 *   - Plus / Pro / Max: live 7-day window only (no 5-hour)
 *   - There is NO separate monthly Design Plan % meter in preflight
 *     (unlike OpenCode Go). Docs list a billing-period Design Plan maximum
 *     and Top Model Credits (Plus+) that reset on the billing cycle; those
 *     are not returned as codingPlan.windows.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { parseResetTime, toFiniteNumber } from "./shared.js";

const CONTROL = "https://amr-api.open-design.ai";
const TIMEOUT_MS = 20_000;

/** Published Individual plan caps (USD). Live remaining is not in preflight. */
const PLAN_CAPS = {
  go: { designPlanMonthUsd: 120, topModelMonthUsd: 0, weeklyUsd: 30, fiveHourUsd: 10 },
  plus: { designPlanMonthUsd: 160, topModelMonthUsd: 20, weeklyUsd: 40, fiveHourUsd: null },
  pro: { designPlanMonthUsd: 360, topModelMonthUsd: 120, weeklyUsd: 90, fiveHourUsd: null },
  max: { designPlanMonthUsd: 600, topModelMonthUsd: 300, weeklyUsd: 150, fiveHourUsd: null },
};

function text(v) {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function controlKeyOf(accessToken, apiKey, providerSpecificData) {
  const fromData = text(providerSpecificData?.controlKey);
  if (fromData.startsWith("vela_ctrl_")) return fromData;
  for (const cand of [accessToken, apiKey]) {
    const v = text(cand);
    if (v.startsWith("vela_ctrl_")) return v;
  }
  return "";
}

/**
 * Match OpenCode-style labels so the quota tracker reads the same way.
 * OpenDesign's 7-day window is the weekly gate; there is no monthly window row.
 */
function windowName(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return "Allowance";
  const HOUR = 3600;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  if (Math.abs(s - 5 * HOUR) < 60) return "5 hours";
  if (Math.abs(s - 7 * DAY) < 60) return "Weekly";
  if (s % WEEK === 0) {
    const n = s / WEEK;
    return n === 1 ? "Weekly" : `${n * 7} days`;
  }
  if (s % DAY === 0) {
    const n = s / DAY;
    return n === 1 ? "1 day" : `${n} days`;
  }
  if (s % HOUR === 0) {
    const n = s / HOUR;
    return n === 1 ? "1 hour" : `${n} hours`;
  }
  return `${Math.round(s / 60)} minutes`;
}

function membershipTier(summary, preflight) {
  return text(summary?.membershipTier)
    || text(preflight?.membershipTier)
    || text(preflight?.personalMembershipTier)
    || text(summary?.personalMembershipTier)
    || text(preflight?.codingPlan?.tier)
    || text(preflight?.tier);
}

function planName(summary, preflight, codingPlan) {
  const tier = membershipTier(summary, preflight);
  // Free / no Design Plan: OpenDesign still returns codingPlan.eligible === false.
  if (codingPlan && codingPlan.eligible === false) {
    if (!tier || tier.toLowerCase() === "free") return "OpenDesign Free";
    return `OpenDesign ${tier[0].toUpperCase()}${tier.slice(1)} (no Design Plan)`;
  }
  if (!tier) return "OpenDesign Cloud";
  if (tier.toLowerCase() === "free") return "OpenDesign Free";
  return `Design Plan ${tier[0].toUpperCase()}${tier.slice(1)}`;
}

function planCapsFor(tier) {
  const key = text(tier).toLowerCase();
  return PLAN_CAPS[key] || null;
}

function planMessage({ tier, hasFiveHour, hasWeekly, noDesignPlan, balanceUsd }) {
  if (noDesignPlan) {
    if (Number.isFinite(balanceUsd) && balanceUsd > 0) {
      return "Free has no Design Plan windows. The Wallet amount is trial/top-up balance (often DeepSeek V4.1 Flash only, short expiry) — not a recurring subscription allowance.";
    }
    return "Free has no Design Plan allowance. Upgrade to Go/Plus for recurring credits, or use wallet top-up / BYOK.";
  }

  const caps = planCapsFor(tier);
  const bits = [];

  if (hasWeekly && !hasFiveHour) {
    bits.push(
      "OpenDesign Plus/Pro/Max Design Plan only exposes a Weekly (7-day) live window — there is no 5-hour row and no OpenCode-style Monthly % meter in the API.",
    );
  } else if (hasFiveHour && hasWeekly) {
    bits.push(
      "Live Design Plan gates are 5 hours + Weekly. OpenDesign does not return a separate Monthly usage % (unlike OpenCode Go).",
    );
  } else if (!hasWeekly && !hasFiveHour) {
    bits.push("OpenDesign returned no Design Plan window data.");
  }

  if (caps) {
    const top = caps.topModelMonthUsd > 0
      ? `; Top Model Credits $${caps.topModelMonthUsd}/mo (billing cycle)`
      : "";
    bits.push(
      `Published Design Plan monthly maximum ≈ $${caps.designPlanMonthUsd}${top}. Weekly live cap ≈ $${caps.weeklyUsd}${caps.fiveHourUsd != null ? `; 5h ≈ $${caps.fiveHourUsd}` : ""}.`,
    );
  }

  return bits.join(" ");
}

async function api(path, controlKey, proxyOptions) {
  return proxyAwareFetch(
    `${CONTROL}${path}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${controlKey}`,
        Accept: "application/json",
        "User-Agent": "9router-opendesign/1.0",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
    proxyOptions,
  );
}

export async function getOpenDesignUsage(
  accessToken = null,
  apiKey = null,
  providerSpecificData = null,
  proxyOptions = null,
) {
  const controlKey = controlKeyOf(accessToken, apiKey, providerSpecificData);
  if (!controlKey) {
    return {
      plan: "OpenDesign Cloud",
      message:
        "OpenDesign Design Plan allowance needs account OAuth (control key). Reconnect with OAuth, not only an API key.",
    };
  }

  try {
    const wsRes = await api("/api/v1/workspaces/current", controlKey, proxyOptions);
    if (wsRes.status === 401 || wsRes.status === 403) {
      return {
        plan: "OpenDesign Cloud",
        message: "OpenDesign refused the control key — reconnect with OAuth.",
      };
    }
    if (!wsRes.ok) {
      return {
        plan: "OpenDesign Cloud",
        message: `OpenDesign workspaces API error (${wsRes.status}).`,
      };
    }
    const ws = await wsRes.json().catch(() => null);
    const workspaceId = text(ws?.activeWorkspaceId) || text(ws?.workspaceId);
    if (!workspaceId) {
      return {
        plan: "OpenDesign Cloud",
        message: "OpenDesign account has no active workspace.",
      };
    }

    const preflightRes = await api(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/billing/preflight`,
      controlKey,
      proxyOptions,
    );
    if (preflightRes.status === 401 || preflightRes.status === 403) {
      return {
        plan: "OpenDesign Cloud",
        message: "OpenDesign refused the control key — reconnect with OAuth.",
      };
    }
    if (!preflightRes.ok) {
      return {
        plan: "OpenDesign Cloud",
        message: `OpenDesign billing preflight error (${preflightRes.status}).`,
      };
    }
    const preflight = await preflightRes.json().catch(() => null);
    const plan = preflight?.codingPlan ?? null;

    const summaryRes = await api("/api/v1/billing/summary", controlKey, proxyOptions);
    const summary = summaryRes.ok ? await summaryRes.json().catch(() => null) : null;

    const quotas = {};
    for (const w of plan?.windows ?? []) {
      // Prefer remainingCredits when present; used/limit may arrive as strings.
      const used = toFiniteNumber(w?.usedCredits, NaN);
      const total = toFiniteNumber(w?.limitCredits, NaN);
      const remainingHint = toFiniteNumber(w?.remainingCredits, NaN);
      if (!Number.isFinite(total) || total <= 0) continue;
      const remaining = Number.isFinite(remainingHint)
        ? Math.max(0, remainingHint)
        : Number.isFinite(used)
          ? Math.max(0, total - used)
          : NaN;
      if (!Number.isFinite(remaining)) continue;
      const usedSafe = Number.isFinite(used) ? used : Math.max(0, total - remaining);
      const name = windowName(w?.durationSeconds);
      quotas[name] = {
        used: usedSafe,
        total,
        remaining,
        remainingPercentage: Math.max(0, Math.min(100, (remaining / total) * 100)),
        resetAt: parseResetTime(w?.resetsAt),
        unlimited: false,
        display: `${usedSafe} / ${total} credits`,
      };
    }

    const balanceUsd = toFiniteNumber(preflight?.balanceUsd ?? summary?.balanceUsd, NaN);
    const hasFiveHour = Boolean(quotas["5 hours"]);
    const hasWeekly = Boolean(quotas.Weekly);
    const hasDesignWindows = hasFiveHour || hasWeekly || Object.keys(quotas).length > 0;
    const noDesignPlan = plan && plan.eligible === false && !hasDesignWindows;
    const tier = membershipTier(summary, { ...preflight, ...ws, codingPlan: plan });

    // Free / trial accounts have no Design Plan windows; usable cloud credit is wallet.
    if (Number.isFinite(balanceUsd) && (!hasDesignWindows || noDesignPlan)) {
      quotas.Wallet = {
        used: 0,
        total: balanceUsd,
        remaining: Math.max(0, balanceUsd),
        remainingPercentage: balanceUsd > 0 ? 100 : 0,
        resetAt: null,
        unlimited: false,
        display: `$${balanceUsd.toFixed(2)} remaining`,
      };
    }

    const result = {
      plan: planName(summary, { ...preflight, ...ws }, plan),
      quotas,
    };

    if (Number.isFinite(balanceUsd)) {
      result.balance = `$${balanceUsd.toFixed(2)}`;
    }

    const message = planMessage({
      tier,
      hasFiveHour,
      hasWeekly,
      noDesignPlan,
      balanceUsd,
    });
    if (message) result.message = message;

    return result;
  } catch (error) {
    return { message: `OpenDesign usage error: ${error.message}` };
  }
}
