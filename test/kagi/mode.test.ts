import { describe, expect, it } from "vitest";
import { resolveMode } from "../../src/kagi/mode";
import { KagiNotConfiguredError } from "../../src/kagi/errors";
import type { Env } from "../../src/env";

function env(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_TOKEN: "x",
    ...overrides,
  } as Env;
}

describe("resolveMode", () => {
  it("respects explicit KAGI_MODE=scrape regardless of credentials", () => {
    const r = resolveMode(env({ KAGI_MODE: "scrape", KAGI_API_KEY: "k" }));
    expect(r.mode).toBe("scrape");
    expect(r.reason).toContain("KAGI_MODE=scrape");
  });

  it("respects explicit KAGI_MODE=api", () => {
    const r = resolveMode(env({ KAGI_MODE: "api", KAGI_API_KEY: "k" }));
    expect(r.mode).toBe("api");
  });

  it("respects explicit KAGI_MODE=hybrid", () => {
    const r = resolveMode(
      env({ KAGI_MODE: "hybrid", KAGI_SESSION_TOKEN: "s", KAGI_API_KEY: "k" }),
    );
    expect(r.mode).toBe("hybrid");
  });

  it("auto → scrape when only session is set", () => {
    const r = resolveMode(env({ KAGI_SESSION_TOKEN: "s" }));
    expect(r.mode).toBe("scrape");
    expect(r.reason).toMatch(/auto/);
    expect(r.has_session).toBe(true);
    expect(r.has_api_key).toBe(false);
  });

  it("auto → api when only api key is set", () => {
    const r = resolveMode(env({ KAGI_API_KEY: "k" }));
    expect(r.mode).toBe("api");
    expect(r.has_api_key).toBe(true);
  });

  it("auto → hybrid when both are set", () => {
    const r = resolveMode(env({ KAGI_SESSION_TOKEN: "s", KAGI_API_KEY: "k" }));
    expect(r.mode).toBe("hybrid");
    expect(r.has_session).toBe(true);
    expect(r.has_api_key).toBe(true);
  });

  it("auto with neither credential throws", () => {
    expect(() => resolveMode(env())).toThrow(/No Kagi credentials/);
  });

  // A missing-credentials deploy is an operator-fixable setup error, not an
  // internal failure: it must be typed so REST/MCP can surface the actionable
  // message (ADR 0012 kind not_configured -> 503) instead of a generic 500.
  it("auto with neither credential throws KagiNotConfiguredError naming the fix", () => {
    let thrown: unknown;
    try {
      resolveMode(env());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(KagiNotConfiguredError);
    expect((thrown as KagiNotConfiguredError).kind).toBe("not_configured");
    expect((thrown as Error).message).toMatch(/KAGI_SESSION_TOKEN|KAGI_API_KEY/);
  });

  it("an unknown KAGI_MODE throws KagiNotConfiguredError", () => {
    let thrown: unknown;
    try {
      resolveMode(env({ KAGI_MODE: "yolo" }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(KagiNotConfiguredError);
    expect((thrown as KagiNotConfiguredError).kind).toBe("not_configured");
    expect((thrown as Error).message).toMatch(/Invalid KAGI_MODE/);
  });

  it("defaults to auto when KAGI_MODE is unset", () => {
    const r = resolveMode(env({ KAGI_SESSION_TOKEN: "s" }));
    expect(r.mode).toBe("scrape");
  });

  it("case-insensitive on KAGI_MODE", () => {
    const r = resolveMode(env({ KAGI_MODE: "SCRAPE" }));
    expect(r.mode).toBe("scrape");
  });

  it("rejects an unknown KAGI_MODE value", () => {
    expect(() => resolveMode(env({ KAGI_MODE: "yolo" }))).toThrow(/Invalid KAGI_MODE/);
  });

  it("treats empty-string secrets as absent", () => {
    const r = resolveMode(env({ KAGI_SESSION_TOKEN: "", KAGI_API_KEY: "k" }));
    expect(r.mode).toBe("api");
    expect(r.has_session).toBe(false);
  });
});
