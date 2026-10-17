# ADR 0009 — Upgrade to zod 4, and treat the tool schema as a wire contract

**Status:** Accepted — 2026-08-06
**Relates to:** [ADR 0003](0003-canonical-response-shapes.md) (this is the
request-side counterpart to it), [ADR 0008](0008-bound-request-fan-out.md)
(the fan-out ceilings this upgrade had to preserve)

## Context

`agents@0.17.3` declares `zod: ^4.0.0` as a peer dependency. We were on
`zod@3.25.76`, so the install was in violation — `npm ls zod` reported
`invalid` against three separate edges. It worked, but it was luck rather than
design, and every `npm install` printed the conflict.

`@modelcontextprotocol/sdk@1.29.0` accepts `^3.25 || ^4.0` and picks a
conversion path at runtime, in `server/zod-json-schema-compat.js`:

```js
export function toJsonSchemaCompat(schema, opts) {
    if (isZ4Schema(schema)) {
        return z4mini.toJSONSchema(schema, { ... });   // zod 4
    }
    return zodToJsonSchema(schema, { ... });           // zod 3, vendored
}
```

That branch is the whole risk. The zod shapes in `src/mcp.ts` are not an
internal detail — after conversion they become `tools/list`'s `inputSchema`,
which is the only description of our request contract an MCP client ever sees.
Swapping the converter can therefore reshape all thirteen advertised tool
schemas without a single line of `src/` changing.

Our existing tests could not have caught that. `test/workers/mcp-tools.test.ts`
captures the *zod* shapes handed to `server.tool()` and asserts on them
directly (`schema.queries.safeParse(...)`). That proves what we declared. It
says nothing about what a client is told.

## Decision

**Upgrade to `zod@4.4.3`, but pin the wire contract first.**

`test/workers/mcp-schema-contract.test.ts` stands up a real `McpServer`,
registers the agent's tools into it, connects a real `Client` over
`InMemoryTransport`, and snapshots what `tools/list` and `prompts/list`
actually return. Alongside the snapshots sit per-property assertions for the
constraints a conversion is most likely to drop quietly: the three fan-out
ceilings from ADR 0008, numeric bounds, defaults, enum members, descriptions,
the required/optional split, string length bounds, and url format.

Recorded against zod 3, then re-run against zod 4. Everything held except one
thing: **`additionalProperties: false` disappeared from all 26 schema objects.**
That was the entire diff.

### The one change, and why it is accepted

zod 3's vendored converter emitted `additionalProperties: false` for every
`z.object`. zod 4's `toJSONSchema` omits it, because `z.object` **strips**
unknown keys rather than rejecting them — only `z.strictObject` rejects.

So the interesting question is not "did the schema change" but "was the old
schema ever true". Measured, not assumed — `test/workers/mcp-schema-contract.test.ts`
calls `kagi_summarize_url` with an unknown `not_a_real_parameter` and checks
what happens:

| zod | advertised | actual behavior |
| --- | --- | --- |
| 3.25.76 | `additionalProperties: false` | accepted, key silently stripped |
| 4.4.3 | *(omitted)* | accepted, key silently stripped |

Identical runtime behavior. zod 3 was advertising a constraint the server never
enforced. The new schema is the honest one, and this is the same class of
defect as the `requireBearer` comment corrected in ADR 0008's branch: a stated
safety property the code did not have.

Restoring it is not available to us anyway. `server.tool()` takes a raw shape
(`ZodRawShape`) and wraps it in a plain `z.object` inside the SDK; there is no
seam to pass a `z.strictObject` through.

## Consequences

- The peer dependency graph is clean. `npm ls zod` reports no `invalid` edges.
- Clients that validate arguments against `inputSchema` will now accept unknown
  properties instead of rejecting them locally. The server behaves exactly as
  it did before — it strips them — so this narrows a gap between the advertised
  and the actual contract rather than widening one.
- Models that use `inputSchema` to constrain generation lose a weak hint
  against inventing parameters. An invented parameter was already ignored
  rather than refused, so the outcome is unchanged; only the local warning is.
- Tool schemas are now covered by a test at the layer clients consume. The next
  zod or SDK bump fails in CI rather than in someone's agent.
- `z.string().url()` is deprecated in zod 4 in favour of the top-level
  `z.url()`. It still typechecks and still emits `format: "uri"`, verified by
  the contract test, so it is left alone. Migrating it would change the emitted
  schema again for no behavioral gain; do it when zod 5 forces the issue.

## Alternatives considered

- **Stay on zod 3 and pin it.** The peer conflict is only a warning today, and
  zod 3 still works. Rejected: `agents` is a direct dependency that will keep
  moving, the conflict blocks its future upgrades, and deferring a major bump
  makes it larger rather than smaller. The contract test makes the cost of
  doing it now low and the cost of being wrong visible.
- **Take Dependabot PR #8 as-is.** Same version, no contract test, no evidence.
  It would have merged the `additionalProperties` change with nobody noticing —
  precisely the silent-break case this ADR exists to prevent. The branch was
  done by hand for that reason.
- **Assert the JSON Schema by importing the SDK's converter directly.** Cheaper
  than standing up a client, but it tests our call to an internal SDK module
  rather than the bytes a client receives, and deep-imports a path the SDK does
  not treat as public. The in-memory client pair costs about twenty lines more
  and measures the real thing.
- **Snapshot only, no per-property assertions.** Rejected: a 400-line snapshot
  diff tells you something moved, not what was lost. The explicit assertions
  name the casualty — a dropped `maxItems: 20` fails as "the fan-out ceiling on
  kagi_search_fetch.queries", which is legible in CI output.
