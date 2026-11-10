import { randomUUID } from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const ROOST = {
  perch: "standard",
  "perch-standard": "standard",
  "perch-standard-max": "standard_max",
  "perch-pro": "pro",
  "perch-pro-max": "pro_max",
};

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

function prependSystemPrefix(messages, prefix) {
  if (!prefix) return messages;
  const list = Array.isArray(messages) ? [...messages] : [];
  const first = list[0];
  if (first?.role === "system" && typeof first.content === "string") {
    if (first.content.startsWith(prefix)) return list;
    list[0] = { ...first, content: `${prefix}${first.content}` };
    return list;
  }
  return [{ role: "system", content: prefix }, ...list];
}

/**
 * Perch model-call executor.
 *
 * Requires a system-prefix that satisfies Perch's surface gate
 * (`perch_surface_required` without it). Set via:
 *  - credentials.providerSpecificData.systemPrefix
 *  - process.env.PERCH_SYSTEM_PREFIX
 *
 * Extract once with perch2api's `node scripts/extract-prefix.mjs`.
 */
export class PerchExecutor extends BaseExecutor {
  constructor() {
    super("perch", PROVIDERS.perch || {
      id: "perch",
      baseUrl: "https://app.perchai.app/api/perch-terminal/model-call",
    });
  }

  buildHeaders(credentials) {
    const version = credentials?.providerSpecificData?.cliVersion || "2.4.118";
    return {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": `perchai-cli/${version}`,
      "x-perch-locale": "en",
      Authorization: `Bearer ${credentials.accessToken || credentials.apiKey || ""}`,
    };
  }

  buildPerchBody(model, body, credentials) {
    const resolved = resolveModel(model);
    const prefix = credentials?.providerSpecificData?.systemPrefix
      || process.env.PERCH_SYSTEM_PREFIX
      || "";
    const messages = prependSystemPrefix(body?.messages || [], prefix);
    const request = { messages };
    if (Array.isArray(body?.tools) && body.tools.length) {
      request.tools = body.tools;
      request.toolChoice = body.tool_choice || "auto";
    }
    if (Number.isFinite(body?.max_tokens)) request.maxTokens = body.max_tokens;
    if (Number.isFinite(body?.temperature)) request.temperature = body.temperature;

    const out = {
      request,
      runId: randomUUID(),
      lane: credentials?.providerSpecificData?.lane || process.env.PERCH_LANE || "code",
      strictManual: false,
      clientSurface: "cli",
      attribution: {
        userId: credentials?.providerSpecificData?.userId || null,
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
    const { out: perchBody, label } = this.buildPerchBody(model, body, credentials);
    const headers = this.buildHeaders(credentials);

    if (!credentials?.providerSpecificData?.systemPrefix && !process.env.PERCH_SYSTEM_PREFIX) {
      log?.warn?.("PERCH", "PERCH_SYSTEM_PREFIX / systemPrefix missing — upstream may return perch_surface_required");
    }

    const upstream = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(perchBody),
      signal,
    }, proxyOptions);

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return {
        response: new Response(text || JSON.stringify({ error: { message: `Perch HTTP ${upstream.status}` } }), {
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
