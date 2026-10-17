// Refresh diagnostics must not reach REST response bodies.
//
// Like rest-real-client.test.ts, this file deliberately does NOT mock the
// KagiClient facade, the scrape client, the token store or the browser
// refresh: the leak is the composition of the real refresh building a
// reason out of tainted text (a Meter coordination exception, scraped
// sign-in page text, or a browser exception), the real scrape client
// interpolating it into a typed KagiError, and rest.ts emitting that typed
// message. Only @cloudflare/puppeteer and the raw upstream search call are
// mocked. Session state is seeded into the real KV-backed token store.
//
// Acceptance: no synthetic marker fragment appears in a REST body, across
// missing-token and long-stale states; the typed status/code is preserved
// (503 / kagi-not-configured — not a blanket 500); the missing-credential
// hint stays actionable; a successful refresh still serves results.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv } from "./_helpers";
import type { Env } from "../src/env";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch } }));

const raw = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("../src/kagi/search.js", () => ({ search: raw.search }));

const { handleSearch, handleSummarize } = await import("../src/rest");
const { clearMemoryCache } = await import("../src/token/store");

const SYNTH_PASSWORD = "synthetic-password-value-63d8";
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

const COORD_FRAGMENTS = [
  "coord-diagnostic-41f0",
  "synthetic-session-41f0",
  "/private/coord-41f0",
  "stack-41f0",
];
const LOGIN_FRAGMENTS = [
  "login-page-diagnostic-87c3",
  "synthetic-session-87c3",
  "/private/login-87c3",
  "stack-87c3",
];
const BROWSER_FRAGMENTS = [
  "browser-diagnostic-5d19",
  "synthetic-session-5d19",
  "/private/browser-5d19",
  "stack-5d19",
];

function markerText(fragments: string[]): string {
  return `${fragments[0]} session=${fragments[1]} at ${fragments[2]} Error: ${fragments[3]}`;
}

function expectClean(body: string, fragments: string[]) {
  for (const fragment of fragments) {
    expect(body).not.toContain(fragment);
  }
  expect(body).not.toContain(SYNTH_PASSWORD);
  expect(body).not.toContain("tok-seeded-stale");
}

function fakePage(overrides: { url?: string; evaluate?: () => Promise<unknown> } = {}) {
  return {
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    waitForNavigation: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue(overrides.url ?? "https://kagi.com/"),
    evaluate: overrides.evaluate ?? vi.fn().mockResolvedValue(""),
    cookies: vi.fn().mockResolvedValue([{ name: "kagi_session", value: "tok-live" }]),
  };
}

function fakeBrowser(page: ReturnType<typeof fakePage>) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function brokenCoordinationMeter() {
  return {
    idFromName: (name: string) => name,
    get: (id: string) =>
      id === "refresh"
        ? {
            tryRefreshLease: async () => {
              throw new Error(markerText(COORD_FRAGMENTS));
            },
          }
        : { takeKagiCall: () => ({ ok: true, retry_after_ms: 0 }) },
  } as unknown as Env["METER"];
}

function refreshableEnv(overrides: Partial<Env> = {}) {
  return makeEnv({
    AUTO_REFRESH_ENABLED: "true",
    BROWSER: {} as Env["BROWSER"],
    KAGI_MODE: "scrape",
    KAGI_EMAIL: "operator@example.test",
    KAGI_PASSWORD: SYNTH_PASSWORD,
    ...overrides,
  });
}

type SourceName = "coordination" | "login-page" | "browser";

const SOURCES: Array<{ name: SourceName; fragments: string[] }> = [
  { name: "coordination", fragments: COORD_FRAGMENTS },
  { name: "login-page", fragments: LOGIN_FRAGMENTS },
  { name: "browser", fragments: BROWSER_FRAGMENTS },
];

function envForSource(source: SourceName) {
  if (source === "coordination") {
    return refreshableEnv({ METER: brokenCoordinationMeter() });
  }
  if (source === "browser") {
    launch.mockRejectedValue(new Error(markerText(BROWSER_FRAGMENTS)));
    return refreshableEnv();
  }
  const page = fakePage({
    url: "https://kagi.com/signin?error=1",
    evaluate: vi.fn().mockResolvedValue(markerText(LOGIN_FRAGMENTS)),
  });
  launch.mockResolvedValue(fakeBrowser(page));
  return refreshableEnv();
}

async function summarize(env: ReturnType<typeof refreshableEnv>) {
  return handleSummarize(
    new Request("https://worker.test/summarize", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.test/a" }),
    }),
    env,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearMemoryCache();
  raw.search.mockResolvedValue({
    data: [{ t: 0, url: "https://a.example/", title: "A", snippet: "s" }],
  });
});

describe("POST /summarize with no session token", () => {
  for (const { name, fragments } of SOURCES) {
    it(`answers a clean 503 when refresh fails via ${name}`, async () => {
      const res = await summarize(envForSource(name));

      expect(res.status).toBe(503);
      const body = await res.text();
      expect(body).toContain("kagi-not-configured");
      expectClean(body, fragments);
    });
  }
});

describe("POST /summarize with a long-stale session token", () => {
  it("answers a clean 503 when refresh fails via the browser", async () => {
    const env = envForSource("browser");
    const staleAt = Date.now() - TWELVE_HOURS_MS - 60_000;
    await env.TOKEN_KV.put(
      env.TOKEN_KV_KEY,
      JSON.stringify({
        token: "tok-seeded-stale",
        updatedAt: staleAt,
        source: "admin",
        stale: true,
        staleAt,
      }),
    );

    const res = await summarize(env);

    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("kagi-not-configured");
    expectClean(body, BROWSER_FRAGMENTS);
  });
});

describe("POST /search per-query error text", () => {
  it("keeps coordination diagnostics out of the per-query error", async () => {
    const res = await handleSearch(
      new Request("https://worker.test/search", {
        method: "POST",
        body: JSON.stringify({ queries: ["hi"] }),
      }),
      envForSource("coordination"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ ok: boolean; error?: string }>;
    };
    expect(body.results[0].ok).toBe(false);
    expect(typeof body.results[0].error).toBe("string");
    expectClean(body.results[0].error!, COORD_FRAGMENTS);
  });
});

describe("controls that must keep passing", () => {
  it("keeps the missing-credential hint in the 503 body", async () => {
    const res = await summarize(
      refreshableEnv({ KAGI_EMAIL: undefined as unknown as string }),
    );

    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("KAGI_EMAIL/KAGI_PASSWORD not set");
    expect(body).not.toContain(SYNTH_PASSWORD);
  });

  it("still serves search results after a successful refresh", async () => {
    launch.mockResolvedValue(fakeBrowser(fakePage()));

    const res = await handleSearch(
      new Request("https://worker.test/search", {
        method: "POST",
        body: JSON.stringify({ queries: ["hi"] }),
      }),
      refreshableEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ ok: boolean }> };
    expect(body.results[0].ok).toBe(true);
  });
});
