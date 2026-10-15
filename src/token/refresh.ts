// Browser Rendering login flow. Puppeteer-controlled headless Chrome logs in
// to kagi.com with the stored email + password, reads the fresh
// kagi_session cookie, and hands it back to the caller.
//
// Runs only when AUTO_REFRESH_ENABLED === "true", the BROWSER binding is
// present, and KAGI_EMAIL + KAGI_PASSWORD secrets are set. Otherwise the
// caller falls back to whatever's currently in KV and surfaces a stale error.
//
// Form structure verified against a live fetch of kagi.com/signin
// (2026-07-10): single-page form with a CSRF hidden input, so we let
// Puppeteer submit the actual <form id="signInForm"> — the CSRF token comes
// along for the ride.

import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "../env.js";
import { CHROME_UA } from "../kagi/headers.js";
import { logInfo, logWarn } from "../util/log.js";
import { saveToken } from "./store.js";

interface RefreshResult {
  ok: boolean;
  token?: string;
  reason?: string;
}

let inflight: Promise<RefreshResult> | null = null;

/**
 * How long one refresh attempt reserves the right to run. Matches the token
 * cache TTL in store.ts for the same reason: 60s is how long a rotation can
 * stay invisible to another isolate, so it is exactly the window in which a
 * second refresh would be redundant.
 */
const LEASE_MS = 60_000;

export interface RefreshOptions {
  /**
   * Skip the lease check. For POST /admin/refresh, where an operator has
   * explicitly asked for a refresh and should not be made to wait behind an
   * automatic one.
   */
  force?: boolean;
}

export async function refreshTokenViaBrowser(
  env: Env,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  // Single-flight: coalesce concurrent refresh triggers into one browser
  // session. This is per-isolate; the lease below covers the other isolates.
  if (inflight) return inflight;
  inflight = doRefresh(env, opts).finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Cross-isolate single-flight. `inflight` above only sees this isolate, and a
 * token rotation stays invisible to the others for up to KV's propagation
 * window — long enough for each of them to read the same lingering
 * `stale: true` and launch its own browser. Browser Rendering is billable and
 * capped at a small number of concurrent sessions per account, so that
 * stampede costs money and then fails.
 *
 * Fails CLOSED: if the Meter is unreachable we cannot coordinate, and an
 * uncoordinated refresh is the thing being prevented. ADR 0006 takes the same
 * position for the spend counter.
 */
async function takeRefreshLease(
  env: Env,
  force: boolean,
): Promise<{ granted: boolean; reason?: string }> {
  try {
    const stub = env.METER.get(env.METER.idFromName("refresh"));
    const verdict = await stub.tryRefreshLease(Date.now(), LEASE_MS, force);
    if (verdict.acquired) return { granted: true };

    const seconds = Math.max(1, Math.ceil(verdict.retry_after_ms / 1000));
    return {
      granted: false,
      reason: `another refresh holds the lease; retry in ${seconds}s`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { granted: false, reason: `cannot coordinate refresh: ${msg}` };
  }
}

async function doRefresh(env: Env, opts: RefreshOptions): Promise<RefreshResult> {
  if (env.AUTO_REFRESH_ENABLED !== "true") {
    return { ok: false, reason: "auto-refresh disabled" };
  }
  if (!env.BROWSER) {
    return { ok: false, reason: "BROWSER binding missing" };
  }
  if (!env.KAGI_EMAIL || !env.KAGI_PASSWORD) {
    return { ok: false, reason: "KAGI_EMAIL/KAGI_PASSWORD not set" };
  }

  // Only after the free checks — an unreachable Meter must not stop us from
  // reporting a plain misconfiguration.
  const lease = await takeRefreshLease(env, opts.force === true);
  if (!lease.granted) {
    logInfo("browser-refresh: skipped", { reason: lease.reason });
    return { ok: false, reason: lease.reason };
  }

  logInfo("browser-refresh: starting");
  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    // Match the Chrome header stack we use for API calls, so the login flow
    // fingerprints identically to normal browsing. Reuses CHROME_UA rather
    // than a second literal so the fingerprint cannot drift across call sites.
    await page.setUserAgent(CHROME_UA);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });

    await page.goto("https://kagi.com/signin", {
      waitUntil: "networkidle2",
      timeout: 30_000,
    });

    // Selectors verified against live kagi.com/signin markup:
    //   <input id="signInEmailBox" name="email" type="text">
    //   <input id="signInPassBox"  name="password" type="password">
    //   <button type="submit"> inside <form id="signInForm" action="/login">
    await page.waitForSelector("#signInEmailBox", { timeout: 15_000 });
    await page.type("#signInEmailBox", env.KAGI_EMAIL, { delay: 20 });
    await page.type("#signInPassBox", env.KAGI_PASSWORD, { delay: 20 });

    // Submit and wait for the redirect off /signin. Kagi redirects to a
    // logged-in landing page on success; on failure it stays on /signin
    // with an error banner, which we detect after navigation settles.
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 25_000 }),
      page.click('#signInForm button[type="submit"]'),
    ]);

    const finalUrl = page.url();
    if (finalUrl.includes("/signin")) {
      // Still on the sign-in page → login failed. Grab any visible error
      // via evaluate() (which lets us use a plain string callback and dodge
      // Puppeteer's Element typing).
      const errRaw = await page
        .evaluate(
          `document.querySelector(".login-form .error, .form-error, .alert")?.textContent?.trim() ?? ""`,
        )
        .catch(() => "");
      const errText = typeof errRaw === "string" ? errRaw : "";
      const reason = errText
        ? `login failed: ${errText}`
        : "login failed: stayed on /signin (bad credentials or captcha)";
      logWarn(`browser-refresh: ${reason}`);
      return { ok: false, reason };
    }

    const cookies = await page.cookies("https://kagi.com");
    const session = cookies.find((c) => c.name === "kagi_session");
    await browser.close();
    browser = undefined;

    if (!session?.value) {
      logWarn("browser-refresh: kagi_session cookie missing after login");
      return { ok: false, reason: "kagi_session cookie missing after login" };
    }

    await saveToken(env, {
      token: session.value,
      updatedAt: Date.now(),
      source: "browser-refresh",
      stale: false,
    });
    logInfo("browser-refresh: success", { landing: finalUrl });
    return { ok: true, token: session.value };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // `error`, not `msg` — logWarn spreads fields last, so a field named `msg`
    // would overwrite the log message and leave the line without context.
    logWarn("browser-refresh: failed", { error: msg });
    return { ok: false, reason: `refresh failed: ${msg}` };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
