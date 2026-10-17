// apiRank and apiSmallWeb — the two API endpoints that are compositions over
// /v1/search rather than endpoints of their own. Both are tested through a
// stubbed fetch so the scoring maths and bucket-lifting are visible.

import { afterEach, describe, expect, it } from "vitest";
import { apiRank } from "../../../src/kagi/api/rank";
import { apiSmallWeb } from "../../../src/kagi/api/smallweb";
import { KagiError } from "../../../src/kagi/errors";
import { fakeFetch, makeEnv, restoreFetch, stubFetch } from "../../_helpers";

afterEach(() => {
  restoreFetch();
});

const CAPACIOUS = { MAX_API_CENTS_PER_MONTH: "10000", KAGI_API_KEY: "k" };

/** /v1/search envelope with the given result URLs, in rank order. */
function searchEnvelope(urls: string[], interesting: string[] = []) {
  return {
    meta: { trace: "TR-rank" },
    data: {
      search: urls.map((url, i) => ({
        url,
        title: `T${i}`,
        snippet: `s${i}`,
      })),
      interesting_finds: interesting.map((url, i) => ({
        url,
        title: `SW${i}`,
        snippet: "small web",
      })),
    },
  };
}

describe("apiRank", () => {
  it("requires a query", async () => {
    const env = makeEnv(CAPACIOUS);

    await expect(apiRank(env, { urls: ["https://a"], q: "" })).rejects.toBeInstanceOf(
      KagiError,
    );
  });

  it("scores a URL by where it lands in the personalized results", async () => {
    stubFetch(fakeFetch(searchEnvelope(["https://a.example/x", "https://b.example/y"])));
    const env = makeEnv(CAPACIOUS);

    const resp = await apiRank(env, {
      urls: ["https://a.example/x", "https://b.example/y"],
      q: "widgets",
    });

    expect(resp.query).toBe("widgets");
    // rank 1 of a 2-result cap → 1 - 0/2 = 1.0
    expect(resp.ranked[0]).toMatchObject({
      url: "https://a.example/x",
      score: 1,
      action: "pin",
      rationale: "rank 1/2",
    });
    // rank 2 of 2 → 1 - 1/2 = 0.5 → "raise"
    expect(resp.ranked[1]).toMatchObject({
      url: "https://b.example/y",
      score: 0.5,
      action: "raise",
      rationale: "rank 2/2",
    });
  });

  it("blocks a URL that never appears in the results", async () => {
    stubFetch(fakeFetch(searchEnvelope(["https://other.example/z"])));
    const env = makeEnv(CAPACIOUS);

    const resp = await apiRank(env, { urls: ["https://missing.example/q"], q: "widgets" });

    expect(resp.ranked[0]).toEqual({
      url: "https://missing.example/q",
      score: 0,
      action: "block",
      rationale: "no appearance in personalized results",
    });
  });

  it("marks a deeply-ranked URL neutral", async () => {
    // 10 results; the target is 8th → 1 - 7/10 = 0.3 → neutral
    const urls = Array.from({ length: 10 }, (_, i) => `https://r${i}.example/`);
    stubFetch(fakeFetch(searchEnvelope(urls)));
    const env = makeEnv(CAPACIOUS);

    const resp = await apiRank(env, { urls: [urls[7]], q: "widgets" });

    expect(resp.ranked[0].score).toBeCloseTo(0.3);
    expect(resp.ranked[0].action).toBe("neutral");
  });

  it("forwards domain rules as personalizations", async () => {
    const seen: { body?: string } = {};
    stubFetch(async (input, init) => {
      seen.body = typeof init?.body === "string" ? init.body : undefined;
      return fakeFetch(searchEnvelope(["https://a"]))(input, init);
    });
    const env = makeEnv(CAPACIOUS);

    await apiRank(env, {
      urls: ["https://a"],
      q: "widgets",
      rules: [
        { domain: "good.example", action: "raise" },
        { domain: "bad.example", action: "block" },
      ],
    });

    const body = JSON.parse(seen.body as string);
    expect(body.personalizations.domains).toEqual([
      { domain: "good.example", kind: "raise" },
      { domain: "bad.example", kind: "block" },
    ]);
    expect(body.personalizations.regexes).toEqual([]);
  });

  it("forwards regex rules as personalizations", async () => {
    const seen: { body?: string } = {};
    stubFetch(async (input, init) => {
      seen.body = typeof init?.body === "string" ? init.body : undefined;
      return fakeFetch(searchEnvelope(["https://a"]))(input, init);
    });
    const env = makeEnv(CAPACIOUS);

    await apiRank(env, {
      urls: ["https://a"],
      q: "widgets",
      rules: [{ regex: "^https://spam\\.", action: "block" }],
    });

    const body = JSON.parse(seen.body as string);
    expect(body.personalizations.regexes).toEqual([{ regex: "^https://spam\\." }]);
    expect(body.personalizations.domains).toEqual([]);
  });

  it("omits personalizations entirely when no rules are supplied", async () => {
    const seen: { body?: string } = {};
    stubFetch(async (input, init) => {
      seen.body = typeof init?.body === "string" ? init.body : undefined;
      return fakeFetch(searchEnvelope(["https://a"]))(input, init);
    });
    const env = makeEnv(CAPACIOUS);

    await apiRank(env, { urls: ["https://a"], q: "widgets" });

    expect(JSON.parse(seen.body as string).personalizations).toBeUndefined();
  });

  it("defaults the search limit to 20 and honors an override", async () => {
    const limits: number[] = [];
    stubFetch(async (input, init) => {
      limits.push(JSON.parse(String(init?.body)).limit);
      return fakeFetch(searchEnvelope(["https://a"]))(input, init);
    });
    const env = makeEnv(CAPACIOUS);

    await apiRank(env, { urls: ["https://a"], q: "q" });
    await apiRank(env, { urls: ["https://a"], q: "q", limit: 5 });

    expect(limits).toEqual([20, 5]);
  });

  it("survives an empty result set without dividing by zero", async () => {
    stubFetch(fakeFetch(searchEnvelope([])));
    const env = makeEnv(CAPACIOUS);

    const resp = await apiRank(env, { urls: ["https://a"], q: "q" });

    expect(resp.ranked[0].score).toBe(0);
    expect(resp.ranked[0].action).toBe("block");
  });

  it("passes the search meta through", async () => {
    stubFetch(fakeFetch(searchEnvelope(["https://a"])));
    const env = makeEnv(CAPACIOUS);

    const resp = await apiRank(env, { urls: ["https://a"], q: "q" });

    expect(resp.meta.impl).toBe("api");
    expect(resp.meta.trace_id).toBe("TR-rank");
  });
});

describe("apiSmallWeb", () => {
  it("lifts the small_web bucket into the primary results", async () => {
    stubFetch(
      fakeFetch(searchEnvelope(["https://mainstream.example/"], ["https://blog.example/"])),
    );
    const env = makeEnv(CAPACIOUS);

    const resp = await apiSmallWeb(env, { q: "handmade" });

    expect(resp.query).toBe("handmade");
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0].url).toBe("https://blog.example/");
    // The full search buckets stay available for callers that want both.
    expect(resp.buckets?.small_web).toHaveLength(1);
  });

  it("uses a broad seed query when q is omitted", async () => {
    const seen: { body?: string } = {};
    stubFetch(async (input, init) => {
      seen.body = typeof init?.body === "string" ? init.body : undefined;
      return fakeFetch(searchEnvelope([], ["https://blog.example/"]))(input, init);
    });
    const env = makeEnv(CAPACIOUS);

    const resp = await apiSmallWeb(env, {});

    expect(JSON.parse(seen.body as string).query).toBe("smallweb recent");
    expect(resp.query).toBe("smallweb recent");
  });

  it("returns an empty result list when the bucket is absent", async () => {
    stubFetch(fakeFetch({ meta: {}, data: { search: [] } }));
    const env = makeEnv(CAPACIOUS);

    const resp = await apiSmallWeb(env, { q: "x" });

    expect(resp.results).toEqual([]);
  });

  it("forwards the limit to the underlying search", async () => {
    const seen: { body?: string } = {};
    stubFetch(async (input, init) => {
      seen.body = typeof init?.body === "string" ? init.body : undefined;
      return fakeFetch(searchEnvelope([]))(input, init);
    });
    const env = makeEnv(CAPACIOUS);

    await apiSmallWeb(env, { q: "x", limit: 3 });

    expect(JSON.parse(seen.body as string).limit).toBe(3);
  });
});
