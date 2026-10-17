// CAPTCHA alerting.
//
// This is a best-effort side channel: the operator needs to hear that
// automated login is blocked, but a dead webhook must never turn into a
// failed refresh on top of an already-failing login. "Never throws" is the
// whole contract.

import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPTCHA_SELECTORS, notifyCaptcha } from "../../src/token/captcha";
import { makeEnv } from "../_helpers";

const WEBHOOK = "https://hooks.example.test/captcha";
const PAYLOAD = { ts: "2026-08-06T00:00:00.000Z", reason: "turnstile challenge detected" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("notifyCaptcha", () => {
  it("posts the payload as JSON to the configured webhook", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await notifyCaptcha(makeEnv({ CAPTCHA_WEBHOOK_URL: WEBHOOK }), PAYLOAD);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual(PAYLOAD);
  });

  it("includes the optional hint when one is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await notifyCaptcha(makeEnv({ CAPTCHA_WEBHOOK_URL: WEBHOOK }), {
      ...PAYLOAD,
      hint: "log in manually at kagi.com",
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).hint).toBe("log in manually at kagi.com");
  });

  // Alerting is opt-in. No webhook configured is a normal deployment, not an
  // error, and must not cost a fetch.
  it("does nothing when no webhook is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await notifyCaptcha(makeEnv({ CAPTCHA_WEBHOOK_URL: undefined }), PAYLOAD);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a webhook failure and logs it instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      notifyCaptcha(makeEnv({ CAPTCHA_WEBHOOK_URL: WEBHOOK }), PAYLOAD),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    // The error goes in an `error` field, not `msg`. logWarn spreads fields
    // last, so a field named `msg` silently replaces the log message — the
    // operator would see "connection refused" with no hint of what failed.
    expect(JSON.parse(warn.mock.calls[0][0] as string)).toEqual({
      level: "warn",
      msg: "captcha webhook failed",
      error: "connection refused",
    });
  });

  it("swallows a non-Error rejection too", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("just a string"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      notifyCaptcha(makeEnv({ CAPTCHA_WEBHOOK_URL: WEBHOOK }), PAYLOAD),
    ).resolves.toBeUndefined();
  });
});

describe("CAPTCHA_SELECTORS", () => {
  it("covers the challenge providers Kagi's login can surface", () => {
    const joined = CAPTCHA_SELECTORS.join(" ");

    expect(joined).toMatch(/turnstile/);
    expect(joined).toMatch(/hcaptcha/);
    expect(joined).toMatch(/recaptcha/);
  });

  it("lists only non-empty selector strings", () => {
    for (const selector of CAPTCHA_SELECTORS) {
      expect(typeof selector).toBe("string");
      expect(selector.length).toBeGreaterThan(0);
    }
  });
});
