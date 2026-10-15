// MCP resources — the four read-only URIs an MCP client can browse.
//
// registerResources takes an McpServer and hands it closures; the readers
// themselves are module-private. So the server is faked here purely to capture
// those closures, and the tests then call them directly.
//
// Runs in workerd: the budget reader talks to the Meter Durable Object and the
// status reader reads TOKEN_KV.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerResources } from "../../src/mcp/resources";
import { clearMemoryCache, saveToken } from "../../src/token/store.js";

type Reader = (uri: { href: string }) => Promise<{ contents: Array<{ text: string }> }>;

/** Captures what registerResources registers, keyed by resource name. */
function captureRegistrations(overrides: Record<string, unknown> = {}) {
  const registered = new Map<
    string,
    { uri: string; meta: { description: string; mimeType: string }; read: Reader }
  >();
  const server = {
    resource: (
      name: string,
      uri: string,
      meta: { description: string; mimeType: string },
      read: Reader,
    ) => {
      registered.set(name, { uri, meta, read });
    },
  };

  const testEnv = { ...env, ...overrides } as typeof env;
  registerResources(server as never, testEnv);
  return registered;
}

/** Runs one registered reader and parses the JSON payload it produced. */
async function read(name: string, overrides: Record<string, unknown> = {}) {
  const entry = captureRegistrations(overrides).get(name);
  if (!entry) throw new Error(`resource ${name} was never registered`);
  const result = await entry.read({ href: entry.uri });
  return JSON.parse(result.contents[0].text) as Record<string, unknown>;
}

const RSS_FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>A small web post</title>
    <link>https://blog.example.test/post</link>
    <pubDate>Wed, 01 Jan 2025 00:00:00 GMT</pubDate>
    <description>Some body text</description>
  </item>
</channel></rss>`;

// Two pieces of state outlive a test here, so both are reset explicitly rather
// than trusted to roll back: `memoryCache` is a module global that
// isolatedStorage knows nothing about, and the KV write that loadToken makes
// when it seeds from KAGI_SESSION_TOKEN was observed surviving into the next
// test. Explicit beats relying on rollback semantics — a leaked token here
// turns "missing" into "ok" and the suite passes for the wrong reason.
beforeEach(async () => {
  clearMemoryCache();
  await env.TOKEN_KV.delete(env.TOKEN_KV_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registerResources", () => {
  it("registers the four browsable URIs as JSON", () => {
    const registered = captureRegistrations();

    expect([...registered.keys()].sort()).toEqual([
      "kagi_api_status",
      "kagi_budget",
      "kagi_cache_stats",
      "kagi_smallweb_recent",
    ]);
    for (const [, entry] of registered) {
      expect(entry.meta.mimeType).toBe("application/json");
      expect(entry.meta.description).toBeTruthy();
    }
  });

  it("registers each reader under its kagi:// uri", () => {
    const registered = captureRegistrations();

    expect(registered.get("kagi_budget")?.uri).toBe("kagi://budget");
    expect(registered.get("kagi_api_status")?.uri).toBe("kagi://api-status");
    expect(registered.get("kagi_smallweb_recent")?.uri).toBe("kagi://smallweb/recent");
    expect(registered.get("kagi_cache_stats")?.uri).toBe("kagi://cache-stats");
  });

  it("echoes the requested uri back in the content envelope", async () => {
    const entry = captureRegistrations().get("kagi_budget")!;

    const result = await entry.read({ href: "kagi://budget" });

    expect(result.contents[0]).toMatchObject({
      uri: "kagi://budget",
      mimeType: "application/json",
    });
  });
});

describe("kagi://budget", () => {
  it("reports the cap, the spend, and the remaining budget for the month", async () => {
    const body = await read("kagi_budget", { MAX_API_CENTS_PER_MONTH: "250" });

    expect(body).toMatchObject({ cap_cents: 250 });
    expect(typeof body.spent_cents).toBe("number");
    expect(typeof body.remaining_cents).toBe("number");
    expect(body.month).toMatch(/^\d{4}-\d{2}$/);
  });

  // The resource is informational; a Meter outage must not make an MCP client
  // fail to list resources.
  it("degrades to an error payload when the Meter is unreachable", async () => {
    const brokenMeter = {
      idFromName: (name: string) => name,
      get: () => ({
        spendSnapshot: async () => {
          throw new Error("Durable Object unreachable");
        },
      }),
    };

    const body = await read("kagi_budget", { METER: brokenMeter });

    expect(body.error).toMatch(/unreachable/);
  });
});

describe("kagi://cache-stats", () => {
  it("reports the result cache's counters and hit rate", async () => {
    const body = await read("kagi_cache_stats");

    for (const field of ["hits", "misses", "stores", "entries", "hit_rate"]) {
      expect(typeof body[field]).toBe("number");
    }
    expect(Object.keys(body.by_domain as object).sort()).toEqual(["fastgpt", "search", "summarize"]);
  });

  it("degrades to an error payload when the cache binding is absent", async () => {
    const body = await read("kagi_cache_stats", { RESULT_CACHE: undefined });

    expect(body.error).toMatch(/RESULT_CACHE binding not configured/);
  });

  it("degrades to an error payload when the cache is unreachable", async () => {
    const brokenCache = {
      idFromName: (name: string) => name,
      get: () => ({
        stats: async () => {
          throw new Error("Durable Object unreachable");
        },
      }),
    };

    const body = await read("kagi_cache_stats", { RESULT_CACHE: brokenCache });

    expect(body.error).toMatch(/unreachable/);
  });
});

describe("kagi://api-status", () => {
  it("reports the resolved mode, credential presence, and the rate limit", async () => {
    const body = await read("kagi_api_status", {
      KAGI_MODE: "scrape",
      KAGI_SESSION_TOKEN: "a-session-token",
      KAGI_API_KEY: undefined,
      PER_BEARER_RPM: "42",
    });

    expect(body).toMatchObject({
      mode: "scrape",
      has_session: true,
      has_api_key: false,
      per_bearer_rpm: 42,
    });
  });

  it("reports a missing session token", async () => {
    const body = await read("kagi_api_status", {
      KAGI_MODE: "scrape",
      KAGI_SESSION_TOKEN: undefined,
    });

    expect(body.session_token).toMatchObject({ status: "missing" });
  });

  it("reports a healthy stored token with its source and timestamp", async () => {
    const testEnv = { ...env, KAGI_MODE: "scrape" } as typeof env;
    await saveToken(testEnv, { token: "tok", updatedAt: 1_700_000_000_000, source: "admin" });

    const body = await read("kagi_api_status", { KAGI_MODE: "scrape" });

    expect(body.session_token).toMatchObject({
      status: "ok",
      updatedAt: 1_700_000_000_000,
      source: "admin",
    });
  });

  it("reports a stale stored token", async () => {
    const testEnv = { ...env, KAGI_MODE: "scrape" } as typeof env;
    await saveToken(testEnv, {
      token: "tok",
      updatedAt: 1_700_000_000_000,
      source: "browser-refresh",
      stale: true,
    });

    const body = await read("kagi_api_status", { KAGI_MODE: "scrape" });

    expect(body.session_token).toMatchObject({ status: "stale" });
  });

  // resolveMode throws when auto-detection finds no credentials at all.
  it("degrades to an error payload when the mode cannot be resolved", async () => {
    const body = await read("kagi_api_status", {
      KAGI_MODE: "auto",
      KAGI_SESSION_TOKEN: undefined,
      KAGI_API_KEY: undefined,
    });

    expect(body.error).toMatch(/No Kagi credentials configured/);
    expect(body.mode).toBeUndefined();
  });
});

describe("kagi://smallweb/recent", () => {
  it("returns the parsed feed items", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(RSS_FEED, { headers: { "Content-Type": "application/rss+xml" } }),
        ),
    );

    const body = await read("kagi_smallweb_recent");
    const items = body.items as Array<{ title: string; link: string }>;

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "A small web post",
      link: "https://blog.example.test/post",
    });
  });

  it("degrades to an error payload when the feed is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 503, statusText: "Unavailable" })),
    );

    const body = await read("kagi_smallweb_recent");

    expect(body.error).toMatch(/503/);
  });

  it("degrades to an error payload when the fetch itself throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const body = await read("kagi_smallweb_recent");

    expect(body.error).toBe("network down");
  });
});
