# ADR 0010 — One error envelope for every MCP tool

**Status:** Accepted — 2026-08-07
**Relates to:** [ADR 0003](0003-canonical-response-shapes.md)

## Context

ADR 0003 settled what a *successful* MCP tool result looks like: a canonical
type in `structuredContent`, plus `content[0].text` for clients that grep text.
It said nothing about failures, and failures drifted.

Three tools reject an unsupported `target_language`. Two of them —
`kagi_summarize_url` and `kagi_summarize_text` — return `mcpError()`:

```jsonc
{
  "content": [{ "type": "text", "text": "Error [invalid_language]: unsupported target_language 'XX'" }],
  "structuredContent": { "error_kind": "invalid_language", "message": "…", "supported": ["EN", "…"] },
  "isError": true
}
```

`kagi_summarizer` hand-rolled a third shape for the identical condition:

```jsonc
{
  "content": [{ "type": "text", "text": "Error: unsupported target_language 'XX'. Supported: EN, DE, …" }],
  "structuredContent": { "error_kind": "invalid_language", "supported": ["EN", "…"] },
  "isError": true
}
```

Both set `isError: true`, so this was never "soft versus hard" — that framing,
carried in a test comment and in several session notes, was wrong. The actual
differences are narrower and worse: the hand-rolled payload **omits `message`**,
and it inlines the supported-code list into the text where the envelope carries
it only as structured data.

The decisive detail is that `kagi_summarizer` was inconsistent *with itself*. Its
`catch` block already returned the `mcpError` envelope by way of
`kagiErrorMcp()`. A caller handling that tool's failures had to parse one shape
for a rejected language and another for an expired token. That is drift, not a
design position — nobody would choose it.

## Decision

Every MCP tool returns failures through `mcpError()`. `kagi_summarizer`'s
`invalid_language` branch is changed to match; no other call site moves.

The rule is then enforced structurally rather than by convention: `mcpResult()`
loses its optional `isError` input, so it can no longer produce an error result
at all. That flag was the escape hatch this whole ADR exists because of — after
the change no production caller passed it, and leaving it in place would leave
the next tool free to invent a fourth shape. `mcpError()` is now the only door.
The `McpResult.isError` output field naturally stays; `mcpError()` sets it.

Consequences for the wire:

- `structuredContent.message` now present where it was missing.
- `content[0].text` becomes `Error [invalid_language]: unsupported target_language 'XX'`,
  losing the inline `Supported: …` list. The codes remain in
  `structuredContent.supported`, which is where the other two tools have always
  put them and where a machine consumer should read them.

This is a response-shape change, which is why it gets an ADR rather than a
drive-by edit.

## Alternatives considered

**Move the other two tools to the hand-rolled shape instead.** Rejected: it is
the minority (one tool against two), it drops `message`, and it would still
leave `kagi_summarizer` disagreeing with its own `catch` block unless
`kagiErrorMcp` changed too — which would then diverge from every non-summarize
tool in the file.

**Leave it and document the difference.** Rejected. It had been documented, in a
test comment reading "Note this one returns a soft isError result rather than the
mcpError envelope," and carried unresolved across several sessions. Recording a
wart is not the same as deciding, and the description was inaccurate besides.

**Keep the inline supported-code list in the text for this tool only.** Rejected:
that is the specific inconsistency being removed. `mcpError`'s `detail` already
carries the codes into `structuredContent`.

## Consequences

**Positive.** One error shape across the MCP surface. A client can handle
failures uniformly: check `isError`, read `structuredContent.error_kind`, read
`message`. `kagi_summarizer` stops contradicting itself between its validation
and exception paths.

**Negative.** A breaking change for any client that grepped `content[0].text`
for `Supported:` on this one tool. Judged acceptable — this is a personal proxy,
the structured field has always carried the same data, and the two sibling tools
already behaved this way, so such a client was already tool-specific.

**Risks.** Low. The error payloads are not part of the `tools/list` wire contract
snapshotted in `test/workers/mcp-schema-contract.test.ts`, so that snapshot is
unaffected — verified, not assumed. Behavior is pinned in
`test/workers/mcp-tools.test.ts`.
