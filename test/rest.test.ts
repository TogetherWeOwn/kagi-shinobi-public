// REST handlers for /search and /summarize.
//
// The KagiClient facade is mocked with a factory, which does two things: it
// keeps these tests about rest.ts's own logic (validation, aggregation, error
// mapping) rather than about scraping, and it cuts the import chain before
// src/kagi/scrape/index.ts -> src/token/refresh.ts -> @cloudflare/puppeteer,
// so this suite can stay in the fast Node project.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  KAGI_ERROR_KINDS,
  KagiAuthError,
  KagiBudgetExceededError,
  KagiCaptchaError,
  KagiConfirmRequiredError,
  KagiError,
  type KagiErrorKind,
  KagiNotConfiguredError,
  KagiMarkupChangedError,
  KagiParseError,
  KagiRateLimitError,
  KagiTimeoutError,
  KagiUnsupportedInModeError,
  KagiUpstreamError,
} from "../src/kagi/errors";
import { KAGI_ERROR_STATUS, restErrorCode } from "../src/kagi/http";
import { resolveMode } from "../src/kagi/mode";
import { pickImpl } from "../src/kagi/capability";
import type { ErrorBody } from "../src/util/errors";
import { makeEnv } from "./_helpers";

const { createKagiClient } = vi.hoisted(() => ({ createKagiClient: vi.fn() }));
vi.mock("../src/kagi/client.js", () => ({ createKagiClient }));

const { handleSearch, handleSummarize, kagiErrorResponse } = await import("../src/rest");

const SEARCH_RESULT = { query: "q", results: [], mode: "scrape" };

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    mode: "scrape",
    search: vi.fn().mockResolvedValue(SEARCH_RESULT),
    summarize: vi.fn().mockResolvedValue({ summary: "a summary" }),
    ...overrides,
  };
}

function post(body: unknown): Request {
  return new Request("https://worker.test/search", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// Typed sibling of json() for the error envelope, so assertions can reach
// error.detail without widening it back to unknown at every call site.
async function errorBody(res: Response): Promise<ErrorBody> {
  return (await res.json()) as ErrorBody;
}

beforeEach(() => {
  vi.clearAllMocks();
  createKagiClient.mockReturnValue(fakeClient());
});

describe("handleSearch input validation", () => {
  it("rejects a body that is not JSON", async () => {
    const res = await handleSearch(post("{not json"), makeEnv());

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "invalid-json" });
  });

  it("rejects a missing queries field", async () => {
    const res = await handleSearch(post({}), makeEnv());

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "missing-queries" });
  });

  it("rejects an empty queries array", async () => {
    const res = await handleSearch(post({ queries: [] }), makeEnv());

    expect((await json(res)).error).toMatchObject({ code: "missing-queries" });
  });

  it("rejects a queries value that is not an array", async () => {
    const res = await handleSearch(post({ queries: "not an array" }), makeEnv());

    expect((await json(res)).error).toMatchObject({ code: "missing-queries" });
  });

  it("rejects a non-string entry inside queries", async () => {
    const res = await handleSearch(post({ queries: ["ok", 42] }), makeEnv());

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "invalid-query" });
  });

  it("rejects a whitespace-only query", async () => {
    const res = await handleSearch(post({ queries: ["   "] }), makeEnv());

    expect((await json(res)).error).toMatchObject({ code: "invalid-query" });
  });

  it("trims queries before dispatching them", async () => {
    const client = fakeClient();
    createKagiClient.mockReturnValue(client);

    await handleSearch(post({ queries: ["  spaced  "] }), makeEnv());

    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ q: "spaced" }));
  });

  it.each([
    ["a non-number", "10"],
    ["a fraction", 1.5],
    ["zero", 0],
    ["a negative", -1],
    ["above the maximum", 51],
  ])("rejects %s limit", async (_label, limit) => {
    const res = await handleSearch(post({ queries: ["q"], limit }), makeEnv());

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "invalid-limit" });
  });

  it.each([1, 50])("accepts the boundary limit %i", async (limit) => {
    const client = fakeClient();
    createKagiClient.mockReturnValue(client);

    const res = await handleSearch(post({ queries: ["q"], limit }), makeEnv());

    expect(res.status).toBe(200);
    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ limit }));
  });

  it("defaults the limit to 10 when omitted", async () => {
    const client = fakeClient();
    createKagiClient.mockReturnValue(client);

    await handleSearch(post({ queries: ["q"] }), makeEnv());

    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
  });

  it("rejects an impl that is neither scrape nor api", async () => {
    const res = await handleSearch(post({ queries: ["q"], impl: "hybrid" }), makeEnv());

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "invalid-impl" });
  });

  it.each(["scrape", "api"])("passes impl=%s through", async (impl) => {
    const client = fakeClient();
    createKagiClient.mockReturnValue(client);

    await handleSearch(post({ queries: ["q"], impl }), makeEnv());

    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ impl }));
  });

  it("leaves impl undefined when omitted, so the client picks the mode", async () => {
    const client = fakeClient();
    createKagiClient.mockReturnValue(client);

    await handleSearch(post({ queries: ["q"] }), makeEnv());

    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ impl: undefined }));
  });

  it("rejects an engine outside kagi|searxng|auto", async () => {
    const res = await handleSearch(post({ queries: ["q"], engine: "bing" }), makeEnv());

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "invalid-engine" });
  });

  it.each(["kagi", "searxng", "auto"])("passes engine=%s through", async (engine) => {
    const client = fakeClient();
    createKagiClient.mockReturnValue(client);

    await handleSearch(post({ queries: ["q"], engine }), makeEnv());

    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ engine }));
  });

  it("leaves engine undefined when omitted, so the client defaults to kagi", async () => {
    const client = fakeClient();
    createKagiClient.mockReturnValue(client);

    await handleSearch(post({ queries: ["q"] }), makeEnv());

    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ engine: undefined }));
  });

  it("rejects impl paired with a non-kagi engine", async () => {
    const res = await handleSearch(
      post({ queries: ["q"], impl: "scrape", engine: "auto" }),
      makeEnv(),
    );

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "invalid-impl" });
  });

  // ADR 0017: max_age_s bounds how old a cached result may be; 0 skips it.
  it.each([0, 3600])("passes max_age_s=%i through to the client", async (max_age_s) => {
    const client = fakeClient();
    createKagiClient.mockReturnValue(client);

    await handleSearch(post({ queries: ["q"], max_age_s }), makeEnv());

    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ max_age_s }));
  });

  it.each([-1, 1.5, "60", null])("rejects max_age_s=%j", async (max_age_s) => {
    const res = await handleSearch(post({ queries: ["q"], max_age_s }), makeEnv());

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "invalid-max-age" });
  });

  it("hands the cache's background work to the request's waitUntil", async () => {
    const waitUntil = vi.fn();

    await handleSearch(post({ queries: ["q"] }), makeEnv(), { waitUntil } as never);

    const opts = createKagiClient.mock.calls[0][1] as { waitUntil: (p: Promise<unknown>) => void };
    const work = Promise.resolve();
    opts.waitUntil(work);
    expect(waitUntil).toHaveBeenCalledWith(work);
  });

  it("passes no waitUntil without an execution context", async () => {
    await handleSearch(post({ queries: ["q"] }), makeEnv());

    expect(createKagiClient.mock.calls[0][1]).toEqual({});
  });
});

// One request fans out to one upstream call per query. The per-minute rate
// limit governs requests, not the calls they spawn, so without a ceiling here
// a single authorized request can multiply into an unbounded burst against
// kagi.com — billable in api mode, session-ban bait in scrape mode, and past
// the Workers subrequest cap either way.
describe("handleSearch bounds its fan-out", () => {
  it("accepts a request at the ceiling", async () => {
    const queries = Array.from({ length: 20 }, (_, i) => `q${i}`);

    const res = await handleSearch(post({ queries }), makeEnv());

    expect(res.status).toBe(200);
  });

  it("rejects a request past the ceiling", async () => {
    const queries = Array.from({ length: 21 }, (_, i) => `q${i}`);

    const res = await handleSearch(post({ queries }), makeEnv());

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "too-many-queries" });
  });

  it("names the ceiling so the caller can split the batch", async () => {
    const queries = Array.from({ length: 50 }, (_, i) => `q${i}`);

    const res = await handleSearch(post({ queries }), makeEnv());

    expect((await json(res)).error).toMatchObject({
      message: expect.stringContaining("20"),
    });
  });

  it("refuses before building a client or touching the network", async () => {
    const client = fakeClient();
    createKagiClient.mockReturnValue(client);
    const queries = Array.from({ length: 100 }, (_, i) => `q${i}`);

    await handleSearch(post({ queries }), makeEnv());

    expect(client.search).not.toHaveBeenCalled();
  });
});

describe("handleSearch dispatch", () => {
  it("maps a client construction failure onto its Kagi error response", async () => {
    createKagiClient.mockImplementation(() => {
      throw new KagiNotConfiguredError("no token");
    });

    const res = await handleSearch(post({ queries: ["q"] }), makeEnv());

    expect(res.status).toBe(503);
    expect((await json(res)).error).toMatchObject({ code: "kagi-not-configured" });
  });

  it("returns one result per query, in order, with the client's mode", async () => {
    createKagiClient.mockReturnValue(fakeClient({ mode: "api" }));

    const res = await handleSearch(post({ queries: ["first", "second"] }), makeEnv());
    const body = await json(res);

    expect(body.mode).toBe("api");
    expect(body.results).toHaveLength(2);
    expect(body.results).toMatchObject([
      { query: "first", ok: true },
      { query: "second", ok: true },
    ]);
  });

  // Promise.allSettled, not Promise.all: one bad query must not sink the batch.
  it("reports a per-query failure without failing the whole request", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce(SEARCH_RESULT)
      .mockRejectedValueOnce(new KagiUpstreamError(500, "Server Error"));
    createKagiClient.mockReturnValue(fakeClient({ search }));

    const res = await handleSearch(post({ queries: ["good", "bad"] }), makeEnv());
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.results).toMatchObject([{ query: "good", ok: true }, { query: "bad", ok: false }]);
    // Typed KagiError vocabulary stays visible per ADR 0012; only untyped
    // error text is genericized.
    expect((body.results as Array<{ error: string }>)[1].error).toContain(
      "HTTP 500: Server Error",
    );
  });

  it("does not echo a non-Error rejection reason to the client", async () => {
    createKagiClient.mockReturnValue(
      fakeClient({ search: vi.fn().mockRejectedValue("synthetic-secret-marker-7f3a") }),
    );

    const res = await handleSearch(post({ queries: ["q"] }), makeEnv());
    const body = await json(res);
    const [first] = body.results as Array<{ error: string }>;

    expect(first.error).toBe("Internal error");
    expect(JSON.stringify(body)).not.toContain("synthetic-secret-marker-7f3a");
  });

  it("does not echo an untyped Error's message, path or stack text per query", async () => {
    const marker = "synthetic-secret-marker-7f3a";
    const err = new Error(`upstream blew up ${marker} at /private/synthetic-marker-path`);
    err.stack = `Error: ${marker}\n    at somewhere (/private/synthetic-marker-path:1:2)`;
    createKagiClient.mockReturnValue(fakeClient({ search: vi.fn().mockRejectedValue(err) }));

    const res = await handleSearch(post({ queries: ["q"] }), makeEnv());
    const body = await json(res);
    const [first] = body.results as Array<{ error: string }>;

    expect(first.error).toBe("Internal error");
    expect(JSON.stringify(body)).not.toContain(marker);
    expect(JSON.stringify(body)).not.toContain("/private/synthetic-marker-path");
  });

  it("times out a query that never settles", async () => {
    vi.useFakeTimers();
    try {
      createKagiClient.mockReturnValue(fakeClient({ search: vi.fn(() => new Promise(() => {})) }));

      const pending = handleSearch(post({ queries: ["hangs"] }), makeEnv());
      await vi.advanceTimersByTimeAsync(15_000);
      const body = await json(await pending);

      expect(body.results).toMatchObject([{ query: "hangs", ok: false }]);
      expect((body.results as Array<{ error: string }>)[0].error).toMatch(/Timeout after 15000ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  // First-run experience: a deploy with no Kagi credentials (mode auto) must
  // get the actionable not_configured answer, not a generic 500. The real
  // resolveMode throw is driven through the handler via the client factory.
  it("surfaces missing credentials as 503 kagi-not-configured, not 500 internal", async () => {
    createKagiClient.mockImplementation((env: never) => {
      resolveMode(env);
      return fakeClient();
    });

    const res = await handleSearch(post({ queries: ["q"] }), makeEnv({ KAGI_MODE: "auto" }));

    expect(res.status).toBe(503);
    expect((await json(res)).error).toMatchObject({
      code: "kagi-not-configured",
      message: expect.stringMatching(/KAGI_SESSION_TOKEN|KAGI_API_KEY/),
    });
  });

  it("surfaces an invalid KAGI_MODE as 503 kagi-not-configured", async () => {
    createKagiClient.mockImplementation((env: never) => {
      resolveMode(env);
      return fakeClient();
    });

    const res = await handleSearch(post({ queries: ["q"] }), makeEnv({ KAGI_MODE: "yolo" }));

    expect(res.status).toBe(503);
    expect((await json(res)).error).toMatchObject({
      code: "kagi-not-configured",
      message: expect.stringMatching(/Invalid KAGI_MODE/),
    });
  });
});

describe("handleSummarize input validation", () => {
  it("rejects a body that is not JSON", async () => {
    const res = await handleSummarize(post("{nope"), makeEnv());

    expect((await json(res)).error).toMatchObject({ code: "invalid-json" });
  });

  it.each([
    ["missing", {}],
    ["a non-string", { url: 42 }],
    ["whitespace-only", { url: "   " }],
  ])("rejects %s url", async (_label, body) => {
    const res = await handleSummarize(post(body), makeEnv());

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "missing-url" });
  });

  it("rejects an unknown summary_type", async () => {
    const res = await handleSummarize(
      post({ url: "https://example.test", summary_type: "essay" }),
      makeEnv(),
    );

    expect((await json(res)).error).toMatchObject({ code: "invalid-summary-type" });
  });

  it.each(["summary", "takeaway"])("accepts summary_type=%s", async (summary_type) => {
    const client = fakeClient();
    createKagiClient.mockReturnValue(client);

    await handleSummarize(post({ url: "https://example.test", summary_type }), makeEnv());

    expect(client.summarize).toHaveBeenCalledWith(
      expect.objectContaining({ style: summary_type }),
    );
  });

  it("defaults summary_type to summary", async () => {
    const client = fakeClient();
    createKagiClient.mockReturnValue(client);

    await handleSummarize(post({ url: "https://example.test" }), makeEnv());

    expect(client.summarize).toHaveBeenCalledWith(expect.objectContaining({ style: "summary" }));
  });

  it("rejects an unsupported target_language", async () => {
    const res = await handleSummarize(
      post({ url: "https://example.test", target_language: "XX" }),
      makeEnv(),
    );

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "invalid-language" });
  });

  it("rejects a non-string target_language", async () => {
    const res = await handleSummarize(
      post({ url: "https://example.test", target_language: 7 }),
      makeEnv(),
    );

    expect((await json(res)).error).toMatchObject({ code: "invalid-language" });
  });

  it("defaults the language to EN", async () => {
    const client = fakeClient();
    createKagiClient.mockReturnValue(client);

    await handleSummarize(post({ url: "https://example.test" }), makeEnv());

    expect(client.summarize).toHaveBeenCalledWith(expect.objectContaining({ language: "EN" }));
  });

  it("rejects an impl that is neither scrape nor api", async () => {
    const res = await handleSummarize(
      post({ url: "https://example.test", impl: "both" }),
      makeEnv(),
    );

    expect((await json(res)).error).toMatchObject({ code: "invalid-impl" });
  });

  it("passes max_age_s through to the client", async () => {
    const client = fakeClient();
    createKagiClient.mockReturnValue(client);

    await handleSummarize(post({ url: "https://example.test", max_age_s: 0 }), makeEnv(), {
      waitUntil: vi.fn(),
    } as never);

    expect(client.summarize).toHaveBeenCalledWith(expect.objectContaining({ max_age_s: 0 }));
  });

  it("rejects a negative max_age_s", async () => {
    const res = await handleSummarize(
      post({ url: "https://example.test", max_age_s: -5 }),
      makeEnv(),
    );

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: "invalid-max-age" });
  });
});

describe("handleSummarize dispatch", () => {
  it("maps a client construction failure onto its Kagi error response", async () => {
    createKagiClient.mockImplementation(() => {
      throw new KagiNotConfiguredError("no token");
    });

    const res = await handleSummarize(post({ url: "https://example.test" }), makeEnv());

    expect(res.status).toBe(503);
  });

  it("returns the summary with the client's mode", async () => {
    createKagiClient.mockReturnValue(fakeClient({ mode: "api" }));

    const res = await handleSummarize(post({ url: "https://example.test" }), makeEnv());
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, mode: "api", data: { summary: "a summary" } });
  });

  it("maps an error thrown during summarize", async () => {
    createKagiClient.mockReturnValue(
      fakeClient({ summarize: vi.fn().mockRejectedValue(new KagiAuthError()) }),
    );

    const res = await handleSummarize(post({ url: "https://example.test" }), makeEnv());

    expect(res.status).toBe(401);
    expect((await json(res)).error).toMatchObject({ code: "kagi-auth" });
  });

  // impl='api' against a scrape-mode deploy is a caller-fixable input error:
  // the real pickImpl throw must reach the client as a typed 400, not a 500.
  it("surfaces an incompatible impl override as a typed 400", async () => {
    createKagiClient.mockReturnValue(
      fakeClient({
        summarize: vi.fn().mockImplementation(async () => {
          pickImpl("kagi_summarize_url", "scrape", "api");
        }),
      }),
    );

    const res = await handleSummarize(
      post({ url: "https://example.test", impl: "api" }),
      makeEnv(),
    );
    const body = await json(res);

    expect(res.status).toBe(400);
    expect(body.error).toMatchObject({
      code: expect.stringMatching(/^kagi-/),
      message: expect.stringMatching(/impl|mode='scrape'/),
    });
    expect(body.error).not.toMatchObject({ code: "internal" });
  });

  it("does not echo an untyped summarize error's marker text", async () => {
    createKagiClient.mockReturnValue(
      fakeClient({
        summarize: vi
          .fn()
          .mockRejectedValue(new Error("synthetic-secret-marker-7f3a /private/synthetic-path")),
      }),
    );

    const res = await handleSummarize(post({ url: "https://example.test" }), makeEnv());
    const body = await json(res);

    expect(res.status).toBe(500);
    expect(body.error).toMatchObject({ code: "internal", message: "Internal error" });
    expect(JSON.stringify(body)).not.toContain("synthetic-secret-marker-7f3a");
  });

  it("passes the url through as a url-kind reference", async () => {
    const client = fakeClient();
    createKagiClient.mockReturnValue(client);

    await handleSummarize(post({ url: "https://example.test/article" }), makeEnv());

    expect(client.summarize).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "url", ref: "https://example.test/article" }),
    );
  });
});

// The status codes here are the REST contract. A caller distinguishes "your
// request was wrong" (4xx) from "Kagi is broken" (5xx) from "you are out of
// budget" (402) purely by this mapping.
//
// Per ADR 0012 both the status and the code are functions of `kind` alone. The
// subclass a caller happens to throw is irrelevant, and the pair below proves
// it: every typed subclass must agree with the bare base class carrying the
// same kind. That equivalence is what was broken before — `KagiUpstreamError`
// returned 502 while `new KagiError("upstream", ...)` returned 500.
describe("kagiErrorResponse", () => {
  it.each([
    [new KagiNotConfiguredError("nope"), 503, "kagi-not-configured"],
    [new KagiAuthError(), 401, "kagi-auth"],
    [new KagiConfirmRequiredError("confirm first"), 400, "kagi-confirm-required"],
    [new KagiUnsupportedInModeError("kagi_enrich", "scrape"), 400, "kagi-unsupported-in-mode"],
    [new KagiBudgetExceededError(100, 50), 402, "kagi-budget-exceeded"],
    [new KagiRateLimitError(30), 429, "kagi-rate-limit"],
    [new KagiParseError("no results block"), 502, "kagi-parse"],
    [new KagiMarkupChangedError("selectors renamed"), 502, "kagi-markup-changed"],
    [new KagiUpstreamError(503, "Unavailable"), 502, "kagi-upstream"],
    [new KagiCaptchaError(), 503, "kagi-captcha"],
    [new KagiTimeoutError(15_000), 504, "kagi-timeout"],
  ])("maps %s", async (err, status, code) => {
    const res = kagiErrorResponse(err);

    expect(res.status).toBe(status);
    expect((await json(res)).error).toMatchObject({ code });
  });

  it.each([...KAGI_ERROR_KINDS])(
    "gives the bare base class the same status and code as kind %s",
    async (kind) => {
      const res = kagiErrorResponse(new KagiError(kind, "raw base class"));

      expect(res.status).toBe(KAGI_ERROR_STATUS[kind]);
      expect((await json(res)).error).toMatchObject({ code: restErrorCode(kind) });
    },
  );

  // The information REST used to drop on the floor. `detail` is what an MCP
  // caller has always received; a REST caller now gets the same fields.
  it("carries retry_after into the body and the Retry-After header", async () => {
    const res = kagiErrorResponse(new KagiRateLimitError(30));

    expect(res.headers.get("Retry-After")).toBe("30");
    expect((await errorBody(res)).error.detail).toEqual({ retry_after: 30 });
  });

  it("carries the budget numbers a caller needs to explain the 402", async () => {
    const res = kagiErrorResponse(new KagiBudgetExceededError(100, 50));

    expect((await errorBody(res)).error.detail).toEqual({ spent_cents: 100, cap_cents: 50 });
  });

  it("carries the upstream status through", async () => {
    const res = kagiErrorResponse(new KagiUpstreamError(503, "Unavailable"));

    expect((await errorBody(res)).error.detail).toEqual({
      status: 503,
      status_text: "Unavailable",
    });
  });

  // Responses that never had detail must stay byte-identical, so an empty bag
  // is omitted rather than serialized as `"detail":{}`.
  it("omits detail entirely when the error carries none", async () => {
    const body = await errorBody(kagiErrorResponse(new KagiAuthError()));

    expect(body.error).not.toHaveProperty("detail");
    expect(body).toEqual({ error: { code: "kagi-auth", message: expect.any(String) } });
  });

  it("sets no Retry-After on an error that carries no retry_after", async () => {
    expect(kagiErrorResponse(new KagiAuthError()).headers.get("Retry-After")).toBeNull();
  });

  // Fail-closed guard. A kind with no table entry is a typecheck error, so this
  // can only happen past the type system — a cast, a JS caller, a value off the
  // wire. It matters because the failure is silent and inverted: Response
  // treats `status: undefined` as 200, so an unmapped kind would answer an
  // error with a success status. The cast below is the point of the test.
  it("answers an unmapped kind with 500 rather than defaulting to 200", async () => {
    const res = kagiErrorResponse(new KagiError("bogus" as KagiErrorKind, "off the map"));

    expect(res.status).toBe(500);
    expect((await json(res)).error).toMatchObject({ code: "kagi-bogus" });
  });

  it("maps a plain Error to a generic 500 without echoing its message", async () => {
    const res = kagiErrorResponse(new Error("something snapped"));

    expect(res.status).toBe(500);
    expect((await json(res)).error).toMatchObject({
      code: "internal",
      message: "Internal error",
    });
  });

  it("maps a thrown non-Error to a generic 500", async () => {
    const res = kagiErrorResponse("just a string");

    expect(res.status).toBe(500);
    expect((await json(res)).error).toMatchObject({ code: "internal", message: "Internal error" });
  });
});
