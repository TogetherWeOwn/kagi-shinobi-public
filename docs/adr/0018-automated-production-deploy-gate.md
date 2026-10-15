# ADR 0018 — Automated production deploy gate

**Status:** Accepted — 2026-10-04
**Relates to:** [ADR 0015](0015-build-sha-in-authenticated-health.md) (the
`buildSha` a deploy is verified against)

## Context

Production deploys ran behind a `production` Environment whose only protection
was one required reviewer, the repo owner. Every release therefore waited for a
human click, and the click verified nothing: the reviewer was shown a tag name,
not whether its commit was on `main` or green. The owner directed on 2026-10-04
that production deploys must not wait on that click. `two-web-next` and
`two-bot-next` already replaced it with an automated gate keyed on the repo
variable `PRODUCTION_AUTO_APPROVE`; this repo had none.

## Decision

**A `guard` job runs `ci/deploy-gate.ts` before the `deploy` job. In auto mode
its evidence is the approval; in legacy mode it additionally requires the human
reviewer to still be configured.**

The guard refuses unless all of these hold, in either mode:

- the workflow runs from `refs/heads/main`;
- `tag` is `vMAJOR.MINOR.PATCH`, exists under `refs/tags/`, and peels (through
  annotated tags) to a commit;
- that commit is on `main` (`compare/main...<sha>` is `identical` or `behind`);
- a published, non-draft GitHub release of that exact tag exists, and
  `package.json` at that commit carries the tag's version;
- the `production` Environment has a custom deployment branch policy that
  allows `main` and nothing else;
- the latest `push` / `workflow_dispatch` / `schedule` run of `ci.yml` on that
  exact SHA concluded `success`. `pull_request` runs are ignored: they are
  change-gated (docs-only PRs skip the heavy job) and prove less than the full
  suite. A run still in flight is waited for, up to `CI_WAIT_MINUTES` (30),
  because release-please calls the deploy the instant the Release PR merges,
  which is also the instant the push-to-main CI run starts. If no run exists at
  all it gives up after 3 minutes.

Mode is `auto` only when `vars.PRODUCTION_AUTO_APPROVE` is exactly `true`
(`TRUE`, `1`, ` true`, unset all mean legacy). Legacy mode also requires a
`required_reviewers` rule with at least one reviewer, so an Environment that
lost its reviewer (or was auto-created by a run, which GitHub creates with no
protection at all) is refused instead of silently deploying unreviewed.

`deploy` checks out the **SHA the guard approved**, not the tag name, and
fails if `HEAD` differs: a tag can be deleted and recreated between two jobs, a
SHA cannot.

### What actually keeps a branch out of production

The guard is code, and a branch can edit code. The control that does not move
is server-side: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are
**Environment** secrets behind a **main-only deployment branch policy**, so a
job from any other ref cannot read them. The guard checks that policy is still
exactly `main` on every run, and `guard` itself holds no secret. Do not move
the Cloudflare secrets to repo level: that would make the guard advisory.

### Operator switch

After this merges the operator sets the repo variable
`PRODUCTION_AUTO_APPROVE=true` and removes the required reviewer from the
`production` Environment, keeping the main-only branch policy (back up the
Environment JSON first). Doing it in the other order, or before this merges,
leaves a reviewer-less Environment with no guard. Rollback is the reverse:
delete the variable, re-add the reviewer.

## Consequences

- A release deploys with nobody clicking, once CI on its commit is green.
- A red or missing CI run, an off-main tag, a tag/version mismatch or a widened
  branch policy now stops a deploy, in legacy mode too.
- The guard occupies a CI runner for the length of that CI run (about
  7 minutes today, 40 at most) while it waits.
- The gate script is TypeScript run directly by Node 24 (type stripping), so it
  has no relative imports and no enums, and the guard job installs nothing.
- `release-please.yml`'s `deploy` call must grant `actions: read`; a called
  workflow cannot exceed its caller's permissions, and without it the guard's
  CI and Environment reads 403. `test/ci/deploy-gate.test.ts` pins this wiring.
