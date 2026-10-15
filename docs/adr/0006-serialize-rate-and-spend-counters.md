# ADR 0006 — Serialize the rate-limit and spend counters in a Durable Object

**Status:** Accepted — 2026-08-06
**Supersedes:** [ADR 0005](0005-per-bearer-rate-limiting.md)

## Context

Both protective counters were Workers KV read-then-write. Concurrent requests
read the same value and each wrote `value + 1`, so parallel calls advanced the
counter by one. Measured against the old implementation in workerd: **20 of 20
concurrent requests were admitted against a limit of 5.**

The error therefore ran toward *under*-counting, letting traffic and spend past
the limit. ADR 0005 recorded the opposite ("over-throttle, not under-throttle"),
and `ratelimit.ts` repeated the claim in its header comment. ADR 0005 also
described "increment-then-check" while the code did check-then-increment.

KV has no compare-and-swap, so the race cannot be closed at that layer.

The two counters have different stakes. `PER_BEARER_RPM` is a soft control on
every request; overshoot costs extra scrapes and risks the Kagi session token
being flagged. `MAX_API_CENTS_PER_MONTH` is a hard control on a low-volume path;
overshoot costs money, and it is the one constraint CLAUDE.md explicitly
protects.

## Decision

Both counters move into a single Durable Object class, `Meter`.

- **Rate**: one instance per bearer, `idFromName(sha256_16(bearer))`. Buckets
  shard naturally and each instance lands near the caller that created it.
- **Spend**: one global instance, `idFromName("spend")`.
- Every `Meter` method is synchronous end to end. `ctx.storage.sql` is a
  synchronous API and a DO processes one call at a time, so a method that never
  awaits between its read and its write is atomic. **Introducing an `await`
  inside these methods reopens the race.**
- Spend switches from call-then-debit to **reserve-then-settle**: the projected
  charge is debited at admission, and `settle(actual)` applies only the
  difference. A dropped settle leaves the reservation in place, which
  over-throttles — safe by design, and now actually true rather than merely
  claimed.

Public signatures (`checkAndIncrement`, `readLimit`, `guardBillable`,
`budgetSnapshot`, `readCap`, `readSpend`) are unchanged, so no call site moved.

## Alternatives considered

**Cloudflare's native Rate Limiting binding for the rate counter.** Purpose-built
and needs no DO hop. Rejected: the limit is configured statically in
`wrangler.jsonc` with no runtime override, which would break `PER_BEARER_RPM` as
an operator-tunable knob — it is set in `vars` and reported through the
api-status MCP resource (`src/mcp/resources.ts`). Changing a limit would become a
redeploy. The `period` field also accepts only 10 or 60 seconds. It is per-colo,
so it would not have bought stronger global guarantees than a DO either.

**A Durable Object for spend only, accepting the rate race.** Tempting, since
`MAX_API_CENTS_PER_MONTH=0` makes the money bug latent while the rate bug is
live. Rejected: the rate limiter protects a *scraped session token*, and a
flagged Kagi account is harder to recover from than an overspend.

**Keep KV and make the update atomic.** Rejected — KV offers no CAS primitive.

## Consequences

**Positive.** The spend cap is exact, so raising it above 0 is safe. Rate
limiting no longer writes to KV on the request path. Both mechanisms now behave
the way their documentation claims. Regression tests in `test/workers/` pin the
concurrency invariant, and they run against the real DO rather than a stub.

**Negative.** A DO round-trip is added to every gated request. This is
acceptable here: it is noise against a 500–2000 ms upstream Kagi call, and this
worker is a low-volume personal proxy. Adds a DO class and migration tag `v3`.
Counter state no longer survives a DO class deletion the way a KV key would.

**Risks.** The spend DO is a single serialization point for billable calls; if it
is unreachable, billable calls must **fail closed** and refuse, never fall back
to unmetered. `vitest-pool-workers`' `isolatedStorage` does not roll back
Durable Object SQL storage, so DO-backed suites must reset their own state
between tests or they become order-dependent.

## Verification (added 2026-08-07)

The fail-closed requirement above was asserted here and repeated in `cost.ts`'s
header, but for four sessions nothing checked it. It is now pinned:

- `test/kagi/api/billable-fail-closed.test.ts` — a table over all six billable
  endpoints. The assertion that matters is not the rejection but that `fetch` is
  never called: a refusal issued *after* the round-trip looks identical to the
  caller and is exactly the bug.
- `test/workers/cost.test.ts` → `describe("the Meter being unreachable")` —
  the same property at the `guardBillable` seam, against the real DO, plus the
  realistic partial failure where reserve succeeds and settle cannot get back.

The property held. Confirmed by mutation, not by reading: making `reserveSpend`'s
rejection fall through to an unmetered guard fails all 12 endpoint cases and 3 of
the guard cases; reverting restores them.

Two related findings came out of writing these:

- **There is no local short-circuit for a 0 cap.** `readCap` is local, but the
  cap is passed *into* `reserveSpend` and the refusal is decided inside the DO,
  so the default deny-everything configuration still pays a round trip per
  billable call. Left as-is — the error carries the DO's real `spent_cents`,
  which a local refusal could not report.
- **`apiSummarize` reserved before validating.** Its 1MB body check ran after
  `guardBillable`, so an oversized request reserved 30¢ and threw without
  settling — budget permanently burned on a call that never reached Kagi.
  Validation now precedes the reservation, as it already did in `apiExtract`.
