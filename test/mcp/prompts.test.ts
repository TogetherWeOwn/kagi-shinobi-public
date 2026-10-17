// MCP prompts — the templates a client surfaces as slash commands.
//
// A prompt's wording is editorial and will drift, so these tests pin the
// contract instead: every prompt must register with a description and a
// schema, and must build a valid single user message that actually embeds the
// argument it was given. A prompt that silently drops its argument renders as
// a plausible-looking instruction with the user's input missing.

import { describe, expect, it } from "vitest";
import { registerPrompts } from "../../src/mcp/prompts";

interface PromptResult {
  messages: Array<{ role: string; content: { type: string; text: string } }>;
}
type PromptHandler = (args: Record<string, string>) => PromptResult;

/** Any argument a prompt destructures resolves to this, so it can be found. */
const SENTINEL = "sentinel-argument-value";
const anyArgs = new Proxy({} as Record<string, string>, { get: () => SENTINEL });

function captureRegistrations() {
  const registered = new Map<
    string,
    { description: string; schema: Record<string, unknown>; handler: PromptHandler }
  >();
  const server = {
    prompt: (
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: PromptHandler,
    ) => {
      registered.set(name, { description, schema, handler });
    },
  };

  registerPrompts(server as never);
  return registered;
}

describe("registerPrompts", () => {
  it("registers at least one prompt", () => {
    expect(captureRegistrations().size).toBeGreaterThan(0);
  });

  it("registers the documented slash commands", () => {
    const names = [...captureRegistrations().keys()];

    expect(names).toContain("cite_this_claim");
    expect(names).toContain("compare_default_vs_personalized");
  });

  it("gives every prompt a non-empty description and an argument schema", () => {
    for (const [name, entry] of captureRegistrations()) {
      expect(entry.description, `${name} has no description`).toBeTruthy();
      expect(Object.keys(entry.schema).length, `${name} has no arguments`).toBeGreaterThan(0);
    }
  });
});

describe("every prompt builds a valid user message", () => {
  const names = [...captureRegistrations().keys()];

  it.each(names)("%s returns one user text message", (name) => {
    const entry = captureRegistrations().get(name)!;

    const result = entry.handler(anyArgs);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content.type).toBe("text");
    expect(result.messages[0].content.text.length).toBeGreaterThan(0);
  });

  // The failure this catches: a template that renders without the caller's
  // input, producing confident-looking but empty instructions.
  it.each(names)("%s embeds the argument it was given", (name) => {
    const entry = captureRegistrations().get(name)!;

    const result = entry.handler(anyArgs);

    expect(result.messages[0].content.text).toContain(SENTINEL);
  });

  it.each(names)("%s names a kagi tool to call", (name) => {
    const entry = captureRegistrations().get(name)!;

    const result = entry.handler(anyArgs);

    expect(result.messages[0].content.text).toMatch(/kagi_/);
  });
});
