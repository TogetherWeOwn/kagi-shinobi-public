# ADR 0001 — Tri-mode architecture (scrape / api / hybrid)

**Status:** Accepted — 2026-07-11
**Deciders:** @Rick7C2

## Context

kagi-shinobi wraps Kagi's user-facing search + summarizer via an HTML scraper
that authenticates with a `kagi_session` cookie. Kagi also publishes a paid
REST surface at `api.kagi.com` (two roots: `/v1/search`, `/v1/extract`, and
the older `/v0/{fastgpt,summarize,enrich/web,enrich/news}`) that reaches
endpoints the scraper cannot: Enrich, the Universal Summarizer engine picker,
raw-text summarization, per-request personalization rules.

We want the same worker to serve operators who have neither, either, or both
credentials, without a fork.

## Decision

The client is a facade (`src/kagi/client.ts`) with two implementations
(`src/kagi/scrape/*` and `src/kagi/api/*`). A single dispatcher picks the
implementation per call based on a `KAGI_MODE` var and a capability matrix
(`src/kagi/capability.ts`).

- **`scrape`** — session cookie only. API-only tools are hidden from `tools/list`.
- **`api`** — official API only. Scrape-only tools are hidden.
- **`hybrid`** — scrape for anything the scraper can do; API for anything else. Callers can override with an `impl` param on tools where both work.
- **`auto`** (default resolver) — `scrape` if only the session is set, `api` if only the key is set, `hybrid` if both are set, fatal error if neither.

The **on-disk default** is `scrape` — safe for the common case where no API
key is configured, and it preserves the current behavior.

Both implementations normalize into canonical response types in
`src/kagi/types.ts`; downstream MCP tools never branch on impl.

Cost is bounded by a monthly cap (`MAX_API_CENTS_PER_MONTH`, default `0`).
Every API call debits a KV counter; when the cap is reached, further API
calls throw `KagiBudgetExceededError` and are surfaced to the caller as a
structured `error_kind: "budget_exceeded"`.

## Consequences

**Positive**
- New tools consume canonical types; they don't need to know which impl is
  active.
- Operators without an API key still get value.
- Accidental spend is impossible by default (cap is 0).
- Feature flags graduate cleanly: a scrape-only tool becomes hybrid once its
  API path lands.

**Negative**
- Normalization adds a shim between wire responses and MCP output.
- Two implementations for the same feature = doubled test surface.
- The dispatcher is now a load-bearing seam; a bug there affects every tool.

## Related

- ADR 0002 — Session-cookie stack + auto-refresh (planned).
- ADR 0003 — Canonical response shapes (planned).
- ADR 0004 — Deep-research async trio + Durable Object (planned).
- ADR 0005 — Per-bearer rate limiting (planned).
