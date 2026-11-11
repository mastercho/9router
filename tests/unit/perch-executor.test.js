import { describe, expect, it } from "vitest";
import { PerchExecutor, PERCH_CLI_PERSONA } from "../../open-sse/executors/perch.js";
import { existsSync } from "node:fs";

describe("PerchExecutor anti-tracing", () => {
  const ex = new PerchExecutor();

  it("bakes CLI persona when no custom prefix is set", () => {
    const { out } = ex.buildPerchBody("perch", {
      messages: [{ role: "user", content: "hi" }],
    }, { providerSpecificData: { userId: "u1" } }, { runId: "run-1" });

    expect(out.clientSurface).toBe("cli");
    expect(out.attribution.source).toBe("cli");
    expect(out.request.messages[0].role).toBe("system");
    expect(out.request.messages[0].content).toContain("You are Perch,");
    expect(out.request.messages[0].content).toContain(PERCH_CLI_PERSONA.slice(0, 40));
    expect(out.roostModelChoice).toBe("standard");
  });

  it("sets CLI User-Agent and optional turn ticket header", () => {
    const h = ex.buildHeaders({
      accessToken: "tok",
      providerSpecificData: { cliVersion: "2.4.118" },
    }, "ticket-abc");
    expect(h["User-Agent"]).toBe("perchai-cli/2.4.118");
    expect(h["x-perch-locale"]).toBe("en");
    expect(h["x-perch-turn-ticket"]).toBe("ticket-abc");
    expect(h.Authorization).toBe("Bearer tok");
  });

  it("ships a perch provider icon", () => {
    expect(existsSync(new URL("../../public/providers/perch.png", import.meta.url))).toBe(true);
  });
});
