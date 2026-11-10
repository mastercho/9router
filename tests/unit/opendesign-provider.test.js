import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";

describe("OpenDesign Cloud provider", () => {
  const entry = REGISTRY.find((e) => e.id === "opendesign");

  it("is registered as oauth + apikey subscription provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("oauth");
    expect(entry.hasOAuth).toBe(true);
    expect(entry.authModes).toEqual(expect.arrayContaining(["oauth", "apikey"]));
    expect(entry.alias).toBe("od");
  });

  it("points inference at amr-link and device auth at amr-api", () => {
    expect(entry.transport.baseUrl).toContain("amr-link.open-design.ai");
    expect(entry.oauth.deviceAuthUrl).toContain("amr-api.open-design.ai");
    expect(entry.oauth.controlBaseUrl).toContain("amr-api.open-design.ai");
  });

  it("builds into runtime PROVIDERS map", () => {
    expect(PROVIDERS.opendesign).toBeDefined();
    expect(PROVIDERS.opendesign.baseUrl).toContain("amr-link.open-design.ai");
  });
});

describe("Perch AI provider", () => {
  const entry = REGISTRY.find((e) => e.id === "perch");

  it("is registered as oauth subscription provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("oauth");
    expect(entry.hasOAuth).toBe(true);
    expect(entry.alias).toBe("perch");
  });

  it("targets Perch app model-call endpoint", () => {
    expect(entry.transport.baseUrl).toContain("app.perchai.app");
    expect(entry.oauth.appUrl).toBe("https://app.perchai.app");
  });

  it("builds into runtime PROVIDERS map", () => {
    expect(PROVIDERS.perch).toBeDefined();
  });
});
