import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshTokenViaBrowser } from "./refresh.js";
import { saveToken } from "./store.js";
import type { Env } from "../env.js";

vi.mock("@cloudflare/puppeteer", () => ({
  default: {
    launch: vi.fn(),
  },
}));

vi.mock("../util/log.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("./store.js", () => ({
  saveToken: vi.fn(),
}));

import puppeteer from "@cloudflare/puppeteer";
import { logWarn } from "../util/log.js";

const mockedLaunch = vi.mocked(puppeteer.launch);
const mockedLogWarn = vi.mocked(logWarn);

function makeBrowser(finalUrl: string, errorText = "") {
  const page = {
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    waitForNavigation: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue(finalUrl),
    evaluate: vi.fn().mockResolvedValue(errorText),
    cookies: vi.fn().mockResolvedValue([{ name: "kagi_session", value: "fresh" }]),
  };
  const browser = {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
  mockedLaunch.mockResolvedValue(browser as never);
  return { browser, page };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AUTO_REFRESH_ENABLED: "true",
    BROWSER: {} as Env["BROWSER"],
    KAGI_EMAIL: "user@example.test",
    KAGI_PASSWORD: "password",
    METER: {
      idFromName: vi.fn().mockReturnValue("refresh-id"),
      get: vi.fn().mockReturnValue({
        tryRefreshLease: vi.fn().mockResolvedValue({ acquired: true, retry_after_ms: 0 }),
      }),
    } as unknown as Env["METER"],
    TOKEN_KV: {} as Env["TOKEN_KV"],
    ...overrides,
  } as Env;
}

describe("refreshTokenViaBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only safe text when coordination throws diagnostics", async () => {
    const env = makeEnv({
      METER: {
        idFromName: vi.fn().mockReturnValue("refresh-id"),
        get: vi.fn().mockReturnValue({
          tryRefreshLease: vi.fn().mockRejectedValue(new Error("internal sentinel detail")),
        }),
      } as unknown as Env["METER"],
    });

    const result = await refreshTokenViaBrowser(env);

    expect(result).toEqual({ ok: false, reason: "cannot coordinate refresh" });
    expect(JSON.stringify(result)).not.toContain("internal sentinel detail");
    expect(mockedLogWarn).toHaveBeenCalledWith("browser-refresh: cannot coordinate refresh", {
      error: "internal sentinel detail",
    });
  });

  it("returns safe login failure text while recording remote detail only for logging", async () => {
    makeBrowser("https://kagi.com/signin", "remote page secret diagnostic");

    const result = await refreshTokenViaBrowser(makeEnv());

    expect(result).toEqual({
      ok: false,
      reason: "login failed: stayed on /signin (bad credentials or captcha)",
    });
    expect(JSON.stringify(result)).not.toContain("remote page secret diagnostic");
    expect(mockedLogWarn).toHaveBeenCalledWith(
      "browser-refresh: login failed: stayed on /signin (bad credentials or captcha)",
      { error: "remote page secret diagnostic" },
    );
  });

  it("returns safe text when browser throws diagnostics", async () => {
    mockedLaunch.mockRejectedValueOnce(new Error("browser sentinel detail"));

    const result = await refreshTokenViaBrowser(makeEnv());

    expect(result).toEqual({ ok: false, reason: "refresh failed" });
    expect(JSON.stringify(result)).not.toContain("browser sentinel detail");
    expect(mockedLogWarn).toHaveBeenCalledWith("browser-refresh: failed", {
      error: "browser sentinel detail",
    });
  });

  it("returns the fresh token and closes the browser after a successful login", async () => {
    const { browser } = makeBrowser("https://kagi.com/", "");

    const result = await refreshTokenViaBrowser(makeEnv());

    expect(result).toEqual({ ok: true, token: "fresh" });
    expect(saveToken).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
