/**
 * OpenDesign Cloud (open-design.ai) — subscription Design Plan credits.
 *
 * Auth:
 *  - OAuth device flow against amr-api (vela login shape) → runtimeKey (sk-amr-…)
 *    + controlKey (vela_ctrl-…) for plan/allowance reads
 *  - API key paste: sk-amr-… from Cloud console (same subscription credits; no quota UI)
 *
 * Inference: OpenAI-compatible gateway at amr-link.open-design.ai/v1
 */
export default {
  id: "opendesign",
  priority: 118,
  alias: "od",
  aliases: ["open-design", "opendesign-cloud"],
  uiAlias: "od",
  display: {
    name: "OpenDesign Cloud",
    icon: "palette",
    color: "#7C3AED",
    textIcon: "OD",
    website: "https://open-design.ai",
    notice: {
      text: "Go / Plus / Pro / Max include Design Plan credits (shared with the app). Free has no recurring Design Plan — only short trial wallet credit (often DeepSeek V4.1 Flash).",
      apiKeyUrl: "https://open-design.ai/help/cloud-api/",
      signupUrl: "https://open-design.ai/pricing/",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  authHint: "Paste sk-amr-… from OpenDesign Cloud → API keys (uses your plan credits)",
  transport: {
    baseUrl: "https://amr-link.open-design.ai/v1/chat/completions",
    validateUrl: "https://amr-link.open-design.ai/v1/models",
    format: "openai",
    thinkingFormat: "openai",
  },
  transports: [
    {
      format: "openai",
      baseUrl: "https://amr-link.open-design.ai/v1/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "openai-responses",
      baseUrl: "https://amr-link.open-design.ai/v1/responses",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
      thinkingFormat: "openai-responses",
    },
    {
      format: "claude",
      baseUrl: "https://amr-link.open-design.ai/v1/messages",
      auth: { combined: true, header: "x-api-key", scheme: "raw", anthropicVersion: true },
      thinkingFormat: "claude-adaptive",
    },
  ],
  // Seed only — live catalogue comes from modelsFetcher / passthrough.
  models: [
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "glm-5.3", name: "GLM 5.3" },
    { id: "gpt-6-luna", name: "GPT-6 Luna" },
    { id: "claude-haiku-5.5", name: "Claude Haiku 5.5" },
    { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
  ],
  modelsFetcher: {
    url: "https://amr-link.open-design.ai/v1/models",
    type: "openai",
  },
  passthroughModels: true,
  oauth: {
    controlBaseUrl: "https://amr-api.open-design.ai",
    linkBaseUrl: "https://amr-link.open-design.ai/v1",
    deviceAuthUrl: "https://amr-api.open-design.ai/api/v1/cli/device-authorizations",
    // Poll: POST {deviceAuthUrl}/{deviceId}/token  body: { deviceSecret }
    profile: "prod",
    cliVersion: "0.1.4",
    activationHost: "https://open-design.ai",
  },
  features: {
    usage: true,
  },
};
