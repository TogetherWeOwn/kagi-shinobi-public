# Architecture Decision Records

Add an ADR before changing tri-mode dispatch, response shapes, the async
research trio, or the protective counters. Supersede rather than edit: a
decision that turned out wrong is more useful with its correction attached
than quietly rewritten.

| ADR | Title | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-tri-mode-architecture.md) | Tri-mode architecture (scrape / api / hybrid) | accepted | 2026-07-11 |
| [0002](0002-scraped-session-vs-paid-api.md) | Scraped session vs. paid API | accepted | 2026-07-11 |
| [0003](0003-canonical-response-shapes.md) | Canonical response shapes | accepted | 2026-07-11 |
| [0004](0004-deep-research-async-trio.md) | Deep research async trio + Durable Object | accepted | 2026-07-11 |
| [0005](0005-per-bearer-rate-limiting.md) | Per-bearer rate limiting | superseded by 0006 | 2026-07-11 |
| [0006](0006-serialize-rate-and-spend-counters.md) | Serialize the rate-limit and spend counters in a Durable Object | accepted | 2026-08-06 |
| [0007](0007-bound-token-cache-and-coordinate-refresh.md) | Bound the token cache to KV's propagation window, coordinate refreshes in the Meter | accepted | 2026-08-06 |
| [0008](0008-bound-request-fan-out.md) | Bound per-request fan-out at both front doors | accepted | 2026-08-06 |
| [0009](0009-zod-4-and-the-tool-schema-wire-contract.md) | Upgrade to zod 4, and treat the tool schema as a wire contract | accepted | 2026-08-06 |
| [0010](0010-one-mcp-error-envelope.md) | One error envelope for every MCP tool | accepted | 2026-08-07 |
| [0011](0011-an-e2e-layer-that-only-tests-what-in-process-tests-cannot.md) | An E2E layer that only tests what in-process tests cannot | accepted | 2026-08-07 |
| [0012](0012-one-error-vocabulary-two-envelopes.md) | One error vocabulary, two envelopes | accepted | 2026-08-07 |
| [0013](0013-scoped-client-keys-and-searxng-get-search.md) | Scoped client keys, a global Kagi call budget, and a SearXNG-shaped GET /search | partially superseded by 0019 | 2026-10-01 |
| [0014](0014-searxng-fallback-engine.md) | SearXNG fallback engine behind `engine=auto` | accepted | 2026-10-01 |
| [0015](0015-build-sha-in-authenticated-health.md) | Build SHA in authenticated /health | accepted | 2026-10-01 |
| [0016](0016-scrape-markup-change-loud-failure.md) | Fail loudly when Kagi's search markup moves | accepted | 2026-10-01 |
| [0017](0017-result-cache.md) | Read-through result cache that works on workers.dev | accepted | 2026-10-02 |
| [0018](0018-automated-production-deploy-gate.md) | Automated production deploy gate | accepted | 2026-10-04 |
| [0019](0019-uncapped-search-volume-with-fail-open-pacer.md) | Uncapped search volume with a fail-open 2/s pacer | accepted | 2026-10-14 |
