# ADR 0007 — Bound the token cache to KV's propagation window, coordinate refreshes in the Meter

**Status:** Accepted — 2026-08-06
**Relates to:** [ADR 0006](0006-serialize-rate-and-spend-counters.md) (same DO, same fail-closed stance)

## Context

`src/token/store.ts` kept the session-token envelope in a module-level
`memoryCache` with a **5-minute** TTL. Module scope in Workers is per isolate,
and nothing invalidates that cache across isolates, so the TTL was the blast
radius of a token rotation:

1. An operator rotates the token via `POST /admin/token`. One isolate handles
   the write; its cache is updated write-through.
2. Every other isolate keeps its own copy — including the superseded envelope's
   `stale: true` flag — for up to five minutes.
3. `currentToken()` in `src/kagi/scrape/index.ts` reads `stale: true` as a
   reason to call `refreshTokenViaBrowser()`.
4. `inflight` in `src/token/refresh.ts` coalesces refreshes, but it is also a
   module global — **per isolate**. Each isolate therefore launches its own
   Browser Rendering session, all of them redundant, because a perfectly good
   token is already in KV.

Browser Rendering is billable and capped at a small number of concurrent
sessions per account, so the stampede costs money and then starts failing.

This was finding #7 of the production audit. Finding #6 (`/health` leaking token
state) was fixed separately.

## Constraints discovered

Checked against Cloudflare's KV documentation rather than assumed:

- KV caches reads **per colo** with a default `cacheTtl` of 60s; the minimum
  accepted value is 30s.
- A write becomes visible in other locations in **up to 60s** — "or the duration
  of the `cacheTtl`".
- There is no cache-bypass read. **A <=60s staleness window is irreducible at
  the KV layer.**

## Decision

### 1. `CACHE_TTL_MS` 5 minutes -> 60 seconds

60s is KV's own propagation floor. Above it, the isolate cache is strictly worse
than reading KV directly. Below it, the extra reads buy nothing, because KV
would serve a cached value anyway. The number is therefore not a tuning knob —
it is pinned to a platform property.

`test/token/store.test.ts` hard-codes the 60s bound rather than importing
`CACHE_TTL_MS`, so widening the constant fails the suite.

### 2. The cache is kept, not deleted

Deleting it is the obvious simplification and it is wrong. `saveToken` writes
through the cache, and that write-through is what stops the isolate that *just*
refreshed from reading its own pre-refresh value back out of KV's colo cache and
refreshing again. Removing the cache would trade a bounded cross-isolate
staleness window for a self-inflicted refresh loop.

### 3. A global refresh lease in the `Meter` Durable Object

`Meter.tryRefreshLease(nowMs, leaseMs, force)` — one more synchronous method on
the DO from ADR 0006, backed by a `lease(name TEXT PRIMARY KEY, until INTEGER)`
table and addressed at `idFromName("refresh")`. It is the cross-isolate half of
`inflight`: within the lease window, exactly one caller anywhere may launch a
browser.

- **Taking the lease is the commitment, not succeeding.** A caller that takes it
  and then fails to log in still blocks the next caller for the full window. A
  failing login (bad credentials, captcha) is precisely the case where retrying
  from every isolate does the most damage.
- **Lease duration is the same 60s**, for the same reason as the cache TTL: it
  is how long a rotation can stay invisible, so it is exactly how long a second
  refresh would be redundant.
- **`force` for `POST /admin/refresh`.** An operator asking for a refresh
  explicitly must not be turned away behind an automatic attempt. A forced call
  still writes the lease, so everyone else backs off behind the operator.
- **Fails closed.** If the Meter is unreachable we cannot coordinate, and an
  uncoordinated refresh is the thing being prevented — so no browser is
  launched. Same stance ADR 0006 takes for the spend counter. `POST
  /admin/token` needs no DO and remains the escape hatch.
- The lease check runs **after** the free config checks, so an unreachable Meter
  cannot mask a plain misconfiguration ("auto-refresh disabled").

## Consequences

- A rotation is invisible to a non-writing isolate for <=60s instead of <=5min.
- Within that window, at most one browser refresh runs account-wide instead of
  one per isolate.
- Requests arriving in the window on an isolate whose refresh was refused serve
  the stale token and surface `401 kagi-token-stale`, rather than paying for a
  redundant browser session. The window heals itself as KV propagates.
- A Meter outage disables auto-refresh entirely. Manual rotation via
  `POST /admin/token` still works.
- `Meter` now owns three concerns (rate, spend, refresh coordination). Splitting
  it would mean a second DO class and a migration for no behavioral gain; the
  methods share no state.

## Alternatives considered

- **Delete the isolate cache and rely on KV alone.** Rejected: loses the
  write-through that prevents an isolate from re-refreshing against its own
  pre-refresh value. See decision 2.
- **Store the token itself in the DO** so a caller denied the lease could still
  fetch the fresh token immediately, eliminating the residual 401 window.
  Rejected for now: it puts the session token in a second store, widening where
  a credential lives, to save <=60s of already-degraded behavior. Revisit if the
  401 window proves to matter in practice.
- **Shorten the cache to a few seconds.** Rejected: it does not remove the
  stampede (KV is still 60s stale) and multiplies KV reads for no gain.
- **A KV-based lease.** Rejected for the reason in ADR 0006 — KV has no
  compare-and-swap, so two isolates would both read "free" and both proceed.
  That is the exact race this ADR exists to close.
