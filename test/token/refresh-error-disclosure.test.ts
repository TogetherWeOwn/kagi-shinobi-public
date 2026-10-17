// Browser-refresh failure reasons must never disclose diagnostics.
//
// A refresh `reason` is client-visible text: src/token/admin.ts returns it
// verbatim in a 503 body, and src/kagi/scrape/index.ts interpolates it into
// typed errors that REST and MCP pass through. Three sources currently build
// that reason out of tainted text:
//
//   1. a coordination (Meter lease) exception's message,
//   2. error text scraped off the remote sign-in page,
//   3. a caught browser (puppeteer) exception's message.
//
// Each source is driven here with synthetic markers (a distinctive token, a
// fake session id, an internal path, a stack fragment) through the real
// refreshTokenViaBrowser — only @cloudflare/puppeteer and the Meter stub are
// mocked, the same low-level seams refresh-browser.test.ts uses — and no
// marker fragment may appear in the returned reason. The reason must still
// be present and categorised (fixed safe text, not an empty string), the
// intentional missing-credential hint must survive verbatim, and a
// successful refresh must be unchanged.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv } from "../_helpers";
import type { Env } from "../../src/env";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch } }));

const { refreshTokenViaBrowser } = await import("../../src/token/refresh");
const { clearMemoryCache } = await import("../../src/token/store");

const SYNTH_PASSWORD = "synthetic-password-value-63d8";

const COORD_TEXT =
  "coord-diagnostic-41f0 session=synthetic-session-41f0 at /private/coord-41f0 Error: stack-41f0";
const COORD_FRAGMENTS = [
  "coord-diagnostic-41f0",
  "synthetic-session-41f0",
  "/private/coord-41f0",
  "stack-41f0",
];
const LOGIN_TEXT =
  "login-page-diagnostic-87c3 session=synthetic-session-87c3 at /private/login-87c3 Error: stack-87c3";
const LOGIN_FRAGMENTS = [
  "login-page-diagnostic-87c3",
  "synthetic-session-87c3",
  "/private/login-87c3",
  "stack-87c3",
];
const BROWSER_TEXT =
  "browser-diagnostic-5d19 session=synthetic-session-5d19 at /private/browser-5d19 Error: stack-5d19";
const BROWSER_FRAGMENTS = [
  "browser-diagnostic-5d19",
  "synthetic-session-5d19",
  "/private/browser-5d19",
  "stack-5d19",
];

function expectClean(text: string | undefined, fragments: string[]) {
  expect(typeof text).toBe("string");
  expect(text!.length).toBeGreaterThan(0);
  for (const fragment of fragments) {
    expect(text).not.toContain(fragment);
  }
  expect(text).not.toContain(SYNTH_PASSWORD);
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

function refreshableEnv(overrides: Partial<Env> = {}) {
  return makeEnv({
    AUTO_REFRESH_ENABLED: "true",
    BROWSER: {} as Env["BROWSER"],
    KAGI_EMAIL: "operator@example.test",
    KAGI_PASSWORD: SYNTH_PASSWORD,
    ...overrides,
  });
}

/** A Meter namespace whose refresh-lease stub throws `thrown` (source 1). */
function brokenCoordinationMeter(thrown: unknown) {
  return {
    idFromName: (name: string) => name,
    get: (id: string) =>
      id === "refresh"
        ? {
            tryRefreshLease: async () => {
              throw thrown;
            },
          }
        : { takeKagiCall: () => ({ ok: true, retry_after_ms: 0 }) },
  } as unknown as Env["METER"];
}

beforeEach(() => {
  vi.clearAllMocks();
  clearMemoryCache();
});

describe("coordination failures (source 1)", () => {
  it("keeps a Meter exception's text out of the reason", async () => {
    const env = refreshableEnv({ METER: brokenCoordinationMeter(new Error(COORD_TEXT)) });

    const result = await refreshTokenViaBrowser(env);

    expect(result.ok).toBe(false);
    expectClean(result.reason, COORD_FRAGMENTS);
    expect(result.reason).toMatch(/coordinat|refresh/i);
    // Fail-closed is existing behaviour: no browser was launched.
    expect(launch).not.toHaveBeenCalled();
  });

  it("keeps a non-Error coordination throw out of the reason", async () => {
    const env = refreshableEnv({ METER: brokenCoordinationMeter(COORD_TEXT) });

    const result = await refreshTokenViaBrowser(env);

    expect(result.ok).toBe(false);
    expectClean(result.reason, COORD_FRAGMENTS);
  });
});

describe("scraped sign-in page text (source 2)", () => {
  it("keeps the remote login page's error text out of the reason", async () => {
    const page = fakePage({
      url: "https://kagi.com/signin?error=1",
      evaluate: vi.fn().mockResolvedValue(LOGIN_TEXT),
    });
    launch.mockResolvedValue(fakeBrowser(page));

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result.ok).toBe(false);
    expectClean(result.reason, LOGIN_FRAGMENTS);
    expect(result.reason).toMatch(/login|refresh/i);
  });
});

describe("browser exceptions (source 3)", () => {
  it("keeps a launch exception's text out of the reason", async () => {
    launch.mockRejectedValue(new Error(BROWSER_TEXT));

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result.ok).toBe(false);
    expectClean(result.reason, BROWSER_FRAGMENTS);
    expect(result.reason).toMatch(/refresh/i);
  });

  it("keeps a mid-flow navigation exception's text out of the reason", async () => {
    const page = fakePage();
    page.goto.mockRejectedValue(new Error(BROWSER_TEXT));
    const browser = fakeBrowser(page);
    launch.mockResolvedValue(browser);

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result.ok).toBe(false);
    expectClean(result.reason, BROWSER_FRAGMENTS);
    expect(browser.close).toHaveBeenCalled();
  });

  it("keeps a non-Error browser throw out of the reason", async () => {
    launch.mockRejectedValue(BROWSER_TEXT);

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result.ok).toBe(false);
    expectClean(result.reason, BROWSER_FRAGMENTS);
  });
});

describe("controls that must keep passing", () => {
  it("preserves the missing-credential setup hint verbatim", async () => {
    const result = await refreshTokenViaBrowser(
      refreshableEnv({ KAGI_EMAIL: undefined as unknown as string }),
    );

    expect(result).toEqual({ ok: false, reason: "KAGI_EMAIL/KAGI_PASSWORD not set" });
    expect(result.reason).not.toContain(SYNTH_PASSWORD);
  });

  it("still reports a held lease without launching a browser", async () => {
    const env = refreshableEnv();
    const stub = env.METER.get(env.METER.idFromName("refresh")) as unknown as {
      tryRefreshLease: (now: number, leaseMs: number, force?: boolean) => unknown;
    };
    await stub.tryRefreshLease(Date.now(), 60_000, true);

    const result = await refreshTokenViaBrowser(env);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/another refresh/i);
    expect(launch).not.toHaveBeenCalled();
  });

  it("still succeeds on the happy path", async () => {
    launch.mockResolvedValue(fakeBrowser(fakePage()));

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result).toEqual({ ok: true, token: "tok-live" });
  });

  it("still reports a failed login when the page shows no error text", async () => {
    const page = fakePage({
      url: "https://kagi.com/signin",
      evaluate: vi.fn().mockResolvedValue(""),
    });
    launch.mockResolvedValue(fakeBrowser(page));

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/login|refresh/i);
  });
});
