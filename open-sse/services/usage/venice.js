/**
 * Venice AI usage — GET /api/v1/billing/balance
 *
 * Requires an ADMIN API key (inference-only keys get 401).
 * Shows DIEM / bundled credits / earned credits / USD wallet.
 * Venice Pro web subscription is NOT an API entitlement.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { toFiniteNumber } from "./shared.js";

const BALANCE_URL = "https://api.venice.ai/api/v1/billing/balance";
const TIMEOUT_MS = 20_000;

function text(v) {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function moneyQuota(name, remaining, total = null) {
  const rem = Math.max(0, toFiniteNumber(remaining, 0));
  if (total == null || !(total > 0)) {
    return {
      used: 0,
      total: Math.max(rem, 0.01),
      remaining: rem,
      remainingPercentage: rem > 0 ? 100 : 0,
      resetAt: null,
      unlimited: false,
      display: rem.toLocaleString("en-US", { maximumFractionDigits: 4 }),
    };
  }
  const tot = toFiniteNumber(total, rem);
  const used = Math.max(0, tot - rem);
  return {
    used,
    total: tot,
    remaining: rem,
    remainingPercentage: tot > 0 ? Math.max(0, Math.min(100, (rem / tot) * 100)) : 0,
    resetAt: null,
    unlimited: false,
    display: `${rem.toLocaleString("en-US", { maximumFractionDigits: 2 })} / ${tot.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
  };
}

export async function getVeniceUsage(apiKey = null, proxyOptions = null) {
  const key = text(apiKey);
  if (!key) {
    return {
      plan: "Venice AI",
      message: "Add a Venice API key to view balance. Billing needs an ADMIN key.",
    };
  }

  try {
    const res = await proxyAwareFetch(
      BALANCE_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      proxyOptions,
    );

    if (res.status === 401 || res.status === 403) {
      const err = await res.json().catch(() => null);
      const msg = text(err?.error) || "";
      const needsAdmin = /admin/i.test(msg) || res.status === 401;
      return {
        plan: "Venice AI (API credits)",
        message: needsAdmin
          ? "Billing balance needs a Venice ADMIN API key (inference keys cannot read /billing/balance). Pro web sub ≠ API credits."
          : `Venice billing refused the key (${res.status}).`,
      };
    }

    if (!res.ok) {
      return {
        plan: "Venice AI",
        message: `Venice billing API error (${res.status}).`,
      };
    }

    const data = await res.json().catch(() => null);
    const balances = data?.balances || {};
    const quotas = {};

    const diem = balances.diem;
    const diemAlloc = toFiniteNumber(data?.diemEpochAllocation, NaN);
    if (diem != null && Number.isFinite(Number(diem))) {
      quotas.DIEM = moneyQuota(
        "DIEM",
        diem,
        Number.isFinite(diemAlloc) && diemAlloc > 0 ? diemAlloc : null,
      );
    }

    if (balances.bundledCredits != null && Number.isFinite(Number(balances.bundledCredits))) {
      quotas["Bundled credits"] = moneyQuota("Bundled", balances.bundledCredits);
    }
    if (balances.earnedCredits != null && Number.isFinite(Number(balances.earnedCredits))) {
      quotas["Earned credits"] = moneyQuota("Earned", balances.earnedCredits);
    }
    if (balances.usd != null && Number.isFinite(Number(balances.usd))) {
      quotas.USD = {
        ...moneyQuota("USD", Math.max(0, Number(balances.usd))),
        display: `$${Number(balances.usd).toFixed(2)}`,
      };
    }

    const currency = text(data?.consumptionCurrency);
    const result = {
      plan: "Venice AI (API credits)",
      quotas,
    };
    if (currency) result.balance = `spending ${currency}`;
    if (data?.canConsume === false) {
      result.message = "Venice reports canConsume=false — top up API credits (web Pro sub does not fund the API).";
    } else if (Object.keys(quotas).length === 0) {
      result.message = "No positive Venice API balances. Web Pro unlimited text does not apply here.";
    }

    return result;
  } catch (error) {
    return { message: `Venice usage error: ${error.message}` };
  }
}
