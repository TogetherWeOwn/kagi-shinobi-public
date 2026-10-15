# ADR 0013 — Concise search output with stable citation ids and dedupe

**Status:** Proposed — 2026-10-01

## Context

`kagi_search_fetch` text output repeats a four-line block per result including
the filler `Published Date: Not Available` (scrape rarely provides dates), and
`structuredContent` re-emits the full canonical `SearchResponse` objects —
snippets, domains, thumbnails and all. For a 10-result search this is thousands
of characters per query, most of it filler or duplication. Multi-query calls
also repeat the same URL under different per-query numbers, so there is no
stable id an agent can cite across calls.

## Decision

- New optional input `response_format: concise | detailed`, default `concise`.
- **Concise text** is one citation line plus a short snippet per result:
  `[S1] Title — example.com (2025-01-01)` followed by a snippet of
  at most 240 chars (whitespace-collapsed, cut at a word boundary with `…`).
  The `(date)` group is omitted when `published_at` is absent — no filler.
  The snippet line is omitted when the snippet is empty. `[S<n>]` numbers run
  continuously across queries within one call, as today. The stable `ref`
  lives in the structured channel (agents needing cross-call citation
  stability resolve it there), keeping the text line short.
- **Stable `ref`**: `ref = sha1(normalized_url)[:10]` (hex). SHA-1 is a
  content key here, not security — 40 bits is plenty against accidental
  collision in a result set, and the prefix keeps citations short. Implemented
  as a small pure-TS function (pinned against RFC 3179 vectors) so formatting
  stays synchronous in both the Node and workerd runtimes.
- **URL normalization** before hashing and deduping: lowercase scheme+host,
  drop default ports, strip the fragment, drop tracking params (`utm_*`,
  `fbclid`, `gclid`, `gbraid`, `wbraid`, `msclkid`, `mc_cid`, `mc_eid`,
  `igshid`, `ttclid`, `twclid`, `yclid`, `dclid`, `pk_campaign`, `pk_kwd`,
  `piwik_*`, `matomo`, `_hsenc`, `_hsmi`, `hsCtaTracking`, `mkt_tok`,
  `vero_conv`, `vero_id`), sort the surviving params, drop a trailing slash on
  a bare root path. Unparseable input hashes as-is so the ref stays stable.
- **Cross-query dedupe**: within one call, results sharing a normalized URL
  collapse to the first occurrence; `dedup_dropped` counts the dropped ones.
  Applies in both formats — it is a correctness property of the citation set,
  not a verbosity setting.
- **Slim structuredContent** (concise): `{ response_format, mode, queries:
  [{ query, results: [{ id, ref, url, rank }], meta }], errors,
  dedup_dropped }`. No snippets, no filler — ids, urls, ranks, meta.
- **`outputSchema`**: `kagi_search_fetch` moves from the deprecated
  `server.tool()` overload to `server.registerTool()` so the slim shape is
  published and SDK-validated on every non-error call. No other tool changes
  registration method in this ADR.
- **Detailed** preserves the legacy text byte-for-byte (same headers,
  `Published Date: Not Available` filler included) and the full structured
  shape, plus `response_format` and `dedup_dropped` alongside. It is the
  escape hatch, not the future.
- Canonical `src/kagi/types.ts` is untouched: `ref`/dedupe live at the MCP
  format layer, not in the impl contracts. REST `/search` is untouched.

## Consequences

- The `mcp-schema-contract` snapshot changes deliberately: one new optional
  input (`response_format`) and one new `outputSchema` on `kagi_search_fetch`.
- `mcp-tools.test.ts` legacy-format assertions move to `detailed` mode; the
  fake server harness learns `registerTool`.
- Acceptance: median chars of the whole tool payload (text +
  `JSON.stringify(structuredContent)`) for a 10-result search drops ≥40% vs
  the frozen baseline on 20 fixed queries (pinned by
  `test/mcp/search-format-eval.test.ts`).
- Agents citing `[S<n>]` must re-resolve per call; agents citing `ref` get
  cross-call stability via the slim structured channel.
