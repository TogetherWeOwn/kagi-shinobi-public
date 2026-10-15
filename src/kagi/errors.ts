// Errors thrown by the Kagi client. Distinguished so the token manager can
// decide whether to trigger a refresh, and so MCP tools can map them onto a
// stable `error_kind` field for callers.

// A runtime array rather than a bare union, so both the HTTP mapping in
// ./http.ts and its tests can iterate every kind. "For every kind" is a claim
// worth testing exhaustively; a union alone can only be sampled by hand, which
// is how the REST mapping drifted in the first place. See ADR 0012.
export const KAGI_ERROR_KINDS = [
  "auth",
  "captcha",
  "parse",
  "markup_changed",
  "upstream",
  "rate_limit",
  "budget_exceeded",
  "unsupported_in_mode",
  "confirm_required",
  "not_configured",
  "timeout",
] as const;

export type KagiErrorKind = (typeof KAGI_ERROR_KINDS)[number];

export interface KagiErrorDetail {
  status?: number;
  status_text?: string;
  retry_after?: number;   // seconds
  [key: string]: unknown;
}

/** Base class every Kagi-side error inherits from. */
export class KagiError extends Error {
  constructor(
    public kind: KagiErrorKind,
    msg: string,
    public detail: KagiErrorDetail = {},
  ) {
    super(msg);
    this.name = "KagiError";
  }
}

export class KagiAuthError extends KagiError {
  constructor(msg = "Invalid or expired session token") {
    super("auth", msg);
    this.name = "KagiAuthError";
  }
}

export class KagiCaptchaError extends KagiError {
  constructor(msg = "Kagi login blocked by a challenge") {
    super("captcha", msg);
    this.name = "KagiCaptchaError";
  }
}

export class KagiUpstreamError extends KagiError {
  constructor(public status: number, public statusText: string) {
    super("upstream", `HTTP ${status}: ${statusText}`, { status, status_text: statusText });
    this.name = "KagiUpstreamError";
  }
}

export class KagiParseError extends KagiError {
  constructor(msg: string, detail: KagiErrorDetail = {}) {
    super("parse", msg, detail);
    this.name = "KagiParseError";
  }
}

// The search page (HTTP 200) carried results-page markers but yielded zero
// parsed results — Kagi renamed or restructured its markup. A subclass of
// KagiParseError, not a sibling, so existing `instanceof KagiParseError`
// guards keep catching it while `kind` distinguishes breakage ("fix the
// parser") from a genuine parse failure. See the guard in ./search.ts.
export class KagiMarkupChangedError extends KagiParseError {
  constructor(msg: string, detail: KagiErrorDetail = {}) {
    super(msg, detail);
    this.kind = "markup_changed";
    this.name = "KagiMarkupChangedError";
  }
}

export class KagiRateLimitError extends KagiError {
  constructor(retryAfter: number, msg = "Rate limit exceeded") {
    super("rate_limit", msg, { retry_after: retryAfter });
    this.name = "KagiRateLimitError";
  }
}

export class KagiBudgetExceededError extends KagiError {
  constructor(spent_cents: number, cap_cents: number) {
    super(
      "budget_exceeded",
      `API cost cap reached (${spent_cents}¢ of ${cap_cents}¢ this month)`,
      { spent_cents, cap_cents },
    );
    this.name = "KagiBudgetExceededError";
  }
}

export class KagiUnsupportedInModeError extends KagiError {
  constructor(tool: string, mode: string) {
    super(
      "unsupported_in_mode",
      `Tool '${tool}' is not available in mode='${mode}'`,
      { tool, mode },
    );
    this.name = "KagiUnsupportedInModeError";
  }
}

export class KagiConfirmRequiredError extends KagiError {
  constructor(msg: string, detail: KagiErrorDetail = {}) {
    super("confirm_required", msg, detail);
    this.name = "KagiConfirmRequiredError";
  }
}

export class KagiNotConfiguredError extends KagiError {
  constructor(msg: string) {
    super("not_configured", msg);
    this.name = "KagiNotConfiguredError";
  }
}

export class KagiTimeoutError extends KagiError {
  constructor(ms: number) {
    super("timeout", `Timeout after ${ms}ms`, { ms });
    this.name = "KagiTimeoutError";
  }
}
