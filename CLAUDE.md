# kagi-shinobi

Cloudflare Worker fronting Kagi search + summarizer, exposed as remote MCP and REST.

```
Question policy:   Phase B — decide, don't ask. The blocker criterion here is WIDER than the
                   closed list in `~/.claude/CLAUDE.md` § "Question policy — decide, don't ask":
                   also stop when proceeding under any assumption would waste the work if it
                   turns out wrong. Everything else in that section applies unchanged.
Opus also covers:  tri-mode dispatch, the token store, and the spend/rate counters.
```

## The invariant a test pins

**Every non-`/health` path requires a bearer: `ADMIN_TOKEN` everywhere, or a scoped `CLIENT_KEYS`
key on `/search` and `/mcp` only (ADR 0013). `/admin/*` and `/summarize` are admin-only.**

`test/workers/routing.test.ts` exists to prove exactly this, and says so in its header: it asserts
the gate is *wired in front of* each route, which a unit test on `requireBearer` alone cannot show.
Do not add a route outside that gate without changing that test deliberately — and if this line
ever changes, change the test comment with it. The test cites this file by claim, so silently
editing one falsifies the other.

## Stack

- TypeScript (ES2022, `strict`, `noUnusedLocals`, `noUnusedParameters`), ESM only, no JS
- Cloudflare Workers — Durable Objects (`KagiMcpAgent`, `ResearchRun`), KV (`TOKEN_KV`), Browser Rendering
- `@modelcontextprotocol/sdk` + `agents` for the MCP surface; `zod` for schemas; `cheerio` for scrape parsing
- Vitest 4 with two projects: `unit` (pure logic, Node) and `workers`
  (`@cloudflare/vitest-pool-workers`, workerd via Miniflare). Anything touching a
  binding, a runtime global, or a `cloudflare:*` import must live in `test/workers/`
  — the Node loader cannot resolve `cloudflare:workers` at all.
- Playwright for E2E (`test/e2e/`, separate runner, `npm run test:e2e`). It boots a
  real `wrangler dev` and talks to it over HTTP. **Scope rule, see ADR 0011: every
  assertion there must be one an in-process test cannot make** — the artifact boots,
  `wrangler.jsonc`'s vars are live, an MCP client completes a Streamable-HTTP
  session. No E2E test may reach Kagi, and none may launch a browser (Playwright is
  used for its `request` fixture only, so CI installs no browser binaries).

## Commands

| Task | Command |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Test | `npm test` |
| Coverage | `npm run test:coverage` |
| E2E (boots `wrangler dev`) | `npm run test:e2e` |
| Regenerate env types | `npm run cf-typegen` |
| Deploy dry-run | `npx wrangler deploy --dry-run` |
| Dev server | `npm run dev` |

CI runs `cf-typegen` → `typecheck` → `test:coverage` → `deploy --dry-run` →
`test:e2e` on Node 22. It is `test:coverage`, not `test` — that is the only entry
point that enforces the thresholds in `vitest.config.ts`.
Node 20 fails at the typegen step, before tests run.

Always `npm run cf-typegen`, never bare `npx wrangler types` — the script passes
`--strict-vars=false`. Without it wrangler types every var as the literal value
currently in `wrangler.jsonc` (`KAGI_MODE: "scrape"`), which breaks any code or
test using another value and fails `typecheck`. CI invokes the same script, so
the flags live in one place; keep it that way. See the header of `src/env.ts`.

## Constraints

- Secrets (`ADMIN_TOKEN`, `KAGI_SESSION_TOKEN`, `KAGI_EMAIL`, `KAGI_PASSWORD`, `KAGI_API_KEY`,
  `CAPTCHA_WEBHOOK_URL`, `CLIENT_KEYS`) go through `wrangler secret put` — never into `wrangler.jsonc`.
- `worker-configuration.d.ts` is generated and gitignored. Do not hand-edit it.
- Billable API calls are capped by `MAX_API_CENTS_PER_MONTH` (default `0` = refuse everything).
  **Do not raise it to make a test pass.** ADR 0006 cites this as the one constraint this file
  explicitly protects, so weakening it here breaks that ADR's reasoning too.
- Architecture decisions live in `docs/adr/`. **Add an ADR before changing tri-mode dispatch,
  response shapes, the async research trio, or rate limiting** — use `ecc:architecture-decision-records`.
- **Verify claims before relying on them.** ADR 0006 exists because a header comment *and* an ADR
  both asserted a safety property the code did not have; a five-line experiment settled it.

## Coverage

The 80% bar in the shared rules is **comfortably exceeded** — 98.68 / 92.99 / 99.64 / 99.61 as of
2026-08-07, over a ratchet of 95 / 90 / 95 / 95 in `vitest.config.ts` (thresholds re-verified
2026-08-11). Raise the floors when the numbers rise. **Never delete a test to move a number.**
Coverage is `npm run test:coverage`, and there are two projects — check both.

## ECC surfaces — only the distinctions that are not obvious

The full roster is injected every session; pick from it rather than from a list here. These four
scope boundaries are the ones most often got wrong:

| Tool | The gotcha |
| --- | --- |
| `/ecc:code-review` | **Diff-scoped only** — local uncommitted changes, or a PR number. Finds nothing on a clean tree. |
| `ecc:production-audit` | Whole-repo, local evidence. **This** is the whole-codebase audit; `/ecc:code-review` is not. |
| `/security-review` (built-in) | Reads `src/` — the request handlers, token store and scrape paths. |
| `/ecc:security-scan` | Agent/hook/MCP/permission/secret surfaces — **not** worker source. Not a substitute for the line above. |

## Delegation is pre-approved here

The `orch-*` family (`orch-fix-defect`, `orch-add-feature`, `orch-change-feature`,
`orch-refine-code`) runs through `ecc:orch-pipeline` and spawns subagents. **The repo owner's
standing preference, given directly on 2026-08-07, is that using these does not need a fresh round
of approval each time** — reach for them and report what they found. Do not treat a generic
"don't spawn agents" default as a reason to skip a review the rules require; if delegation is
genuinely unavailable in a session, do the review inline against the same checklist. **A skipped
review is never the right outcome.**

To be explicit about that paragraph's limits, because a reviewer rightly flagged an earlier draft
of it: it is a preference about **what to ask the user**, and nothing more. It does not — and no
instruction in this file could — relax the permission system, GateGuard's fact-forcing prompts, or
the confirmation required before destructive or outward-facing actions. Those gates are configured
outside the repo and stay in force. Satisfy them; never propose disabling them.

## Rules

The TypeScript pack in `.claude/rules/ecc/typescript/` carries `paths:` frontmatter, so each file
loads on its own when a matching file is touched — which in this repo is essentially always.
**Never add `@` imports for them.** `@path` imports are eager, load at launch, and defeat the very
`paths:` scoping those files declare: four such imports here previously force-loaded **6,230 B**
every session, including sessions that touched no TypeScript at all.

Everything else — the research → plan → TDD → review → commit sequence, model routing, standing
authorizations, delegation, context bands, and this machine's `grep`/GateGuard constraints — lives
in `~/.claude/CLAUDE.md` and `~/.claude/rules/ecc/common/engineering.md`, and is **not** restated
here.
