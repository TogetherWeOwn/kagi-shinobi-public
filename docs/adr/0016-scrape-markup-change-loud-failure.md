# ADR 0016 — Fail loudly when Kagi's search markup moves

**Status:** Accepted — 2026-10-01
**Relates to:** [ADR 0012](0012-one-error-vocabulary-two-envelopes.md)

## Context

`parseSearchResults` (`src/kagi/search.ts`) matched `.search-result` blocks and
returned `[]` when nothing matched. An empty list is also what a genuine
zero-results query produces, so the day Kagi renames a class the gateway keeps
answering success-with-no-results and nothing pages anyone. The Small Web feed
parser already learned this lesson the loud way — a well-formed feed that
parses to nothing throws "feed markup changed" (`src/kagi/scrape/smallweb.ts`)
— but the general search parser never got the same treatment.

Separately, `src/kagi/headers.ts` pinned Chrome 131 while the broadly-installed
stable was 154, and the login flow in `src/token/refresh.ts` carried a second
copy of the UA literal, so the two fingerprints could drift without any test
noticing.

## Decision

1. **New kind `markup_changed`, new subclass `KagiMarkupChangedError extends
   KagiParseError`.** A subclass, not a sibling: every existing `instanceof
   KagiParseError` guard keeps catching it, while `kind` distinguishes "fix the
   parser" from a generic parse failure in both envelopes. REST maps it to 502
   (same as `parse` — the gateway is fine, the upstream page is not what the
   parser expects); the REST code derives mechanically as `kagi-markup-changed`
   per ADR 0012, and MCP carries `markup_changed` as `error_kind` untouched.

2. **Guard placement: after extraction, before return.** When zero results
   parsed, no explicit no-results marker is present, and at least one
   results-page marker survives (`._0_main-search-results`, `.search-result`
   itself, `.sr-group`, `.related-searches`, `#load_more_results`), throw.
   `.search-result` is deliberately in the marker set: blocks that exist but
   yield no title+url (inner selectors renamed) are breakage, not emptiness. A
   genuine zero-results page carries an explicit marker and still parses to
   `[]`; bare HTML with neither keeps the old `[]` behavior.

3. **One fingerprint table.** `CHROME_VERSION` (154, the broadly-installed
   stable as of 2026-10-01) drives the UA and both `sec-ch-ua` version slots;
   `refresh.ts` reuses `CHROME_UA` instead of a second literal; a headers test
   pins UA/sec-ch-ua coherence so the table cannot go incoherent.

4. **Three recorded fixtures** (news-heavy, grouped, zero-results) so the suite
   distinguishes a real "no results" from breakage; the acceptance test deletes
   the selectors in a fixture and expects `markup_changed`.

## Alternatives considered

**A sibling error class.** Rejected: it would sail past every existing `catch
(e instanceof KagiParseError)` — the same class-vs-kind split ADR 0012 just
eliminated.

**Reusing kind `parse`.** Rejected: dashboards and callers could no longer tell
"upstream page changed shape" from "one response was malformed". The 502 stays
shared; the kind is what routes the fix.

**Snapshot or fuzzy matching of the page.** Rejected as complexity without a
decider: any similarity threshold still needs a human to confirm, and the guard
already fails into a human-actionable error.

## Consequences

**Positive.** A Kagi markup rename becomes a 502 `kagi-markup-changed` /
`markup_changed` instead of a silent empty success, on both surfaces, with no
change to any existing catch site. The fingerprint is one table, and the
coherence test fails the next bump that updates only half of it.

**Negative.** One new wire value on each surface; clients matching codes
exhaustively must handle it. The marker lists are heuristics — a redesign that
removes every marker at once returns `[]` silently again. The markers were
chosen as page chrome independent of the per-result selectors, so that failure
mode requires a full-page rewrite, not a class rename.
