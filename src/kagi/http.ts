// How a KagiError becomes an HTTP response — the REST half of ADR 0012.
//
// Both values below are functions of `kind` alone. That is the entire point.
// The mapping this replaced branched on the error *class* for the status and on
// the kind for the code, so the two disagreed whenever an error was thrown as
// the base class: `new KagiError("upstream", ...)` returned 500 while
// `new KagiUpstreamError(...)` returned 502, both carrying `kagi-upstream`.
//
// The MCP surface needs nothing from here. It has no status line, and its
// `error_kind` is the kind verbatim — which is exactly why the REST code is
// derived from the kind rather than written out: a reader converting between
// the two front doors applies one rule instead of consulting a table.

import type { KagiErrorKind } from "./errors.js";

/**
 * HTTP status for each error kind. A `Record` over the union rather than a
 * lookup with a default, so adding a kind without a status fails `typecheck`
 * instead of silently landing on a fallback — which is how `captcha` and
 * `timeout` ended up as 500s.
 */
export const KAGI_ERROR_STATUS: Record<KagiErrorKind, number> = {
  auth: 401,
  // Operator-actionable and temporary — CAPTCHA_WEBHOOK_URL exists to page
  // someone about exactly this — which is 503's meaning, not 502's.
  captcha: 503,
  parse: 502,
  // The parser ran but Kagi's markup moved under it. Same 502 as parse: the
  // gateway is fine, the upstream page is not what the parser expects. The
  // kind (and REST code) is what distinguishes "fix the parser" from a
  // generic parse failure. See ADR 0016.
  markup_changed: 502,
  upstream: 502,
  rate_limit: 429,
  budget_exceeded: 402,
  unsupported_in_mode: 400,
  confirm_required: 400,
  not_configured: 503,
  // A gateway whose upstream did not answer in time. 504 is the exact status;
  // the 500 this replaced was a fall-through, not a decision.
  timeout: 504,
};

/** REST `error.code` for a kind: the MCP `error_kind` with a prefix and dashes. */
export function restErrorCode(kind: KagiErrorKind): string {
  return `kagi-${kind.replaceAll("_", "-")}`;
}
