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

// Our own reason phrases for upstream statuses. A remote `statusText` is
// attacker-influenced upstream text like a response body, and a typed
// error's message/detail are client-visible — so producers that hold a live
// Response must phrase it from this allowlist, never copy `res.statusText`.
// Direct construction with caller-owned text (a stream-level "[ERROR]"
// marker, a test double) is a separate contract and stays as-is.
const STATUS_PHRASES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export function safeStatusPhrase(status: number): string {
  return STATUS_PHRASES[status] ?? "Upstream error";
}

/** KagiUpstreamError for a live non-OK Response: numeric status only. */
export function upstreamErrorFromResponse(status: number): KagiUpstreamError {
  return new KagiUpstreamError(status, safeStatusPhrase(status));
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

/**
 * The only error text a client may ever see for a thrown value: a typed
 * KagiError's message (the ADR 0012 vocabulary, written for clients), or a
 * fixed generic string. Untyped Error messages and non-Error throws can
 * carry upstream bodies, paths, tokens or stack fragments, so they never
 * cross REST, MCP or research-step boundaries verbatim.
 */
export function safeErrorMessage(err: unknown): string {
  return err instanceof KagiError ? err.message : "Internal error";
}

/**
 * Cents a dispatched billable call owes the run ledger when it throws. The
 * monthly guard reserves the projected charge before dispatch and an
 * unsettled reservation stays on its books (see api/cost.ts), so ANY throw
 * after the guard admitted the call — an undecodable or null envelope, an
 * HTTP-error status, a transport rejection, or a normalization failure
 * after settle — is potentially billed and must book the projected cents.
 * Only the wrapper knows the guard admitted the call, so it tags the thrown
 * value with `withChargedCost` for budget-keeping callers (the research
 * pipeline) to book via `chargedCostCents`. A guard refusal itself throws
 * before any reservation or dispatch and is never tagged. First tag wins,
 * so an error crossing two tag sites is never re-priced. Non-enumerable:
 * the tag is bookkeeping, never part of a serialized error seen by clients.
 */
export function withChargedCost<T>(err: T, cents: number): T {
  if (chargedCostCents(err) !== undefined) return err;
  if (err !== null && (typeof err === "object" || typeof err === "function")) {
    try {
      Object.defineProperty(err, "charged_cost_cents", {
        value: cents,
        enumerable: false,
        configurable: true,
      });
    } catch {
      // A frozen thrown value cannot carry the tag; the original error
      // still propagates unchanged.
    }
  }
  return err;
}

export function chargedCostCents(err: unknown): number | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const value = (err as { charged_cost_cents?: unknown }).charged_cost_cents;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
