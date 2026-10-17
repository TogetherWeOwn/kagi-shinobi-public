// Result-cache keys (ADR 0017): `sha256(domain|engine|normalized args)`.
//
// Pure logic, so it runs in the Node project. What matters is that equal
// queries share a key and different ones never do — a collision here would
// serve one caller's results to another query.

import { describe, expect, it } from "vitest";
import { CACHE_DOMAINS, TTL_SECONDS, cacheKey, normalizeArgs } from "../../src/cache/key";

describe("normalizeArgs", () => {
  it("trims strings, drops undefined, and sorts object keys", () => {
    expect(JSON.stringify(normalizeArgs({ q: "  kagi ", lens_id: undefined, limit: 10 }))).toBe(
      JSON.stringify({ limit: 10, q: "kagi" }),
    );
  });

  it("keeps array order and recurses into arrays and nested objects", () => {
    expect(normalizeArgs({ d: [" b ", "a"], n: { z: 1, a: " x " } })).toEqual({
      d: ["b", "a"],
      n: { a: "x", z: 1 },
    });
  });

  it("passes numbers, booleans and null through", () => {
    expect(normalizeArgs({ a: 0, b: false, c: null })).toEqual({ a: 0, b: false, c: null });
  });
});

describe("cacheKey", () => {
  it("is a 64-char lowercase sha256 hex digest", async () => {
    expect(await cacheKey("search", "kagi", { q: "kagi" })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across whitespace, key order and undefined fields", async () => {
    const a = await cacheKey("search", "kagi", { q: "kagi", limit: 10 });
    const b = await cacheKey("search", "kagi", { limit: 10, q: " kagi ", lens_id: undefined });
    expect(b).toBe(a);
  });

  it("separates domain, engine, impl and every result-shaping arg", async () => {
    const base = await cacheKey("search", "kagi", { q: "kagi", impl: "scrape" });
    const variants = await Promise.all([
      cacheKey("fastgpt", "kagi", { q: "kagi", impl: "scrape" }),
      cacheKey("search", "searxng", { q: "kagi", impl: "scrape" }),
      cacheKey("search", "kagi", { q: "kagi", impl: "api" }),
      cacheKey("search", "kagi", { q: "kagi", impl: "scrape", limit: 5 }),
      cacheKey("search", "kagi", { q: "Kagi", impl: "scrape" }),
    ]);
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });
});

describe("TTL_SECONDS", () => {
  it("is 24h for search, 6h for fastgpt and 7d for summarize", () => {
    expect(TTL_SECONDS).toEqual({ search: 86_400, fastgpt: 21_600, summarize: 604_800 });
    expect([...CACHE_DOMAINS].sort()).toEqual(["fastgpt", "search", "summarize"]);
  });
});
