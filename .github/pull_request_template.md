<!--
Title: Conventional Commits header, e.g. `fix(search): fall back to searxng when the Kagi budget is spent`.
Types: feat fix perf refactor test docs build ci chore revert style security. Max 100 chars, no trailing period.
Keep issue references out of the title. Link them under "Linked Issues" instead (`Fixes #123` for a GitHub issue).
Write short, plain sentences. Fill in every section: the `pr-lint` check reads them.
The checks live in .github/scripts/pr_standards.py with their tests next to it.
-->

## Thinking Path

<!--
  Required. Trace your reasoning from the project down to this change, as a blockquote.
  Start with what this repo is, narrow through the subsystem and the problem, and end with
  why this PR exists. Aim for 5-8 steps; the check needs at least 3 real ones.
-->

> - kagi-shinobi is a Cloudflare Worker that fronts Kagi search and the summarizer as a remote MCP server and a REST API
> - [Which subsystem or capability is involved]
> - [What problem or gap exists]
> - [Why it needs to be addressed]
> - This pull request ...
> - The benefit is ...

## Linked Issues or Issue Description

<!--
  Required for feat, fix, perf, refactor and security. Pick ONE:
  (A) Issue exists: link it. A card goes on the Refs line; a GitHub issue is `Fixes #123`.
  (B) No issue exists: describe the problem here in your own words.
-->

Fixes #

## What Changed

<!-- One bullet per logical unit. -->

-

## Verification

<!--
  Commands you ran and their results, so a reviewer can repeat them.
  CI runs: npm run cf-typegen, typecheck, test:coverage, wrangler deploy --dry-run, test:e2e.
-->

-

## Risks

<!-- Deploy safety, breaking changes to /mcp or /search, Kagi call budget, session-token or secret impact. "Low risk" if genuinely minor. -->

-

## Model Used

<!--
  Required. Provider, exact model ID or version, context window, reasoning mode and tool use if known.
  If no AI model was used, write "None - human-authored".
-->

-

## Checklist

- [ ] I wrote a thinking path that runs from the project to this change
- [ ] I named the model used, with its version
- [ ] I searched for duplicate or related PRs and linked them above
- [ ] I ran the tests locally and they pass
- [ ] I added or updated tests where applicable
- [ ] I updated the documentation this change touches
- [ ] No secret, session token or credential is in the diff, the title, the body or the branch name
- [ ] CI is green on the exact head before I ask for review
