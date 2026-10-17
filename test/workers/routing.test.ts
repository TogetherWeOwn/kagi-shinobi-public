// Worker routing, in workerd.
//
// This is the file that proves the public/gated split in src/index.ts is
// what CLAUDE.md claims: "every non-/health path requires a bearer:
// ADMIN_TOKEN everywhere, or a scoped CLIENT_KEYS key on /search and /mcp
// only" (ADR 0013). Unit tests on requireBearer alone cannot prove that — they show
// the gate works, not that it is actually *wired in front of* each route.
//
// Runs under @cloudflare/vitest-pool-workers because src/index.ts imports
// src/research/run.ts, which imports `cloudflare:workers`.

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";

const TOKEN = "test-admin-token";

/** Env with a known ADMIN_TOKEN and rate limiting disabled unless asked for. */
function testEnv(overrides: Record<string, unknown> = {}) {
  return { ...env, ADMIN_TOKEN: TOKEN, PER_BEARER_RPM: "0", ...overrides } as typeof env;
}

async function call(
  path: string,
  init: RequestInit = {},
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  const request = new Request(`https://worker.test${path}`, init);
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, testEnv(overrides), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("public routes", () => {
  it("GET / serves the landing page without a bearer", async () => {
    const res = await call("/");
    expect(res.status).toBe(200);
  });

  it("GET /health responds without a bearer", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
  });
});

// /health is reachable by anyone on the internet, so its unauthenticated body
// must be a liveness signal and nothing more. Token presence, staleness, the
// last-refresh timestamp, which mechanism produced the token, and the deployed
// build SHA all describe the operator's deployment and belong behind the bearer.
describe("GET /health withholds token state from unauthenticated callers", () => {
  const DETAIL_KEYS = ["token", "updatedAt", "source", "autoRefresh", "buildSha"] as const;

  it("returns only a liveness flag with no bearer", async () => {
    const res = await call("/health");
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("returns only a liveness flag when the bearer is wrong", async () => {
    const res = await call("/health", { headers: { Authorization: "Bearer not-the-token" } });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    for (const key of DETAIL_KEYS) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("returns full token status to an authenticated caller", async () => {
    const res = await call("/health", { headers: auth });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    for (const key of DETAIL_KEYS) {
      expect(body).toHaveProperty(key);
    }
    expect(["ok", "stale", "missing"]).toContain(body.token);
  });

  it("echoes the BUILD_SHA var so a deploy can be matched to its commit", async () => {
    const res = await call("/health", { headers: auth }, { BUILD_SHA: "abc1234" });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.buildSha).toBe("abc1234");
  });

  it("defaults buildSha to dev when BUILD_SHA is unset", async () => {
    const res = await call("/health", { headers: auth });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.buildSha).toBe("dev");
  });
});

describe("the bearer gate is wired in front of every other route", () => {
  const gated: ReadonlyArray<[string, string]> = [
    ["POST", "/search"],
    ["POST", "/summarize"],
    ["POST", "/admin/token"],
    ["POST", "/admin/refresh"],
    ["GET", "/definitely-not-a-route"],
  ];

  it.each(gated)("%s %s is 401 without a bearer", async (method, path) => {
    const res = await call(path, { method });
    expect(res.status).toBe(401);
  });

  it.each(gated)("%s %s is 401 with a wrong bearer", async (method, path) => {
    const res = await call(path, { method, headers: { Authorization: "Bearer wrong" } });
    expect(res.status).toBe(401);
  });

  // The tests above prove each route is *gated*; they stop at the 401 and so
  // never execute the dispatch line itself. These authenticate through, and
  // assert only that the request reached a handler — what each handler then
  // does is pinned by test/rest.test.ts and test/token/admin.test.ts.
  it.each([
    ["POST", "/summarize"],
    ["POST", "/admin/refresh"],
    ["POST", "/search"],
    ["POST", "/admin/token"],
  ])("%s %s dispatches to its handler once authenticated", async (method, path) => {
    const res = await call(path, {
      method,
      headers: { ...auth, "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it("routes /mcp to the MCP agent rather than falling through to 404", async () => {
    const res = await call("/mcp", { method: "GET", headers: auth });

    expect(res.status).not.toBe(404);
  });

  it("routes a nested /mcp/ path to the same agent", async () => {
    // The agent answers 404 for a sub-path it does not serve, so status alone
    // cannot tell "handed to the agent" from "fell through the route table".
    // The worker's own miss is a jsonError envelope with code=not-found.
    const res = await call("/mcp/message", { method: "GET", headers: auth });
    const body = await res.text();

    expect(body).not.toContain("not-found");
    expect(body).not.toContain("not routed");
  });

  it("an unmatched path returns 404 once authenticated, not 401", async () => {
    // Proves the 401s above come from the gate rather than from the route
    // table simply not matching.
    const res = await call("/definitely-not-a-route", { method: "GET", headers: auth });
    expect(res.status).toBe(404);
  });

  it("the 404 body carries the stable not-found code", async () => {
    const res = await call("/nope", { method: "GET", headers: auth });
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not-found");
  });
});

describe("method routing", () => {
  // ADR 0013 deliberately added GET /search (the SearXNG json_engine view);
  // until then this asserted 404. Other verbs are still unrouted.
  it("PUT /search is 404 — only GET and POST are routed", async () => {
    const res = await call("/search", { method: "PUT", headers: auth });
    expect(res.status).toBe(404);
  });

  it("POST / is 404 — the landing page is GET-only", async () => {
    const res = await call("/", { method: "POST", headers: auth });
    expect(res.status).toBe(404);
  });
});

describe("rate limiting", () => {
  // Counters live in KV keyed by sha256(bearer):epoch-minute and outlive an
  // individual test, so each case below uses its own bearer. Sharing one
  // would make these tests order-dependent.
  async function callAs(
    token: string,
    path: string,
    overrides: Record<string, unknown>,
  ): Promise<Response> {
    const request = new Request(`https://worker.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, testEnv({ ADMIN_TOKEN: token, ...overrides }), ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("returns 429 with Retry-After once the per-bearer limit is crossed", async () => {
    const t = "rl-crossed-token";
    await callAs(t, "/search", { PER_BEARER_RPM: "2" });
    await callAs(t, "/search", { PER_BEARER_RPM: "2" });
    const res = await callAs(t, "/search", { PER_BEARER_RPM: "2" });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(res.headers.get("X-RateLimit-Limit")).toBe("2");
  });

  it("allows traffic up to the limit before rejecting", async () => {
    const t = "rl-under-limit-token";
    const first = await callAs(t, "/search", { PER_BEARER_RPM: "3" });
    const second = await callAs(t, "/search", { PER_BEARER_RPM: "3" });

    expect(first.status).not.toBe(429);
    expect(second.status).not.toBe(429);
  });

  it("PER_BEARER_RPM=0 disables the limit entirely", async () => {
    const t = "rl-disabled-token";
    for (let i = 0; i < 5; i++) {
      const res = await callAs(t, "/search", { PER_BEARER_RPM: "0" });
      expect(res.status).not.toBe(429);
    }
  });

  it("does not rate-limit /admin/* so an operator can always recover", async () => {
    const t = "rl-admin-token";
    await callAs(t, "/admin/token", { PER_BEARER_RPM: "1" });
    const res = await callAs(t, "/admin/token", { PER_BEARER_RPM: "1" });

    expect(res.status).not.toBe(429);
  });

  it("counts per bearer, not globally", async () => {
    // Two distinct bearers must not share a bucket.
    await callAs("rl-tenant-a", "/search", { PER_BEARER_RPM: "1" });
    await callAs("rl-tenant-a", "/search", { PER_BEARER_RPM: "1" });
    const other = await callAs("rl-tenant-b", "/search", { PER_BEARER_RPM: "1" });

    expect(other.status).not.toBe(429);
  });
});

// ADR 0013: scoped client keys. A client key is a second kind of bearer that
// reaches /search and /mcp only; /summarize and /admin/* stay admin-only, and
// the admin token's behaviour is unchanged.
describe("scoped client keys", () => {
  const CLIENT_KEY = "client-key-under-test";
  // sha256("client-key-under-test"), computed in-test so the fixture cannot drift.
  async function clientKeys(name: string): Promise<string> {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CLIENT_KEY));
    const hex = Array.from(new Uint8Array(d))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return JSON.stringify({ [name]: hex });
  }
  const asClient = { Authorization: `Bearer ${CLIENT_KEY}` };

  it("GET /search is gated: 401 without a bearer", async () => {
    const res = await call("/search?q=x");
    expect(res.status).toBe(401);
  });

  it("GET /search reaches its handler with the admin token", async () => {
    const res = await call("/search", { headers: auth });
    expect(res.status).toBe(400); // missing-query, from the handler
  });

  it("GET /search reaches its handler with a client key", async () => {
    const res = await call("/search", { headers: asClient }, { CLIENT_KEYS: await clientKeys("ck-search") });
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("missing-query");
  });

  it("POST /search and /mcp accept a client key", async () => {
    const keys = await clientKeys("ck-post");
    const post = await call(
      "/search",
      { method: "POST", headers: { ...asClient, "Content-Type": "application/json" }, body: "{}" },
      { CLIENT_KEYS: keys },
    );
    expect(post.status).toBe(400);
    const mcp = await call("/mcp", { method: "GET", headers: asClient }, { CLIENT_KEYS: keys });
    expect([401, 403, 404]).not.toContain(mcp.status);
  });

  it.each([
    ["POST", "/summarize"],
    ["POST", "/admin/token"],
    ["POST", "/admin/refresh"],
    ["GET", "/definitely-not-a-route"],
  ])("%s %s is 403 forbidden-scope for a client key", async (method, path) => {
    const res = await call(path, { method, headers: asClient }, { CLIENT_KEYS: await clientKeys("ck-scope") });
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(403);
    expect(body.error.code).toBe("forbidden-scope");
  });

  it("a client key does not unlock /health detail", async () => {
    const res = await call("/health", { headers: asClient }, { CLIENT_KEYS: await clientKeys("ck-health") });
    expect(await res.json()).toEqual({ ok: true });
  });

  it("a client key is 401 when CLIENT_KEYS is not configured", async () => {
    const res = await call("/search?q=x", { headers: asClient });
    expect(res.status).toBe(401);
  });

  it("enforces CLIENT_KEY_RPM per client name", async () => {
    const o = { CLIENT_KEYS: await clientKeys("ck-rpm"), CLIENT_KEY_RPM: "2", CLIENT_KEY_RPD: "0" };
    await call("/search", { headers: asClient }, o);
    await call("/search", { headers: asClient }, o);
    const res = await call("/search", { headers: asClient }, o);
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("2");
  });

  it("enforces CLIENT_KEY_RPD with a Retry-After to UTC midnight", async () => {
    const o = { CLIENT_KEYS: await clientKeys("ck-rpd"), CLIENT_KEY_RPM: "0", CLIENT_KEY_RPD: "1" };
    await call("/search", { headers: asClient }, o);
    const res = await call("/search", { headers: asClient }, o);
    expect(res.status).toBe(429);
    const retry = Number(res.headers.get("Retry-After"));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(86_400);
  });

  it("client limits do not apply to the admin token", async () => {
    const o = { CLIENT_KEYS: await clientKeys("ck-admin"), CLIENT_KEY_RPM: "1", CLIENT_KEY_RPD: "1" };
    await call("/search", { headers: auth }, o);
    const res = await call("/search", { headers: auth }, o);
    expect(res.status).toBe(400);
  });
});
