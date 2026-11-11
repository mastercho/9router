import { randomUUID } from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const CLI_VERSION_DEFAULT = "2.4.118";
const TICKET_TIMEOUT_MS = 8_000;
const TICKET_MARGIN_MS = 30_000;

/**
 * Official Perch CLI persona. Perch gates hosted models to Web/Desktop/CLI
 * surfaces and fingerprints the CLI via this system prompt + clientSurface
 * + turn ticket. Without it, model-call returns perch_surface_required.
 * Source: perchai-cli / perch2api prompt.mjs.
 */
export const PERCH_CLI_PERSONA = `You are Perch, a careful and direct assistant.

Answer the question that was asked. Prefer concrete, checkable statements
over hedged generalities; when you are unsure, say which part is uncertain
and why. Use the tools you are given when they would produce a better
answer than reasoning alone, and say what you did with them.

Keep formatting proportionate to the answer: prose for explanations, lists
for enumerations, fenced code blocks for code with the language named. Do
not repeat the question back, do not narrate what you are about to do, and
do not close with a summary of what you just said.`;

const ROOST = {
  perch: "standard",
  "perch-standard": "standard",
  "perch-standard-max": "standard_max",
  "perch-pro": "pro",
  "perch-pro-max": "pro_max",
};

/** Per-process turn-ticket cache keyed by runId. */
const ticketCache = new Map();

function openaiChunk({ id, model, delta, finishReason = null }) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function openaiCompletion({ id, model, content, finishReason, usage }) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: content || "" },
      finish_reason: finishReason || "stop",
    }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function resolveModel(model) {
  const id = String(model || "perch").trim();
  if (ROOST[id]) return { kind: "roost", roostModelChoice: ROOST[id], label: id };
  return { kind: "pin", preferredModelId: id, label: id };
}

function cliVersionOf(credentials) {
  return credentials?.providerSpecificData?.cliVersion
    || process.env.PERCH_CLI_VERSION
    || CLI_VERSION_DEFAULT;
}

function surfaceOf(credentials) {
  return credentials?.providerSpecificData?.clientSurface
    || process.env.PERCH_CLI_SURFACE
    || "cli";
}

function systemPrefixOf(credentials) {
  // Prefer explicit override, then env, then the baked CLI persona (anti-trace).
  const custom = credentials?.providerSpecificData?.systemPrefix
    || process.env.PERCH_SYSTEM_PREFIX
    || "";
  return custom || PERCH_CLI_PERSONA;
}

function prependSystemPrefix(messages, prefix) {
  if (!prefix) return messages;
  const list = Array.isArray(messages) ? [...messages] : [];
  const first = list[0];
  if (first?.role === "system" && typeof first.content === "string") {
    if (first.content.startsWith(prefix) || first.content.includes("You are Perch,")) {
      return list;
    }
    list[0] = { ...first, content: `${prefix}\n\n${first.content}` };
    return list;
  }
  return [{ role: "system", content: prefix }, ...list];
}

/** Decode unsigned JWT/base64url ticket claim blob (no verify — same as perch2api). */
function claimOf(ticket) {
  try {
    const part = String(ticket || "").split(".")[0];
    if (!part) return {};
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64").toString("utf8");
    const obj = JSON.parse(json);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

/**
 * Mint (or reuse) x-perch-turn-ticket — required for strong CLI surface match.
 */
async function mintTurnTicket({ appUrl, accessToken, surface, runId, credentials, signal, proxyOptions, log }) {
  const cached = ticketCache.get(runId);
  if (cached && cached.expiresAt - TICKET_MARGIN_MS > Date.now()) {
    return cached;
  }

  const url = `${appUrl}/api/perch-terminal/turn-ticket`;
  const version = cliVersionOf(credentials);
  try {
    const res = await proxyAwareFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": `perchai-cli/${version}`,
        "x-perch-locale": "en",
      },
      body: JSON.stringify({ surface, profile: "standard" }),
      signal: signal || AbortSignal.timeout(TICKET_TIMEOUT_MS),
    }, proxyOptions);

    const json = await res.json().catch(() => null);
    if (res.status === 429 || json?.errorCode === "turn_rate_limited") {
      log?.warn?.("PERCH", "turn ticket rate-limited");
      return null;
    }
    if (!res.ok || !json?.ticket) {
      log?.warn?.("PERCH", `turn-ticket HTTP ${res.status}`);
      return null;
    }

    const claim = claimOf(json.ticket);
    const expiresAt = Number.isFinite(Number(json.expiresAt))
      ? Number(json.expiresAt)
      : (Number.isFinite(Number(claim.exp)) ? Number(claim.exp) * 1000 : Date.now() + 120_000);
    const entry = {
      token: json.ticket,
      runId: json.runId || runId,
      expiresAt,
      userId: claim.uid || null,
      workspaceId: claim.wid || null,
    };
    if (ticketCache.size > 64) ticketCache.delete(ticketCache.keys().next().value);
    ticketCache.set(runId, entry);
    if (json.runId && json.runId !== runId) ticketCache.set(json.runId, entry);
    return entry;
  } catch (err) {
    log?.warn?.("PERCH", `turn-ticket error: ${err.message}`);
    return null;
  }
}

/**
 * Perch model-call executor with CLI-surface anti-tracing:
 *  - User-Agent: perchai-cli/<ver>
 *  - clientSurface: "cli"
 *  - baked CLI persona as system prefix
 *  - x-perch-turn-ticket + attribution.workspaceId from ticket claims
 */
export class PerchExecutor extends BaseExecutor {
  constructor() {
    super("perch", PROVIDERS.perch || {
      id: "perch",
      baseUrl: "https://app.perchai.app/api/perch-terminal/model-call",
    });
  }

  buildHeaders(credentials, ticketToken = null) {
    const version = cliVersionOf(credentials);
    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": `perchai-cli/${version}`,
      "x-perch-locale": "en",
      Authorization: `Bearer ${credentials.accessToken || credentials.apiKey || ""}`,
    };
    if (ticketToken) headers["x-perch-turn-ticket"] = ticketToken;
    return headers;
  }

  buildPerchBody(model, body, credentials, { runId, ticket } = {}) {
    const resolved = resolveModel(model);
    const prefix = systemPrefixOf(credentials);
    const messages = prependSystemPrefix(body?.messages || [], prefix);
    const request = { messages };
    if (Array.isArray(body?.tools) && body.tools.length) {
      request.tools = body.tools;
      request.toolChoice = body.tool_choice || "auto";
    }
    if (Number.isFinite(body?.max_tokens)) request.maxTokens = body.max_tokens;
    if (Number.isFinite(body?.temperature)) request.temperature = body.temperature;

    const surface = surfaceOf(credentials);
    const out = {
      request,
      runId: ticket?.runId || runId || randomUUID(),
      lane: credentials?.providerSpecificData?.lane || process.env.PERCH_LANE || "code",
      strictManual: false,
      clientSurface: surface,
      attribution: {
        userId: ticket?.userId
          || credentials?.providerSpecificData?.userId
          || null,
        workspaceId: ticket?.workspaceId
          || credentials?.providerSpecificData?.workspaceId
          || null,
        source: "cli",
      },
      avoidModelIds: [],
      resendAfterOutput: true,
    };
    if (resolved.kind === "roost") out.roostModelChoice = resolved.roostModelChoice;
    else {
      out.preferredModelId = resolved.preferredModelId;
      out.manualModelOptionId = resolved.preferredModelId;
    }
    return { out, label: resolved.label };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const appUrl = (credentials?.providerSpecificData?.appUrl || "https://app.perchai.app").replace(/\/+$/, "");
    const url = `${appUrl}/api/perch-terminal/model-call`;
    const accessToken = credentials.accessToken || credentials.apiKey || "";
    const surface = surfaceOf(credentials);
    const runId = randomUUID();

    const ticket = await mintTurnTicket({
      appUrl,
      accessToken,
      surface,
      runId,
      credentials,
      signal,
      proxyOptions,
      log,
    });

    const { out: perchBody, label } = this.buildPerchBody(model, body, credentials, { runId, ticket });
    const headers = this.buildHeaders(credentials, ticket?.token || null);

    const upstream = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(perchBody),
      signal,
    }, proxyOptions);

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      let hint = text;
      try {
        const j = JSON.parse(text);
        if (j?.errorCode === "perch_surface_required") {
          hint = JSON.stringify({
            ...j,
            hint: "Surface gate rejected the call. 9Router already sends CLI persona + turn ticket; reconnect OAuth and retry.",
          });
        }
      } catch { /* keep raw */ }
      return {
        response: new Response(hint || JSON.stringify({ error: { message: `Perch HTTP ${upstream.status}` } }), {
          status: upstream.status,
          headers: { "Content-Type": "application/json" },
        }),
        url,
        headers,
        transformedBody: perchBody,
      };
    }

    const id = `chatcmpl-perch-${randomUUID()}`;
    if (!stream) {
      const { content, finishReason, usage, error } = await this.#consume(upstream);
      if (error) {
        return {
          response: new Response(JSON.stringify({ error: { message: error } }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          }),
          url,
          headers,
          transformedBody: perchBody,
          responseFormat: "openai",
        };
      }
      return {
        response: new Response(JSON.stringify(openaiCompletion({
          id, model: label, content, finishReason, usage,
        })), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        url,
        headers,
        transformedBody: perchBody,
        responseFormat: "openai",
      };
    }

    const response = this.#streamAsOpenAI(upstream, { id, model: label });
    return { response, url, headers, transformedBody: perchBody, responseFormat: "openai" };
  }

  async #consume(upstream) {
    const reader = upstream.body?.getReader?.();
    if (!reader) return { content: "", finishReason: "stop" };
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    let finishReason = "stop";
    let usage = null;
    let error = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        if (evt.type === "answer_delta" && evt.text) content += evt.text;
        if (evt.type === "model_call_failed") error = evt.message || evt.code || "model_call_failed";
        if (evt.type === "done") {
          if (evt.text && !content) content = evt.text;
          finishReason = evt.finishReason || finishReason;
          usage = evt.usage || usage;
          if (evt.ok === false) error = evt.message || evt.code || error || "done_not_ok";
        }
      }
    }
    return { content, finishReason, usage, error };
  }

  #streamAsOpenAI(upstream, { id, model }) {
    const reader = upstream.body?.getReader?.();
    const decoder = new TextDecoder();
    let buf = "";
    let roleSent = false;

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        try {
          if (!reader) {
            send(openaiChunk({ id, model, delta: { role: "assistant", content: "" }, finishReason: "stop" }));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() || "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload) continue;
              let evt;
              try { evt = JSON.parse(payload); } catch { continue; }
              if (evt.type === "answer_delta" && evt.text) {
                if (!roleSent) {
                  send(openaiChunk({ id, model, delta: { role: "assistant" } }));
                  roleSent = true;
                }
                send(openaiChunk({ id, model, delta: { content: evt.text } }));
              } else if (evt.type === "reasoning_delta" && evt.text) {
                if (!roleSent) {
                  send(openaiChunk({ id, model, delta: { role: "assistant" } }));
                  roleSent = true;
                }
                send(openaiChunk({ id, model, delta: { reasoning_content: evt.text } }));
              } else if (evt.type === "done") {
                if (evt.text && !roleSent) {
                  send(openaiChunk({ id, model, delta: { role: "assistant", content: evt.text } }));
                  roleSent = true;
                }
                send(openaiChunk({
                  id,
                  model,
                  delta: {},
                  finishReason: evt.finishReason || "stop",
                }));
              } else if (evt.type === "model_call_failed") {
                send(openaiChunk({
                  id,
                  model,
                  delta: { content: `\n[Perch error: ${evt.message || evt.code || "failed"}]` },
                }));
                send(openaiChunk({ id, model, delta: {}, finishReason: "stop" }));
              }
            }
          }
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          try {
            send(openaiChunk({
              id,
              model,
              delta: { content: `\n[Perch stream error: ${err.message}]` },
            }));
            send(openaiChunk({ id, model, delta: {}, finishReason: "stop" }));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          } catch {
            controller.error(err);
          }
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
}
