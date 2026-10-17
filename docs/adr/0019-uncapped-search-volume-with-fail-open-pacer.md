# ADR 0019 — Uncapped search volume with a fail-open 2/s pacer

**Status:** Accepted — 2026-10-14
**Partially supersedes:** [ADR 0013](0013-scoped-client-keys-and-searxng-get-search.md)
(the global budget defaults and fail mode; per-client RPD reasoning)

## Context

Scrape mode rides one personal Kagi subscription, so ADR 0013 bounded what
reaches kagi.com twice: per-client-key windows (`CLIENT_KEY_RPM` 10,
`CLIENT_KEY_RPD` 300) and a global upstream budget (`KAGI_CALLS_PER_SECOND` 2
paced, `KAGI_CALLS_PER_DAY` 600, `KAGI_CALLS_PER_MONTH` 15000, both refusing).
The budget failed closed when the Meter was unreachable, as ADR 0006 does for
the spend counter.

The owner directed that all SearXNG and kagi-shinobi search volume caps be
removed, keeping only the 2/s anti-ban throttle: agent search volume must not
be capped, while the per-second pacing that keeps the session human-scale
stays. Every volume window already treats 0 as disabled, so removal is vars
plus fallback defaults — but it changes the fail mode and defaults ADR 0013
documents, which this record corrects.

## Decision

- `CLIENT_KEY_RPM`, `CLIENT_KEY_RPD`, `KAGI_CALLS_PER_DAY`,
  `KAGI_CALLS_PER_MONTH` default to `0` (disabled) in `wrangler.jsonc` and in
  the `readVar`/`readClientLimits` fallbacks. `KAGI_CALLS_PER_SECOND` stays 2.
- `takeKagiCall()` fails **open** when the Meter is unreachable: with the
  volume caps gone, all callers share only the per-second pacer, so a dead
  counter must not take search down with it.
- The fail-open path paces through an **isolate-local slot queue** at the
  configured per-second rate: each admitted call takes the later of now and
  the next free slot, advances it by one quantum (`1000/perSecond`), and
  sleeps until its slot. A call whose wait would pass `MAX_PACE_WAIT_MS`
  (3 s, the same bound as the Meter-backed pacer) is refused with
  `KagiRateLimitError`. A flat pause was rejected: concurrent callers all
  waited the same pause and hit Kagi together, which paces nothing.
- Paid-API spend still fails closed in `kagi/api/cost.ts`
  (`MAX_API_CENTS_PER_MONTH` stays 0). This decision covers scrape-mode call
  volume only, not billable spend.

## Consequences

- Agent search volume is uncapped on one Kagi Pro session; the 2/s pacer plus
  SearXNG result merging is the remaining ban protection.
- A Meter outage degrades to isolate-local pacing, not global pacing:
  callers on different isolates can still burst together. Acceptable because
  the alternative (fail-closed) takes search down entirely, and the outage
  itself is the rare path.
- ADR 0013's Consequences reasoning no longer holds: per-client RPD 300 is
  gone, so nothing sits "below the global day" anymore, and the budget no
  longer fails closed.
- Rollback: revert the commit, or set the four vars back to 10 / 300 / 600 /
  15000 and redeploy. Re-enabling a window restores its Meter enforcement
  with no code change.
