// Mode resolution for the tri-mode dispatcher.
//
// Explicit KAGI_MODE wins; when it's "auto" (the resolver default when the
// var is unset), we pick based on which credentials the operator configured.
// The whole point of "auto" is that a fresh deploy with only KAGI_SESSION_TOKEN
// keeps working exactly like the original single-mode server, and adding
// KAGI_API_KEY flips it to hybrid without any config file edit.

import type { Env } from "../env.js";
import { KagiNotConfiguredError } from "./errors.js";

export type KagiMode = "scrape" | "api" | "hybrid";
export type KagiModeInput = KagiMode | "auto";

export interface ModeResolution {
  mode: KagiMode;
  reason: string;
  has_session: boolean;
  has_api_key: boolean;
}

/**
 * Resolve the active mode from env. Throws when neither credential is present
 * and the operator hasn't explicitly asked for a mode — better to fail cold
 * than to accept every call and 500 on the first tool invocation.
 */
export function resolveMode(env: Env): ModeResolution {
  const raw = (env.KAGI_MODE ?? "auto").trim().toLowerCase() as KagiModeInput | string;
  const has_session = Boolean(env.KAGI_SESSION_TOKEN && env.KAGI_SESSION_TOKEN.length > 0);
  const has_api_key = Boolean(env.KAGI_API_KEY && env.KAGI_API_KEY.length > 0);

  if (raw === "scrape") {
    return { mode: "scrape", reason: "KAGI_MODE=scrape", has_session, has_api_key };
  }
  if (raw === "api") {
    return { mode: "api", reason: "KAGI_MODE=api", has_session, has_api_key };
  }
  if (raw === "hybrid") {
    return { mode: "hybrid", reason: "KAGI_MODE=hybrid", has_session, has_api_key };
  }
  if (raw !== "auto") {
    // Typed, not plain Error: an invalid mode is an operator-fixable setup
    // problem, so clients must see the actionable message (ADR 0012
    // not_configured -> 503), not a genericized internal failure.
    throw new KagiNotConfiguredError(
      `Invalid KAGI_MODE='${env.KAGI_MODE}' — must be one of scrape|api|hybrid|auto`,
    );
  }

  // auto
  if (has_session && has_api_key) {
    return { mode: "hybrid", reason: "auto: both credentials present", has_session, has_api_key };
  }
  if (has_session) {
    return { mode: "scrape", reason: "auto: only session token", has_session, has_api_key };
  }
  if (has_api_key) {
    return { mode: "api", reason: "auto: only API key", has_session, has_api_key };
  }
  throw new KagiNotConfiguredError(
    "No Kagi credentials configured — set KAGI_SESSION_TOKEN or KAGI_API_KEY (or both), " +
      "or set KAGI_MODE=scrape and inject a token via POST /admin/token.",
  );
}
