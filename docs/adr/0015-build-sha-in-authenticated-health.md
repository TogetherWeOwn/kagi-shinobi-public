# ADR 0015 — Build SHA in authenticated /health

**Status:** Accepted — 2026-10-01
**Relates to:** [ADR 0018](0018-automated-production-deploy-gate.md) (the deploy gate that consumes the SHA)

## Context

The live Worker predates PR #14, which showed merged ≠ deployed: nothing in the
running worker identifies which commit it was built from, so an operator cannot
confirm a deploy landed. CI runs on hosted runners and production
deploys get their own gated workflow; the workflow needs a var to inject and
the worker needs a place to report it.

## Decision

1. **`BUILD_SHA` is a plain `wrangler.jsonc` var** (default `"dev"`), injected at
   deploy time via `wrangler deploy --var BUILD_SHA:<sha>`. A var, not a secret:
   the value is the public commit SHA, and `--var` wins over the file without
   editing it — exactly like the E2E suite's `--var ADMIN_TOKEN:` precedent in
   `playwright.config.ts`.
2. **Authenticated `GET /health` returns `buildSha`.** The anonymous body stays
   `{ ok: true }` byte-identical: the SHA identifies the deployed build, which
   is operator deployment state and belongs behind the bearer with the rest of
   the detail (`test/workers/routing.test.ts` pins both sides).
3. **No `src/env.ts` change.** Vars typed by `wrangler types --strict-vars=false`
   are plain `string`, so the new var typechecks without touching the
   secrets-only augmentation — whose header warns a redeclaration would
   contradict the generated member (TS2430).

## Alternatives considered

**A `/version` route.** Rejected: it would be a second public-or-gated decision
for one field, and the privacy question is already settled for `/health`.

**Baking the SHA at build time (e.g. `git rev-parse` in a pre-deploy script).**
Rejected: an extra codegen step that must run before every deploy and typecheck
against (see the `worker-configuration.d.ts` discipline), for a value wrangler
already injects natively with `--var`.

## Consequences

- After a deploy, `curl -H "Authorization: Bearer $ADMIN_TOKEN" $WORKER/health`
  reports the deployed commit; the acceptance check is one command.
- Local `wrangler dev` and the E2E suite see `"dev"`, which is asserted in
  `test/e2e/smoke.spec.ts` — a deploy-path injection can never leak into tests
  that prove config defaults.
