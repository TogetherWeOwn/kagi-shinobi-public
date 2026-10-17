# ADR 0004 — Deep research async trio + Durable Object

**Status:** Accepted — 2026-07-11

## Context

Deep research runs are multi-step (plan → search → extract → synthesize)
and take tens of seconds even with parallel search. Wrapping the entire
pipeline in one synchronous tool call would starve MCP clients of progress
signals and force them to hold a long-lived request.

## Decision

Four tools that form an async workflow:

- `kagi_research_create_run(question, depth?, budget_cents?, allow_api?)`
  returns immediately with `run_id`. The pipeline runs via
  `ctx.waitUntil(...)` inside a Durable Object.
- `kagi_research_wait_for_run(run_id, timeout_seconds)` polls the DO until
  terminal or timeout.
- `kagi_research_get_output(run_id)` returns the current state
  (partial while running, complete when done).
- `kagi_research_cancel_run(run_id)` sets a cancel flag the pipeline
  checks between stages.

Storage: a single `ResearchRun` DO instance (`singleton`) holds all runs
in SQLite. This keeps cost accounting and cross-run lookups trivial.

## Consequences

- Clients can start a run and check back later without holding a socket.
- Budget defaults to 0 cents so scrape-only runs are free and produce a
  usable report via the FastGPT-less fallback synthesizer.
- Progress notifications via MCP `notifications/progress` are NOT yet
  implemented — poll-based today, future enhancement.
