// Refresh diagnostics must not survive the scrape client's error conversion.
//
// Unlike client.test.ts, this file does NOT mock src/token/refresh.js or
// src/token/store.js: the leak is the composition of the real
// refreshTokenViaBrowser building a reason out of tainted text and the real
// KagiScrapeClient interpolating that reason into KagiNotConfiguredError /
// KagiAuthError — typed errors whose messages safeErrorMessage passes to
// REST and MCP clients verbatim. Only the lowest seams are mocked:
// @cloudflare/puppeteer, the raw upstream search/summarize calls, and (for
// the coordination source) the Meter lease stub. The token store is the real
// KV-backed one over the in-memory KV from _helpers, seeded per session
// state.
//
// Acceptance: for each of the three tainted sources (coordination
// exception, scraped sign-in text, browser exception), neither the thrown
// typed error's message nor safeErrorMessage(error) — the exact text REST
// and MCP emit — may contain any synthetic marker fragment, across the
// missing-token, long-stale (>12h) and post-401 session states. Error kind
// must be preserved (not a blanket generic), the missing-credential hint
// must stay actionable, and successful refresh / recently-stale serving
// must be unchanged.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv } from "../_helpers";
import type { Env } from "../../src/env";
import {
  KagiAuthError,
  KagiNotConfiguredError,
  safeErrorMessage,
} from "../../src/kagi/errors";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch } }));

const raw = vi.hoisted(() => ({ search: vi.fn(), summarize: vi.fn() }));
vi.mock("../../src/kagi/search.js", () => ({ search: raw.search }));
vi.mock("../../src/kagi/summarize.js", () => ({ summarize: raw.summarize }));

const { KagiScrapeClient } = await import("../../src/kagi/scrape/index");
const { clearMemoryCache } = await import("../../src/token/store");

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

function expectClean(text: string, fragments: string[]) {
  for (const fragment of fragments) {
    expect(text).not.toContain(fragment);
  }
  expect(text).not.toContain(SYNTH_PASSWORD);
  // The seeded stale session token value must never surface either.
  expect(text).not.toContain("tok-seeded-stale");
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

/** Build an env whose real browser refresh will fail via `source`. */
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

async function seedToken(
  env: ReturnType<typeof refreshableEnv>,
  envelope: Record<string, unknown>,
) {
  clearMemoryCache();
  await env.TOKEN_KV.put(env.TOKEN_KV_KEY, JSON.stringify(envelope));
}

function longStaleEnvelope() {
  const staleAt = Date.now() - TWELVE_HOURS_MS - 60_000;
  return {
    token: "tok-seeded-stale",
    updatedAt: staleAt,
    source: "admin",
    stale: true,
    staleAt,
  };
}

async function captureError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

const RAW_SEARCH = { data: [{ t: 0, url: "https://a.example/", title: "A", snippet: "s" }] };
const RAW_SUMMARY = { data: { output: "a summary" } };

beforeEach(() => {
  vi.clearAllMocks();
  clearMemoryCache();
  raw.search.mockResolvedValue(RAW_SEARCH);
  raw.summarize.mockResolvedValue(RAW_SUMMARY);
});

describe("missing token: refresh failure becomes a clean not-configured error", () => {
  for (const { name, fragments } of SOURCES) {
    it(`hides ${name} diagnostics from the typed error and its client text`, async () => {
      const client = new KagiScrapeClient(envForSource(name));

      const err = await captureError(() => client.search({ q: "hi" }));

      expect(err).toBeInstanceOf(KagiNotConfiguredError);
      expect((err as InstanceType<typeof KagiNotConfiguredError>).kind).toBe("not_configured");
      expectClean(err.message, fragments);
      expectClean(safeErrorMessage(err), fragments);
    });
  }
});

describe("long-stale token: refresh failure becomes a clean not-configured error", () => {
  for (const { name, fragments } of SOURCES) {
    it(`hides ${name} diagnostics from the typed error and its client text`, async () => {
      const env = envForSource(name);
      await seedToken(env, longStaleEnvelope());
      const client = new KagiScrapeClient(env);

      const err = await captureError(() => client.search({ q: "hi" }));

      expect(err).toBeInstanceOf(KagiNotConfiguredError);
      expect((err as InstanceType<typeof KagiNotConfiguredError>).kind).toBe("not_configured");
      expectClean(err.message, fragments);
      expectClean(safeErrorMessage(err), fragments);
    });
  }
});

describe("post-401 refresh failure becomes a clean auth error", () => {
  it("hides browser diagnostics on the search retry path", async () => {
    const env = envForSource("browser");
    await seedToken(env, {
      token: "tok-seeded-stale",
      updatedAt: Date.now(),
      source: "admin",
      stale: false,
    });
    raw.search.mockRejectedValue(new KagiAuthError());
    const client = new KagiScrapeClient(env);

    const err = await captureError(() => client.search({ q: "hi" }));

    expect(err).toBeInstanceOf(KagiAuthError);
    expect((err as InstanceType<typeof KagiAuthError>).kind).toBe("auth");
    expectClean(err.message, BROWSER_FRAGMENTS);
    expectClean(safeErrorMessage(err), BROWSER_FRAGMENTS);
  });

  it("hides sign-in page diagnostics on the summarize retry path", async () => {
    const env = envForSource("login-page");
    await seedToken(env, {
      token: "tok-seeded-stale",
      updatedAt: Date.now(),
      source: "admin",
      stale: false,
    });
    raw.summarize.mockRejectedValue(new KagiAuthError());
    const client = new KagiScrapeClient(env);

    const err = await captureError(() =>
      client.summarize({ kind: "url", ref: "https://x.example", language: "EN", style: "summary" }),
    );

    expect(err).toBeInstanceOf(KagiAuthError);
    expect((err as InstanceType<typeof KagiAuthError>).kind).toBe("auth");
    expectClean(err.message, LOGIN_FRAGMENTS);
    expectClean(safeErrorMessage(err), LOGIN_FRAGMENTS);
  });
});

describe("controls that must keep passing", () => {
  it("keeps the missing-credential hint actionable in the client text", async () => {
    const env = refreshableEnv({ KAGI_EMAIL: undefined as unknown as string });
    const client = new KagiScrapeClient(env);

    const err = await captureError(() => client.search({ q: "hi" }));

    expect(err).toBeInstanceOf(KagiNotConfiguredError);
    expect(safeErrorMessage(err)).toContain("KAGI_EMAIL/KAGI_PASSWORD not set");
    expect(safeErrorMessage(err)).not.toContain(SYNTH_PASSWORD);
  });

  it("still bootstraps a missing token via a successful refresh", async () => {
    launch.mockResolvedValue(fakeBrowser(fakePage()));
    const client = new KagiScrapeClient(refreshableEnv());

    const resp = await client.search({ q: "hi" });

    expect(raw.search).toHaveBeenCalledWith("hi", "tok-live", 10);
    expect(resp.meta.refresh_triggered).toBe(true);
  });

  it("still serves a recently-stale token when refresh fails, with no diagnostics in the response", async () => {
    const env = envForSource("browser");
    await seedToken(env, {
      token: "tok-seeded-stale",
      updatedAt: Date.now() - 60_000,
      source: "admin",
      stale: true,
      staleAt: Date.now() - 60_000,
    });
    const client = new KagiScrapeClient(env);

    const resp = await client.search({ q: "hi" });

    expect(raw.search).toHaveBeenCalledWith("hi", "tok-seeded-stale", 10);
    expect(resp.meta.session_stale).toBe(true);
    expectClean(JSON.stringify(resp), BROWSER_FRAGMENTS);
  });
});
