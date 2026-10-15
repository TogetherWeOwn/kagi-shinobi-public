// CAPTCHA-aware refresh helpers.
//
// The Puppeteer login flow in src/token/refresh.ts calls in here when it
// detects a Turnstile / CAPTCHA challenge that prevents automated login.
// We post to CAPTCHA_WEBHOOK_URL so the operator can log in manually before
// the token gets much staler.

import type { Env } from "../env.js";
import { logWarn } from "../util/log.js";

/** Heuristic selectors that signal an unattended-login-blocked challenge. */
export const CAPTCHA_SELECTORS = [
  'iframe[src*="turnstile"]',
  'iframe[src*="captcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="recaptcha"]',
  'input[name="cf-turnstile-response"]',
  '.cf-turnstile',
];

export interface CaptchaAlertPayload {
  ts: string;
  reason: string;
  hint?: string;
}

/** POST to CAPTCHA_WEBHOOK_URL, if set. Never throws — just logs on failure. */
export async function notifyCaptcha(env: Env, payload: CaptchaAlertPayload): Promise<void> {
  const url = env.CAPTCHA_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Field name is `error`, not `msg`: logWarn spreads fields last, so a
    // field called `msg` overwrites the log message itself and the line loses
    // all its context.
    logWarn("captcha webhook failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
