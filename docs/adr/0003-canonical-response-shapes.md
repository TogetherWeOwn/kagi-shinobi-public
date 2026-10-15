# ADR 0003 — Canonical response shapes

**Status:** Accepted — 2026-07-11

## Context

Two implementations of every capability (scrape + api) must return
comparable data so downstream MCP tools don't branch on impl.

## Decision

- Every KagiClient method returns a canonical type from
  `src/kagi/types.ts` — `SearchResponse`, `FastGPTResponse`,
  `SummarizeResponse`, `ExtractResponse`, `EnrichResponse`,
  `LensListResponse`, `RankResponse`.
- Each carries a `meta: MetaBlock` with `impl`, `cache_hit`, `elapsed_ms`,
  optional `cost_cents`, `trace_id`, `session_stale`, `refresh_triggered`,
  `warnings[]`.
- Impl-specific extras (v1 buckets, RSS metadata) go under `props?`.
- Every MCP tool emits `structuredContent` per the 2025-06-18 spec
  containing the canonical shape, alongside the legacy `content[0].text`
  for backwards compatibility with clients that grep text.

## Consequences

- New tools consume canonical types without knowing the impl.
- Adding a new impl (e.g. a hypothetical future MCP-native Kagi API)
  becomes a matter of writing a new adapter into `types.ts`.
- Divergences between impls are visible: any impl-specific field must
  either be normalized or live under `props`.
