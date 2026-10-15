# ADR 0014 — SearXNG fallback engine behind `engine=auto`

**Status:** Accepted — 2026-10-01
**Relates to:** [ADR 0001](0001-tri-mode-architecture.md) (the dispatcher this
sits above), [ADR 0003](0003-canonical-response-shapes.md) (the contract it
preserves), [ADR 0013](0013-scoped-client-keys-and-searxng-get-search.md) (the
GET /search view this consumes — see the merge note below)

## Context

Scrape mode rides one personal Kagi subscription, so Kagi traffic must stay
human-scale. A self-hosted SearXNG instance is free and unlimited but noisier. Today every
search needs Kagi to answer: a dead session, a CAPTCHA, or a zero spend cap
(the standing default — `MAX_API_CENTS_PER_MONTH` stays 0) fails the whole
call even though a free fallback exists.

The parallel GET /search work (ADR 0013) *serves* SearXNG's `format=json`
shape (`{results:[{url,title,content,engine,...}]}`) so SearXNG's
`json_engine` can consume this worker. This change *consumes* that same shape
from the configured SearXNG instance — the two must stay in step.

## Decision

**`engine` is a tier above `impl`: `kagi` | `searxng` | `auto`.**

- `engine=kagi` (default) routes through the tri-mode dispatcher exactly as
  before. Zero behavior change for existing callers.
- `engine=searxng` goes to the new `SearxngClient`, which fetches SearXNG
  `format=json` and normalizes into the canonical `SearchResponse` with
  `source_impl: "searxng"`. Same schema, whichever engine served the query —
  `ImplKind` gains `"searxng"` for exactly this. The caller's `limit` is
  enforced client-side in `normalize`: SearXNG `format=json` has no `limit`
  param (paging is via `pageno`), so no inert param goes on the wire.
- `engine=auto` tries Kagi first and serves SearXNG on any `KagiError`
  (budget, auth, captcha, upstream, timeout), annotating `meta.warnings` with
  the Kagi failure kind. "Under budget and session healthy" is decided by the
  attempt, not by a pre-check: the spend guard and the session/token flow
  already throw on exactly those conditions, so a pre-check would duplicate
  their judgment and race it. Non-`KagiError` exceptions propagate — the
  fallback must not mask programming bugs.
- When SearXNG is unconfigured, or fails too, the caller gets the *original*
  Kagi error — the root cause, not the fallback's shadow.
- `impl` only applies under `engine=kagi`; pairing it with another engine is
  a 400 at REST, an `Error` in the facade. On MCP that `Error` lands in the
  per-query `Errors encountered` text block via `describeError`, not the
  `internal` envelope (the search handler has no try/catch — `kagiErrorMcp`
  only wraps the other tools). Search-only: summarize, extract,
  enrich, rank and small_web are untouched.

**Transport: operator-configured, never a hardcoded host.** The SearXNG instance
is reached via the `SEARXNG_BASE_URL` var (a Tunnel hostname fronted by Access,
or a VPC-adjacent binding — a hostname, never an IP) plus the optional
`SEARXNG_ACCESS_CLIENT_ID` / `SEARXNG_ACCESS_CLIENT_SECRET` secrets, sent as
`CF-Access-*` headers. No code in this change knows a concrete instance address;
the actual instance wiring (secret values, Access policy) is operator deployment
work through the gated deploy path.

## Consequences

- With the Kagi budget at 0, every search succeeds via SearXNG with the same
  schema: in api mode the spend guard throws `budget_exceeded` and auto falls
  over; in scrape mode a dead session throws `auth`/`not_configured` and auto
  falls over the same way. That is the acceptance test.
- SearXNG responses carry a standing `meta.warnings` line naming the
  fallback, so no caller mistakes noisier results for Kagi's. Auto adds the
  Kagi failure kind that triggered it.
- `GET /search?q=&format=json` stays a *view* over `client.search` with the
  default engine (`kagi`); the `engine` param lives on `POST /search` and
  `kagi_search_fetch` only. The view currently hardcodes each result's
  `engine` field to `"kagi"` — mapping it from the canonical `source_impl`
  instead is a follow-up, not this card.

## Alternatives considered

- **Pre-check budget + session health before choosing.** Two extra reads
  (Meter snapshot, token envelope) that can both go stale between the check
  and the call — and the spend reservation is only atomic at admission, so a
  snapshot can admit what admission refuses. Trying Kagi first is the check.
- **A separate `kagi_search_searxng` tool instead of a param.** One more tool
  in tools/list for what is the same operation with a different upstream.
  Every existing caller would need to learn the new name; a defaulted param
  keeps them working.
- **Serve SearXNG results in SearXNG's own shape.** Rejected by ADR 0003's
  whole premise: downstream tools never branch on the producer. The canonical
  shape absorbs the difference; the per-engine name survives in `props`.

## Merge note

ADR 0013 landed as #41 while this card was in flight; this branch rebased
onto it. The numbering stands (0013 = the GET /search producer, 0014 = this
consumer). Verified on rebase: the landed GET shape
(`{query, number_of_results, results:[{url,title,content,engine,...}],
answers, suggestions}`) matches what `normalizeSearxngResponse` consumes —
the pair matches by convention, not by import, so any future change to one
must re-check the other. The landed global Kagi call budget (ADR 0013's
`takeKagiCall`) composes with `engine=auto`: it throws `KagiRateLimitError`
(a `KagiError`), so an exhausted call budget falls over to SearXNG exactly
like any other Kagi-side refusal.
