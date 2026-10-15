// KagiApiImpl — the class that fans the facade out to the per-endpoint
// modules. dispatcher*.test.ts stubs these methods to watch routing, so this
// file is the only place their bodies actually run: the requireConfigured
// guard on every method, the arg reshaping search does, and the
// include/exclude → personalizations mapping.

import { afterEach, describe, expect, it } from "vitest";
import { KagiApiImpl } from "../../../src/kagi/api/index";
import { KagiNotConfiguredError } from "../../../src/kagi/errors";
import { fakeFetch, makeEnv, restoreFetch, stubFetch } from "../../_helpers";

afterEach(() => {
  restoreFetch();
});

const CAPACIOUS = { MAX_API_CENTS_PER_MONTH: "10000", KAGI_API_KEY: "k" };

const SEARCH_ENVELOPE = {
  meta: { trace: "TR" },
  data: { search: [{ url: "https://a.example/", title: "A", snippet: "s" }] },
};

function impl(overrides: Record<string, string> = {}) {
  return new KagiApiImpl(makeEnv({ ...CAPACIOUS, ...overrides }));
}

/** Capture the URL and JSON body of the request the method under test makes. */
function captureBody(envelope: unknown = SEARCH_ENVELOPE) {
  const seen: { url?: string; body?: Record<string, unknown> } = {};
  stubFetch(async (input, init) => {
    seen.url = String(input);
    seen.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return fakeFetch(envelope)(input, init);
  });
  return seen;
}

describe("isConfigured", () => {
  it("is true when KAGI_API_KEY is set", () => {
    expect(impl().isConfigured()).toBe(true);
  });

  it("is false when KAGI_API_KEY is absent", () => {
    expect(new KagiApiImpl(makeEnv()).isConfigured()).toBe(false);
  });
});

describe("every method refuses when KAGI_API_KEY is unset", () => {
  const unconfigured = () => new KagiApiImpl(makeEnv({ MAX_API_CENTS_PER_MONTH: "10000" }));

  const calls: Array<[string, (i: KagiApiImpl) => Promise<unknown>]> = [
    ["search", (i) => i.search({ q: "x" })],
    [
      "summarize",
      (i) => i.summarize({ kind: "url", ref: "https://x", language: "EN", style: "summary" }),
    ],
    ["extract", (i) => i.extract({ urls: ["https://x"] })],
    ["fastGPT", (i) => i.fastGPT({ query: "x" })],
    ["enrichWeb", (i) => i.enrichWeb({ q: "x" })],
    ["enrichNews", (i) => i.enrichNews({ q: "x" })],
    ["smallWeb", (i) => i.smallWeb({ q: "x" })],
    ["rank", (i) => i.rank({ urls: ["https://x"], q: "x" })],
  ];

  for (const [name, call] of calls) {
    it(`${name} throws KagiNotConfiguredError`, async () => {
      await expect(call(unconfigured())).rejects.toBeInstanceOf(KagiNotConfiguredError);
    });
  }
});

describe("search argument reshaping", () => {
  it("renames q to query and forwards the plain options", async () => {
    const seen = captureBody();

    await impl().search({
      q: "widgets",
      limit: 7,
      lens_id: "lens-1",
      workflow: "news",
      safe_search: true,
    });

    expect(seen.url).toBe("https://kagi.com/api/v1/search");
    expect(seen.body).toMatchObject({
      query: "widgets",
      limit: 7,
      lens_id: "lens-1",
      workflow: "news",
      safe_search: true,
    });
  });

  it("maps date_range.from/to onto filters.after/before", async () => {
    const seen = captureBody();

    await impl().search({
      q: "x",
      date_range: { from: "2026-01-01", to: "2026-06-30" },
    });

    expect(seen.body?.filters).toEqual({ after: "2026-01-01", before: "2026-06-30" });
  });

  it("sends filters when only `from` is present", async () => {
    const seen = captureBody();

    await impl().search({ q: "x", date_range: { from: "2026-01-01" } });

    expect(seen.body?.filters).toEqual({ after: "2026-01-01" });
  });

  it("omits filters entirely when date_range is empty", async () => {
    const seen = captureBody();

    await impl().search({ q: "x", date_range: {} });

    expect(seen.body?.filters).toBeUndefined();
  });

  it("omits filters when date_range is absent", async () => {
    const seen = captureBody();

    await impl().search({ q: "x" });

    expect(seen.body?.filters).toBeUndefined();
  });
});

describe("include/exclude domains become personalizations", () => {
  it("raises included domains", async () => {
    const seen = captureBody();

    await impl().search({ q: "x", include_domains: ["good.example"] });

    expect(seen.body?.personalizations).toEqual({
      domains: [{ domain: "good.example", kind: "raise" }],
    });
  });

  it("blocks excluded domains", async () => {
    const seen = captureBody();

    await impl().search({ q: "x", exclude_domains: ["bad.example"] });

    expect(seen.body?.personalizations).toEqual({
      domains: [{ domain: "bad.example", kind: "block" }],
    });
  });

  it("keeps includes before excludes when both are given", async () => {
    const seen = captureBody();

    await impl().search({
      q: "x",
      include_domains: ["good.example"],
      exclude_domains: ["bad.example"],
    });

    expect(seen.body?.personalizations).toEqual({
      domains: [
        { domain: "good.example", kind: "raise" },
        { domain: "bad.example", kind: "block" },
      ],
    });
  });

  it("omits personalizations when both lists are empty", async () => {
    const seen = captureBody();

    await impl().search({ q: "x", include_domains: [], exclude_domains: [] });

    expect(seen.body?.personalizations).toBeUndefined();
  });

  it("omits personalizations when neither list is supplied", async () => {
    const seen = captureBody();

    await impl().search({ q: "x" });

    expect(seen.body?.personalizations).toBeUndefined();
  });
});

describe("delegation to the endpoint modules", () => {
  it("summarize reaches the summarize endpoint", async () => {
    const seen = captureBody({ meta: {}, data: { output: "OK", tokens: 3 } });

    const resp = await impl().summarize({
      kind: "url",
      ref: "https://x.example",
      language: "EN",
      style: "summary",
    });

    expect(seen.url).toContain("summarize");
    expect(resp.summary).toBe("OK");
  });

  it("extract reaches the extract endpoint", async () => {
    const seen = captureBody({
      meta: {},
      data: { pages: [{ url: "https://x", content: "# hi" }] },
    });

    const resp = await impl().extract({ urls: ["https://x"] });

    expect(seen.url).toContain("extract");
    expect(resp.pages).toHaveLength(1);
  });

  it("fastGPT reaches the fastgpt endpoint", async () => {
    const seen = captureBody({ meta: {}, data: { output: "answer", tokens: 1 } });

    const resp = await impl().fastGPT({ query: "why", cache: true });

    expect(seen.url).toContain("fastgpt");
    expect(resp.answer).toBe("answer");
  });

  it("enrichWeb reaches the teclis index", async () => {
    captureBody({ meta: {}, data: [] });

    const resp = await impl().enrichWeb({ q: "hi" });

    expect(resp.index).toBe("teclis");
  });

  it("enrichNews reaches the tinygem index", async () => {
    captureBody({ meta: {}, data: [] });

    const resp = await impl().enrichNews({ q: "hi" });

    expect(resp.index).toBe("tinygem");
  });

  it("smallWeb lifts the interesting_finds bucket", async () => {
    captureBody({
      meta: {},
      data: {
        search: [],
        interesting_finds: [{ url: "https://blog.example/", title: "B", snippet: "s" }],
      },
    });

    const resp = await impl().smallWeb({ q: "handmade" });

    expect(resp.results).toHaveLength(1);
    expect(resp.results[0].url).toBe("https://blog.example/");
  });

  it("rank scores against a personalized search", async () => {
    captureBody();

    const resp = await impl().rank({ urls: ["https://a.example/"], q: "widgets" });

    expect(resp.ranked[0]).toMatchObject({ url: "https://a.example/", action: "pin" });
  });
});
