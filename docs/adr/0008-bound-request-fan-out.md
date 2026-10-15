# ADR 0008 — Bound per-request fan-out at both front doors

**Status:** Accepted — 2026-08-06
**Relates to:** [ADR 0005](0005-per-bearer-rate-limiting.md) and
[ADR 0006](0006-serialize-rate-and-spend-counters.md) (they bound a different
axis), [ADR 0001](0001-tri-mode-architecture.md) (the cost asymmetry between
modes is why this matters)

## Context

`PER_BEARER_RPM` limits how many **requests** a bearer may make per minute. It
says nothing about how many **upstream calls** a single request may spawn.

`/search` and `kagi_search_fetch` both accept a `queries` array and fan out one
concurrent Kagi call per entry:

```ts
const settled = await Promise.allSettled(
  normQueries.map((q) => withTimeout(client.search({ q, ... }), 15_000)),
);
```

Neither door had a ceiling. `src/rest.ts` rejected only the empty array; the
MCP schema was `z.array(z.string().min(1)).min(1)` with no `.max()`. So one
authorized request carrying 1,000 queries became 1,000 concurrent upstream
calls while counting as a single tick against the rate limit.

This was not theoretical. The regression test added alongside this ADR failed
with `Number of calls: 100` from a single request before the fix.

Three ways it hurts, one per mode:

- **api mode** — each `/v1/search` bills ~1.2¢. `MAX_API_CENTS_PER_MONTH`
  still caps the month (ADR 0006 made that counter atomic), so this cannot
  overspend the budget. It can, however, burn the entire monthly budget in a
  single request.
- **scrape mode** — free, which is worse. Nothing throttles it but Kagi, and
  the thing being rate-limited is the operator's own logged-in session. The
  failure mode is a banned account, and recovery is manual.
- **either mode** — Cloudflare caps subrequests per invocation (50 on the free
  plan, 1,000 on paid). Past the cap the invocation fails partway, after the
  earlier calls have already been made and, in api mode, already billed.

The codebase already treats bounded fan-out as the norm everywhere else:
`kagi_personalized_rank` caps `urls` at 20, `apiExtract` rejects more than 10
URLs, `scrapeRank` probes at most 5. `queries` was simply missed.

## Decision

**Cap `queries` at 20 per request, at both front doors.**

- `src/rest.ts` — `MAX_QUERIES_PER_REQUEST = 20`, checked immediately after the
  empty-array guard and before a `KagiClient` is constructed. Violations get
  `400 too-many-queries`, joining the existing `missing-queries` /
  `invalid-query` / `invalid-limit` codes.
- `src/mcp.ts` — `.max(20)` on the `kagi_search_fetch` schema. The MCP SDK
  validates against the schema before the handler runs, so the schema is the
  enforcement point; a check inside the handler would be dead code.

20 is chosen to match `kagi_personalized_rank`'s existing ceiling rather than
derived independently. Consistency between neighbouring tools is worth more
here than a precisely tuned number, and 20 sits comfortably under the free
plan's 50-subrequest cap with room for the retry-on-401 path to spend a second
call per query.

## Consequences

- A caller with more than 20 queries must split the batch. The error message
  says so and names the limit.
- The rate limit now bounds upstream load, not just request count: worst case
  per minute is `PER_BEARER_RPM × 20` instead of unbounded.
- The two front doors agree. A limit on only one of them would have been
  security theatre — the MCP surface is the one an agent drives, and therefore
  the one most likely to generate a large array without a human noticing.
- The bound is a ceiling, not a queue. This deliberately does not add batching
  or concurrency limiting; if a legitimate workload needs 200 queries, the
  right answer is a discussion about a work queue, not a bigger constant.

## Alternatives considered

- **Rate-limit by query count instead of request count.** Charge the limiter
  `n` ticks for `n` queries. More precise, and it would let a caller spend
  their whole minute on one big batch. Rejected for now: it needs a new Meter
  method and changes the meaning of `PER_BEARER_RPM` for every existing
  operator, to solve a problem a constant solves. Revisit if batching turns out
  to be a real usage pattern rather than a hypothetical one.
- **Semaphore the fan-out, no ceiling.** Run the queries at, say, 5 at a time
  and let the array be any length. Keeps concurrency safe but not total cost or
  wall-clock — a 1,000-query request would still bill 1,000 searches, just
  slowly, and would still blow the subrequest cap. Bounds the wrong axis.
- **Silently truncate to the first 20.** Rejected outright. The caller believes
  they searched 1,000 things and got an answer covering 20, with nothing in the
  response saying otherwise. Refusing loudly is the whole point — the same
  reasoning that makes `fetchSmallWebRss` throw on a feed that parses to zero
  entries rather than return an empty list.
- **Cap it only in REST, treating MCP's schema as the client's problem.** The
  schema is advisory to a well-behaved client and nothing else; an agent
  constructing the JSON-RPC payload directly is no more bound by it than curl
  is bound by the REST docs.
