# ADR 0005 — Per-bearer rate limiting

**Status:** Superseded by [ADR 0006](0006-serialize-rate-and-spend-counters.md) — 2026-08-06
(originally Accepted — 2026-07-11)

> **Correction.** Two statements below are wrong and were corrected in ADR 0006.
> The Decision says "increment-then-check"; the code did check-then-increment.
> The Consequences say KV eventual consistency makes the worker *over*-count
> ("over-throttle, not under-throttle") — the read-then-write actually
> **under**-counted, admitting 20 of 20 concurrent requests against a limit of 5.

## Context

A single leaked or misconfigured bearer token can flood the worker with
requests, either exhausting the monthly Kagi API budget or triggering
upstream throttling. We want a soft cap that catches runaways without
requiring per-endpoint quotas.

## Decision

- KV-backed sliding window keyed by `rl:<sha256_16(bearer)>:<epoch minute>`
  with a 90-second TTL. Simple counter; increment-then-check.
- Limit configured by the `PER_BEARER_RPM` env var (default 60). Setting
  it to 0 disables the check.
- Bearer tokens are SHA-256'd before use as a key — the raw value never
  hits KV or logs.
- Admin endpoints (`/admin/*`) bypass the check so an operator can reset a
  runaway automation without competing for the quota.
- Returns `429 Too Many Requests` with `Retry-After`, `X-RateLimit-Limit`,
  and `X-RateLimit-Remaining` headers.

## Consequences

- KV eventual consistency means the worker may over-count under bursty
  concurrent load; we accept this as a safe direction (over-throttle, not
  under-throttle).
- One-minute buckets are coarse; sub-minute traffic still hits Kagi at
  full rate until the counter crosses `PER_BEARER_RPM`.
- Full protection against sustained abuse requires Kagi's own paid-plan
  quota + Cloudflare's rule-set — this ADR covers the last line of
  application-level defense, not the whole stack.
