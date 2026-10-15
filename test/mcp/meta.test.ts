import { describe, expect, it } from "vitest";
import { addWarning, buildMeta } from "../../src/mcp/meta";

describe("buildMeta", () => {
  it("computes elapsed_ms from start_ms", () => {
    const start = Date.now() - 100;
    const meta = buildMeta({ impl: "scrape", start_ms: start });
    expect(meta.elapsed_ms).toBeGreaterThanOrEqual(100);
    expect(meta.impl).toBe("scrape");
    expect(meta.cache_hit).toBe(false);
  });

  it("passes through optional fields when provided", () => {
    const meta = buildMeta({
      impl: "api",
      start_ms: Date.now(),
      cache_hit: true,
      cost_cents: 1.5,
      trace_id: "abc123",
      warnings: ["fell back to web workflow"],
    });
    expect(meta.impl).toBe("api");
    expect(meta.cache_hit).toBe(true);
    expect(meta.cost_cents).toBe(1.5);
    expect(meta.trace_id).toBe("abc123");
    expect(meta.warnings).toEqual(["fell back to web workflow"]);
  });

  it("omits empty warnings array", () => {
    const meta = buildMeta({
      impl: "scrape",
      start_ms: Date.now(),
      warnings: [],
    });
    expect(meta.warnings).toBeUndefined();
  });

  it("clamps negative elapsed_ms to 0 (guards against clock skew)", () => {
    const meta = buildMeta({
      impl: "scrape",
      start_ms: Date.now() + 10_000,
    });
    expect(meta.elapsed_ms).toBe(0);
  });
});

describe("addWarning", () => {
  it("appends without mutating the input", () => {
    const base = buildMeta({ impl: "scrape", start_ms: Date.now() });
    const next = addWarning(base, "first");
    const nextnext = addWarning(next, "second");
    expect(base.warnings).toBeUndefined();
    expect(next.warnings).toEqual(["first"]);
    expect(nextnext.warnings).toEqual(["first", "second"]);
  });
});
