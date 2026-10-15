# ADR 0011 — An E2E layer that only tests what in-process tests cannot

**Status:** Accepted — 2026-08-07
**Relates to:** [ADR 0001](0001-tri-mode-architecture.md), [ADR 0010](0010-one-mcp-error-envelope.md)

## Context

`testing.md` requires an E2E layer and the repo has never had one. The obvious
reading — "drive the public endpoints end to end" — produces a suite that
restates `test/workers/routing.test.ts`, which already pins routing, the bearer
gate, `/health`'s authenticated/anonymous split, and rate limiting in workerd
against real Durable Objects. A second copy of those assertions costs a
`wrangler dev` boot per run and catches nothing new.

The gap is narrower and more specific than "no E2E". Every existing suite
constructs the environment it tests against:

- `test/workers/routing.test.ts` calls `worker.fetch(request, testEnv(...), ctx)`
  with a hand-built env — `ADMIN_TOKEN` invented, `PER_BEARER_RPM` forced to `0`.
- `test/workers/mcp-schema-contract.test.ts` drives the MCP server over
  `InMemoryTransport.createLinkedPair()` — no HTTP, no session, no DO.
- `test/workers/mcp-tools.test.ts` passes the mode in as a string.

So nothing in the repo asserted that `wrangler.jsonc` — the file that actually
configures the deployed worker — produces a server that boots and behaves as
declared. `npx wrangler deploy --dry-run` proves the bundle links; it does not
start it. A `KAGI_MODE` typo, a Durable Object migration that fails to apply, or
a var renamed in the config but not the code would pass every check in CI.

## Decision

Add a third test layer, Playwright, that boots a real `wrangler dev` and speaks
to it over a socket — and give it a scope rule that keeps it from growing into a
duplicate of the workerd suite:

> Every assertion in `test/e2e/` must be one an in-process test cannot make.

In practice that admits three kinds of assertion, and nothing else:

1. **The artifact boots.** All bindings in `wrangler.jsonc` — three Durable
   Objects with SQLite migrations, KV, Browser Rendering — resolve at startup.
2. **The shipped configuration is live.** `AUTO_REFRESH_ENABLED` and
   `KAGI_MODE` are read from the real config file rather than a synthetic env,
   so the value a var has in `wrangler.jsonc` is observable through the API.
3. **A real MCP client completes a Streamable-HTTP session.** `initialize`,
   the `Mcp-Session-Id` round trip, `notifications/initialized`, `tools/list`,
   and a `tools/call` — through `McpAgent.serve()` and the Durable Object,
   over SSE. The in-memory transport exercises none of it.

One carve-out, because the rule as stated is too blunt on its own: **the same
condition may be re-exercised over a different transport when the transport is
what is under test.** The invalid-language tool call is the case — its envelope
contents (exact message, exact rendered text) are pinned in-process by
`test/workers/mcp-tools.test.ts`, and E2E must not restate them. What E2E
asserts instead is fidelity across the wire: that `structuredContent` arrives as
a live object rather than a JSON string or null, and that the content block
survives SSE framing. Same input, different question.

Two further constraints, both load-bearing:

**No E2E test may reach Kagi.** The worker under test holds no Kagi credential
and the suite must not depend on the public internet. The one `tools/call` in
the suite passes an unsupported `target_language`, which `kagi_summarize_url`
rejects before it invokes the Kagi client — so it drives DO → agent → handler →
`mcpError` → SSE → client with no outbound request, and doubles as an
end-to-end check of ADR 0010's envelope.

**No browser is launched.** Playwright is used for its `request` fixture and its
`webServer` orchestration only. `npx playwright install` is therefore not part
of setup and CI downloads no browser binaries — verified by running the suite
with `PLAYWRIGHT_BROWSERS_PATH` pointed at an empty directory, not assumed.

E2E runs as its own CI step (`npm run test:e2e`) after `test:coverage`, and is
deliberately outside `npm test`: the fast loop stays fast, and because the suite
talks to a separate process it contributes nothing to istanbul's numbers, so the
coverage ratchet in `vitest.config.ts` is unaffected either way.

## Alternatives considered

**A third vitest project that spawns `wrangler dev` in `globalSetup`.** Tempting
— one runner, one config, no new dependency. Rejected because `testing.md`
names Playwright, and because `webServer` already solves boot-and-wait,
readiness-polling, and teardown-on-failure, which is the part that would
otherwise be hand-rolled and flaky.

**Port the routing table into E2E for "real" coverage.** Rejected; this is the
failure mode the scope rule exists to prevent. `routing.test.ts` makes those
assertions in milliseconds against real DOs, and a slower copy that can also
fail for network reasons is strictly worse.

**Exercise a real search or summarize call.** Rejected. It needs a live Kagi
credential in CI, it bills against `MAX_API_CENTS_PER_MONTH` for the API modes,
and its failures would be Kagi's rather than ours. The dispatcher and the cost
guard are pinned by `test/kagi/**` and ADR 0006's fail-closed suite.

**Reuse an already-running dev server (`reuseExistingServer: true`).** Rejected.
A server someone left running has a different `ADMIN_TOKEN`, or none, and the
mismatch surfaces as a mystifying 401 rather than "this is not the server the
suite booted". The suite always starts its own, on port 8799 rather than
wrangler's default 8787 for the same reason.

## Consequences

**Positive.** A config change that bundles but does not boot now fails CI. The
MCP wire path — session handshake through a Durable Object — is tested for the
first time. The exact tool set a client is offered under the shipped
`KAGI_MODE` is pinned end to end.

**Negative.** CI gains a step that boots workerd (~8s locally, 7 tests). One
more dev dependency. `test/e2e/` is invisible to the coverage report, so its
assertions do not defend the ratchet.

**Risks.** The suite is state-sensitive — Durable Object storage persists — so
it runs with `--persist-to .wrangler/e2e-state`, isolating it from a developer's
`npm run dev`, and asserts the *shape* of `/health`'s token field rather than
its value.

Isolation alone was not enough, and the first version of this ADR missed why.
The Meter DO's rate counter is keyed by bearer-hash + epoch-minute and prunes
only buckets older than two minutes, while every spec authenticates as the one
`E2E_ADMIN_TOKEN`. A fixed persist directory therefore *accumulates* across the
suite's own reruns: roughly seven to ten `npm run test:e2e` invocations inside a
single wall-clock minute would begin returning 429s unrelated to whatever was
being debugged. CI never hits it — each run is a fresh checkout — so this was a
local-dev-loop trap only, which is precisely the kind that wastes an afternoon.
The `webServer` command now deletes the directory before booting, which keeps
the isolation and drops the accumulation.

**Verification.** All seven tests passed on first write, which is the condition
under which this repo does not trust a test. Mutating `wrangler.jsonc` —
`KAGI_MODE: "scrape" → "api"` and `AUTO_REFRESH_ENABLED: "true" → "false"` —
failed exactly the two configuration assertions (the tool list gained the four
api-only tools; `autoRefresh` came back `false`) and no others. The tests
observe the config file, not a constant.
