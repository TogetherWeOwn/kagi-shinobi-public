# ADR 0012 — One error vocabulary, two envelopes

**Status:** Accepted — 2026-08-07
**Relates to:** [ADR 0003](0003-canonical-response-shapes.md), [ADR 0010](0010-one-mcp-error-envelope.md)

## Context

ADR 0010 gave the MCP surface one error envelope and closed the escape hatch
that had let a second one appear. It said nothing about REST, and the open
question it left behind — *should the two surfaces converge?* — has been carried
across several sessions unanswered.

The two surfaces report the same underlying failures. Every Kagi-side error is a
`KagiError` carrying a `kind` from a closed union of ten
(`src/kagi/errors.ts:5-15`) plus a `detail` bag. MCP renders it via
`mcpError()`; REST renders it via `kagiErrorResponse()` (`src/rest.ts:202-235`).

Measured against the code rather than assumed:

**1. REST's status and its code are computed from different things, and they
disagree.** The status comes from an `instanceof` chain over error *classes*;
the code comes from the *kind*. Any error thrown as the base class falls past
every branch to a blanket 500 while still deriving its kind-based code. The
existing suite already pins the contradiction — `test/rest.test.ts:441-446`
asserts `new KagiError("upstream", …)` → **500** `kagi-upstream`, four lines
after `test/rest.test.ts:421` asserts `new KagiUpstreamError(…)` → **502**
`kagi-upstream`. A client told to key on `error.code` sees one code at two
statuses. Nobody decided that; it is what an `instanceof` chain does when the
base class is reachable.

**2. `kagi-captcha` and `kagi-timeout` have no status at all.** They reach the
same fall-through and land on 500. A timeout is the one condition with an exact
HTTP status (504) and it gets the generic one.

**3. REST drops `err.detail` on the floor.** `jsonError(status, code, message)`
has nowhere to put it. So `spent_cents`/`cap_cents`, `status`/`status_text`,
`tool`/`mode`, `ms`, and `cost_cents`/`engine` all reach an MCP caller and none
of them reach a REST caller. A REST client is told it got a 402 but not what the
cap was, and told the upstream failed but not with which status.

**4. The REST codes are already 9/10 mechanically derivable** from the kind —
`rate_limit` → `kagi-rate-limit`, `budget_exceeded` → `kagi-budget-exceeded`,
and so on for eight more. The single exception is `parse` → `kagi-parse-failed`.
That is a 22-line hand-maintained table reproducing a one-line transform, and it
has already drifted once.

**5. One REST error is built outside the helper entirely.** `src/index.ts:41-57`
hand-rolls `new Response(JSON.stringify({error:{code,message}}), …)` because
`jsonError` cannot take headers and that response needs three. It happens to
match the envelope today. This is precisely the shape of the problem ADR 0010
found on the MCP side: a builder that cannot express what a caller needs
guarantees a hand-rolled second shape eventually.

Meanwhile `kagiErrorMcp` (`src/mcp.ts:605-620`) branches on three classes —
`KagiConfirmRequiredError`, `KagiUnsupportedInModeError`,
`KagiNotConfiguredError` — before its generic `KagiError` branch. Checked
output-for-output, all three produce byte-identical results to the generic
branch. They are dead weight, and their presence is what makes MCP *look* like
it also branches on class when it does not.

## Decision

**The envelopes stay different. The vocabulary becomes one.**

Keeping two envelopes is deliberate, not inertia. MCP has no status code — every
tool result is a 200 and severity lives in `isError` — while REST puts half the
meaning in the status line. Forcing `error_kind` into REST would duplicate the
status; forcing a status into MCP would invent a field the transport has no use
for. There is nothing to gain by merging them.

What converges is everything underneath:

1. **`KagiErrorKind` is the single key.** A new exported
   `Record<KagiErrorKind, number>` maps kind → HTTP status, and the REST code is
   derived as `` `kagi-${kind.replaceAll("_", "-")}` ``. The `instanceof` chain in
   `kagiErrorResponse` is deleted; a single `err instanceof KagiError` remains.
   Because the table is a `Record` over the union, adding a kind without a status
   fails `typecheck` — the enforcement is structural, not a convention.

   The lookup still carries a `?? 500`, which is not redundant with that. The
   `Record` stops a kind being *added* without a status; the guard stops one
   *arriving* past the type system, via a cast or a JS caller. It is there
   because the failure is silent and inverted rather than loud:
   `new Response(body, { status: undefined })` returns **200**, measured, so an
   unmapped kind would otherwise answer an error with a success status — a
   regression against the chain this replaced, whose last branch was a 500.

2. **`error.detail` is added to the REST body**, carrying `err.detail` when it is
   non-empty and omitted when it is not, so responses without detail stay
   byte-identical. `Retry-After` is emitted whenever `detail.retry_after` is a
   number.

   That header is **latent today, and deliberately so.** `KagiRateLimitError` is
   declared, carries `retry_after`, and is mapped to 429 — but it is constructed
   nowhere in `src/`; a Kagi 429 currently surfaces as
   `KagiUpstreamError(429, …)`, so it arrives as kind `upstream` and a 502.
   Checked, not assumed: `rg 'new KagiRateLimitError' src/` returns nothing.
   The wiring is included anyway on the same totality argument the status table
   rests on — a mapping keyed by kind owes every kind an answer, and a 429
   without `Retry-After` is a 429 that invites a client to hammer. It is four
   lines and fully covered. Whether `rate_limit` *should* be thrown where
   `upstream` is thrown today is a separate question this ADR does not settle.

3. **`jsonError` gains an optional init** (`detail`, `headers`), and
   `src/index.ts`'s hand-rolled rate-limit response routes through it. After this
   no error `Response` is constructed anywhere outside the helper — the REST
   analogue of `mcpResult()` losing its `isError` input.

4. **The three redundant branches in `kagiErrorMcp` are deleted.** Both surfaces
   then derive every field from `kind` and `detail`, with no per-class branching
   left on either side. That is the property this ADR is actually buying.

Consequences for the wire, stated exactly:

- `kagi-parse-failed` becomes **`kagi-parse`**. This is the one code that changes.
- `kagi-captcha` moves 500 → **503**, `kagi-timeout` moves 500 → **504**.
- A `KagiError` thrown as the base class now gets its kind's status instead of
  500 — e.g. `new KagiError("upstream", …)` returns 502, agreeing with
  `KagiUpstreamError`.
- `error.detail` appears on responses that previously had none.

503 for `captcha` rather than 502: a Turnstile challenge is operator-actionable
and temporary — `CAPTCHA_WEBHOOK_URL` exists to page someone about exactly this —
which is what 503 means and what 502 does not. It sits with `not_configured`,
the other "an operator must do something" condition.

## Alternatives considered

**One envelope for both surfaces.** Rejected on the transport argument above: the
status line carries half the REST contract and has no MCP counterpart. It is also
the most breaking option available, for the least gain.

**Leave it and document the difference.** Rejected for the reason ADR 0010 gave
when it rejected the same option: recording a wart is not deciding, and this
particular wart is not even a difference of design — a 500-versus-502 split on
the same code is a bug wearing a convention's clothes.

**Keep `kagi-parse-failed` and drop derivation, using an explicit
`Record<KagiErrorKind, {code, status}>`.** Tempting, because it avoids the only
breaking change. Rejected: the value of the rule is that a reader or a client can
convert between the surfaces without consulting a table, and one exception
destroys exactly that. An explicit table with nine mechanical rows and one
special case is how the current drift started.

**Map `timeout` to 500 rather than 504, to avoid a status change.** Rejected. 504
is what a gateway returns when the upstream did not answer in time, and this is a
gateway. The current 500 is a fall-through, not a decision — there is nothing to
preserve.

## Consequences

**Positive.** One vocabulary across both front doors: a REST `error.code` is the
MCP `error_kind` with a `kagi-` prefix and dashes, mechanically, for every kind
that exists. Status is a total function of kind, so the class an error happens to
be constructed as can no longer change its status. REST callers gain the detail
they were silently denied — the cap behind a 402, the upstream status behind a
502, the tool and mode behind a 400. A new `KagiErrorKind` cannot be added
without a status, enforced by the type checker.

**Negative.** Four wire changes, listed above, on a personal proxy: one renamed
code and three status corrections. Any client matching `kagi-parse-failed` breaks
and must match `kagi-parse`. Judged acceptable on the same grounds ADR 0010
accepted its break — the alternative is preserving a value that only exists
because a table entry was typed by hand.

**Risks.** Low, and bounded by tests. The MCP surface's wire output does not
change at all: the deleted `kagiErrorMcp` branches were verified byte-identical
to the fallback before removal, and `test/workers/mcp-tools.test.ts` pins the
envelopes. The REST changes are pinned by a table-driven test over the full
`KagiErrorKind` union in `test/rest.test.ts`, which fails if a kind is added
without a mapping, plus a cross-surface test asserting the prefix rule holds for
every kind rather than for a sampled few.
