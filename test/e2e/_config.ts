// Wiring shared by playwright.config.ts (which boots the server) and the specs
// (which talk to it). Kept in one module because a drift between the two would
// surface as a connection refusal or a 401 rather than as a failed assertion.

/**
 * Port for the E2E `wrangler dev`. Deliberately not wrangler's default (8787):
 * a dev server someone left running must never be mistaken for this one.
 */
export const E2E_PORT = 8799;

/** 127.0.0.1, not localhost — avoids the IPv6-first resolution coin flip. */
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * A fixture, not a secret. ADMIN_TOKEN is a `wrangler secret` in every real
 * environment; this value exists only so the local server has a bearer the
 * specs can present. It is passed on the wrangler command line rather than
 * written to .dev.vars, so a run leaves nothing behind on disk. Its blast
 * radius is nil: the E2E worker holds no Kagi credential and runs with
 * MAX_API_CENTS_PER_MONTH=0.
 *
 * Deliberately a constant rather than a per-run random value. Playwright
 * re-evaluates the config module in *every* worker process, so generating one
 * here would hand the runner and the workers different tokens and 401 every
 * authenticated request. Doing it safely needs globalSetup plus a side channel
 * — real complexity to randomise a value that guards nothing.
 */
export const E2E_ADMIN_TOKEN = "e2e-local-admin-token";
