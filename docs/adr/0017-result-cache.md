# ADR 0017 — Read-through result cache that works on workers.dev

**Status:** Accepted — 2026-10-02
**Relates to:** [ADR 0003](0003-canonical-response-shapes.md) (the `meta` contract
it extends), [ADR 0006](0006-serialize-rate-and-spend-counters.md) (the DO
serialization pattern it reuses), [ADR 0013](0013-scoped-client-keys-and-searxng-get-search.md)
(the Kagi call budget it preserves), [ADR 0014](0014-searxng-fallback-engine.md)
(the engine tier the key includes)

## Context

`src/kagi/cache.ts` was dead code: nothing in `src/` called it, and the Cache
API does not operate on `*.workers.dev`, so every agent query hit Kagi. The
owner verified on 2026-10-01 that the Cache API **does** work on the attached
custom domain (the production domain attached in `wrangler.jsonc`), and corrected the account tier: Workers
Paid + R2 Paid + Cache Reserve, not free tier. Quotas are not the constraint,
but new usage-based spend stays minimal and is noted in the PR.

## Decision

**Two layers: Cache API as best-effort L1, one `ResultCache` Durable Object
(DO-SQLite) as authoritative L2.**

- L1 is per-colo and free to read; it misses (or throws) on `workers.dev` and
  the code treats that as an ordinary miss. L2 answers everywhere, including
  `workers.dev`, and is the only layer the correctness argument depends on.
- Key: `sha256(domain|engine|normalized args)` — the card's formula, where
  "normalized args" is the full resolved arg object **including `impl`**
  (scrape vs api results differ in `source_impl` and cost, so omitting it would
  serve a scrape result to an api caller; defaults applied and string values
  trimmed so `{q}` and `{q, limit: 10}` share a key).
- TTLs per the card, replacing the old file's values: **search 24 h, fastgpt
  6 h, summarize 7 d.** Only those three domains are cached. Extract/enrich
  are per-URL metadata chains for downstream composition, rank is account
  personalization that must stay live, and Small Web browse is a free RSS feed —
  caching any of them buys little and risks serving stale composed state.
- **Single-flight in the DO, not in a module map.** `refresh.ts`'s `inflight`
  map only coalesces within one isolate; ten identical queries landing on
  different isolates would each miss and hit Kagi. `ResultCache.acquire()` is
  synchronous end to end (like every `Meter` method — no `await` between read
  and write) and answers `hit`, `claimed` or `pending`, so exactly one caller
  wins a cold key. The winner fetches, then `store()`s (or `release()`s on
  error / unstorable response); losers re-`acquire()` with backoff (25 ms
  doubling to 500 ms) until the entry lands. A claim is a **30 s lease**: a
  winner that crashes stalls its losers at most that long, after which the
  next poller takes the claim over. Losers also stop after lease + 5 s and
  fetch themselves, so a misbehaving store cannot hang a request. There is no
  isolate-local promise map: the DO alone carries the guarantee.
- `meta.cache_hit` (existing) and new `meta.cache_age_s` (seconds since the
  upstream fetch; absent on miss). A hit reports `elapsed_ms` for the fast
  path and `cost_cents: 0` when the stored response carried a cost — the spend
  was settled at fetch time (Meter is untouched by hits), so claiming the old
  cost again would mislead per-call accounting. `refresh_triggered` and
  `session_stale` are dropped on a hit: they describe the upstream call that
  filled the entry, not this one.
- What is **not** stored: an `engine=auto` response served by the SearXNG
  fallback (it would pin the fallback for 24 h after Kagi recovers), and any
  body over 512 KB (DO-SQLite caps a row at 2 MB; `kagi_summarize_text` can
  echo 1 MB of input). Both are returned normally and the claim released.
- `confirm_muriel` is **not** in the summarize key. It is a spend gate, not a
  result-shaping arg; a cached muriel summary costs nothing to serve, and an
  uncached one still hits the gate in the api impl.
- `max_age_s` param on the three cached domains (five MCP tools; REST
  `POST /search`, `GET /search`, `POST /summarize`): entries older than it are
  treated as misses; **`max_age_s=0` skips the read, fetches fresh, and still
  stores** (refreshes the entry for the next caller). `kagi_fastgpt`'s
  existing `cache: false` means the same as `max_age_s=0`.
- Cached responses never touch `takeKagiCall` or `guardBillable` — both live in
  the impls below the facade, and the facade returns before invoking them. A
  repeat query within TTL therefore makes 0 Kagi calls and consumes 0 budget.
- **Hourly purge cron** (`0 * * * *` → `scheduled()` → `ResultCache.purge()`).
  Kagi results stay transient: nothing survives past its TTL, and the loser
  path lazily deletes expired rows on read.
- **Hit rate via a `kagi://cache-stats` MCP resource** (`hits`, `misses`,
  `stores`, `entries`, `hit_rate`, per-domain breakdown). `misses` counts
  winning claims, i.e. upstream fetches the cache let through; losers that
  waited and then hit count as hits. L1 hits increment the DO counter
  explicitly, otherwise the fast path would make the stats lie. Counters are
  cumulative: purge deletes entries, never counts.
  A missing/broken binding fails open (fetch direct) — the cache is an
  optimization and must never break serving.

## Consequences

- `MetaBlock` gains optional `cache_age_s`; five MCP tool input schemas gain
  optional `max_age_s`; the tools/list + outputSchema snapshots change
  accordingly (regenerated, diff reviewed).
- New `RESULT_CACHE` binding and a `v4` SQLite migration; `scheduled()` handler
  on the worker export; the dead `src/kagi/cache.ts` and its test are removed.
- Cost on Workers Paid: about one to two DO requests per cached-surface call
  (one `acquire`, plus one `store` on a miss or one `recordHit` on an L1 hit),
  plus one per hourly purge. At the `KAGI_CALLS_PER_MONTH` scale (15 000) that
  is well inside the plan's included 1 M DO requests and SQLite row/storage
  allowances — expected marginal spend ≈ $0.
- Tests: key derivation/normalization/TTLs in the unit project; DO atomicity
  (concurrent claims, expiry, purge, stats) plus facade read-through
  (hit/miss/bypass, 10-concurrent → 1 upstream, 0 Kagi calls on repeat) in the
  workers project.

## Alternatives considered

- **D1 instead of DO-SQLite.** Same durability, but the claim would need a
  read-then-write round-trip through the D1 HTTP API with no compare-and-swap —
  the exact race ADR 0006 moved the counters into a DO to close. DO-SQLite
  keeps claim atomic.
- **Folding the table into `Meter`.** No new binding or migration, but Meter's
  contract is protective counters; mixing a best-effort cache into the fail-
  closed budget path risks one taking down the other. Separate DO, separate
  blast radius.
- **Cache API only (custom-domain-only).** Keeps `workers.dev` clients hitting
  Kagi on every query — the bug this card fixes. L2 exists so the fix holds on
  every route clients actually use.
