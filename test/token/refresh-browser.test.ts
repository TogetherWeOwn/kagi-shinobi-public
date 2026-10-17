// The Browser Rendering login flow in src/token/refresh.ts.
//
// refresh-lease.test.ts covers the pre-flight guards and the cross-isolate
// lease against the real Meter DO; those tests all stop before a browser is
// launched. This file picks up from there: @cloudflare/puppeteer is mocked, so
// every branch of the login itself — success, bad credentials, a missing
// cookie, an outright crash — is reachable without workerd.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv } from "../_helpers";
import type { Env } from "../../src/env";
import { CHROME_UA, CHROME_VERSION } from "../../src/kagi/headers";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch } }));

const { refreshTokenViaBrowser } = await import("../../src/token/refresh");
const { clearMemoryCache, loadToken } = await import("../../src/token/store");

const LOGGED_IN_URL = "https://kagi.com/";

interface PageOverrides {
  url?: string;
  cookies?: Array<{ name: string; value: string }>;
  evaluate?: () => Promise<unknown>;
}

/** A Puppeteer page that walks the happy path unless told otherwise. */
function fakePage(overrides: PageOverrides = {}) {
  return {
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    waitForNavigation: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue(overrides.url ?? LOGGED_IN_URL),
    evaluate: overrides.evaluate ?? vi.fn().mockResolvedValue(""),
    cookies: vi
      .fn()
      .mockResolvedValue(overrides.cookies ?? [{ name: "kagi_session", value: "tok-live" }]),
  };
}

function fakeBrowser(page: ReturnType<typeof fakePage>) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** An env where every pre-flight guard passes, so the browser path runs. */
function refreshableEnv(overrides: Partial<Env> = {}) {
  return makeEnv({
    AUTO_REFRESH_ENABLED: "true",
    BROWSER: {} as Env["BROWSER"],
    KAGI_EMAIL: "operator@example.test",
    KAGI_PASSWORD: "hunter2",
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // `memoryCache` in store.ts is a module global, so a token saved by a
  // successful refresh is still visible to loadToken() through a brand-new
  // env. Without this reset, "no token was stored" passes for the wrong
  // reason — or fails because a neighbouring test stored one.
  clearMemoryCache();
});

describe("successful login", () => {
  it("returns the fresh cookie value", async () => {
    const page = fakePage();
    launch.mockResolvedValue(fakeBrowser(page));

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result).toEqual({ ok: true, token: "tok-live" });
  });

  it("persists the token with the browser-refresh source", async () => {
    const page = fakePage();
    launch.mockResolvedValue(fakeBrowser(page));
    const env = refreshableEnv();

    await refreshTokenViaBrowser(env);

    expect(await loadToken(env)).toMatchObject({
      token: "tok-live",
      source: "browser-refresh",
      stale: false,
    });
  });

  it("fingerprints as Chrome before navigating", async () => {
    const page = fakePage();
    launch.mockResolvedValue(fakeBrowser(page));

    await refreshTokenViaBrowser(refreshableEnv());

    // The login flow reuses CHROME_UA from src/kagi/headers.ts — pinned by
    // exact value, not substring, so the login fingerprint cannot drift a
    // single token away from the request fingerprint.
    expect(page.setUserAgent).toHaveBeenCalledWith(CHROME_UA);
    expect(CHROME_UA).toContain(`Chrome/${CHROME_VERSION}`);
    expect(page.setExtraHTTPHeaders).toHaveBeenCalledWith({
      "Accept-Language": "en-US,en;q=0.9",
    });
    expect(page.goto).toHaveBeenCalledWith(
      "https://kagi.com/signin",
      expect.objectContaining({ waitUntil: "networkidle2" }),
    );
  });

  it("types the configured credentials into the real form fields", async () => {
    const page = fakePage();
    launch.mockResolvedValue(fakeBrowser(page));

    await refreshTokenViaBrowser(refreshableEnv());

    expect(page.waitForSelector).toHaveBeenCalledWith("#signInEmailBox", expect.anything());
    expect(page.type).toHaveBeenNthCalledWith(
      1,
      "#signInEmailBox",
      "operator@example.test",
      expect.anything(),
    );
    expect(page.type).toHaveBeenNthCalledWith(
      2,
      "#signInPassBox",
      "hunter2",
      expect.anything(),
    );
    expect(page.click).toHaveBeenCalledWith('#signInForm button[type="submit"]');
  });

  it("closes the browser after reading the cookie", async () => {
    const page = fakePage();
    const browser = fakeBrowser(page);
    launch.mockResolvedValue(browser);

    await refreshTokenViaBrowser(refreshableEnv());

    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

describe("failed login", () => {
  it("does not disclose the on-page error when one is visible", async () => {
    const page = fakePage({
      url: "https://kagi.com/signin?error=1",
      evaluate: vi.fn().mockResolvedValue("Invalid email or password"),
    });
    launch.mockResolvedValue(fakeBrowser(page));

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result).toEqual({
      ok: false,
      reason: "login failed: stayed on /signin (bad credentials or captcha)",
    });
  });

  it("falls back to a generic reason when the page shows no error text", async () => {
    const page = fakePage({
      url: "https://kagi.com/signin",
      evaluate: vi.fn().mockResolvedValue(""),
    });
    launch.mockResolvedValue(fakeBrowser(page));

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result.reason).toBe(
      "login failed: stayed on /signin (bad credentials or captcha)",
    );
  });

  it("survives evaluate() itself throwing", async () => {
    const page = fakePage({
      url: "https://kagi.com/signin",
      evaluate: vi.fn().mockRejectedValue(new Error("detached frame")),
    });
    launch.mockResolvedValue(fakeBrowser(page));

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("stayed on /signin");
  });

  it("ignores a non-string evaluate() result", async () => {
    const page = fakePage({
      url: "https://kagi.com/signin",
      evaluate: vi.fn().mockResolvedValue({ unexpected: true }),
    });
    launch.mockResolvedValue(fakeBrowser(page));

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result.reason).toContain("stayed on /signin");
  });

  it("does not store a token when the login fails", async () => {
    const page = fakePage({ url: "https://kagi.com/signin" });
    launch.mockResolvedValue(fakeBrowser(page));
    const env = refreshableEnv();

    await refreshTokenViaBrowser(env);

    expect(await loadToken(env)).toBeNull();
  });
});

describe("missing cookie", () => {
  it("reports the absent kagi_session cookie", async () => {
    const page = fakePage({ cookies: [{ name: "other", value: "x" }] });
    launch.mockResolvedValue(fakeBrowser(page));

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result).toEqual({
      ok: false,
      reason: "kagi_session cookie missing after login",
    });
  });

  it("treats an empty cookie value as missing", async () => {
    const page = fakePage({ cookies: [{ name: "kagi_session", value: "" }] });
    launch.mockResolvedValue(fakeBrowser(page));

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("cookie missing");
  });
});

describe("crashes", () => {
  it("wraps a launch failure as a refresh failure", async () => {
    launch.mockRejectedValue(new Error("no browser sessions available"));

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result).toEqual({
      ok: false,
      reason: "refresh failed",
    });
  });

  it("stringifies a non-Error throw", async () => {
    launch.mockRejectedValue("kaboom");

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result.reason).toBe("refresh failed");
  });

  it("closes the browser when a step after launch throws", async () => {
    const page = fakePage();
    page.goto.mockRejectedValue(new Error("navigation timeout"));
    const browser = fakeBrowser(page);
    launch.mockResolvedValue(browser);

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result.ok).toBe(false);
    expect(browser.close).toHaveBeenCalled();
  });

  it("does not mask the original failure when close() also throws", async () => {
    const page = fakePage();
    page.goto.mockRejectedValue(new Error("navigation timeout"));
    const browser = fakeBrowser(page);
    browser.close.mockRejectedValue(new Error("already disconnected"));
    launch.mockResolvedValue(browser);

    const result = await refreshTokenViaBrowser(refreshableEnv());

    expect(result.reason).toBe("refresh failed");
  });
});

describe("per-isolate single flight", () => {
  it("coalesces concurrent callers into one browser session", async () => {
    const page = fakePage();
    launch.mockResolvedValue(fakeBrowser(page));
    const env = refreshableEnv();

    const [a, b, c] = await Promise.all([
      refreshTokenViaBrowser(env),
      refreshTokenViaBrowser(env),
      refreshTokenViaBrowser(env),
    ]);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("clears the in-flight slot so a later call can run again", async () => {
    const page = fakePage();
    launch.mockResolvedValue(fakeBrowser(page));

    // Separate envs: each carries its own Meter, so the 60s lease taken by the
    // first refresh does not turn the second one away.
    await refreshTokenViaBrowser(refreshableEnv());
    await refreshTokenViaBrowser(refreshableEnv());

    expect(launch).toHaveBeenCalledTimes(2);
  });
});
