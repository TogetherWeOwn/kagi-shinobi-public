---
name: kagi-shinobi-conventions
description: Development conventions and patterns for kagi-shinobi. TypeScript project with conventional commits.
---

# Kagi Shinobi Conventions

> Generated from [TogetherWeOwn/kagi-shinobi](https://github.com/TogetherWeOwn/kagi-shinobi) on 2026-08-07

## Overview

This skill teaches Claude the development patterns and conventions used in kagi-shinobi.

## Tech Stack

- **Primary Language**: TypeScript
- **Architecture**: hybrid module organization
- **Test Location**: separate
- **Test Framework**: vitest

## When to Use This Skill

Activate this skill when:
- Making changes to this repository
- Adding new features following established patterns
- Writing tests that match project conventions
- Creating commits with proper message format

## Commit Conventions

Follow these commit message conventions. Corrected by hand: the generator
analyzed 2 commits, which is too small a window to characterize a repo with 29
on `main`. The prefixes and style below are read from the full history.

### Commit Style: Conventional Commits

The 13 most recent commits on `main` are all conventional. The free-form
`S1`-`S9` messages are the oldest in the repo and are not the pattern to follow.

### Prefixes Used

- `feat`
- `fix`
- `test`
- `chore` (with scopes, e.g. `chore(deps):`, `chore(deps-dev):`)
- `docs`
- `ci`

### Message Style

Subjects are long and descriptive rather than clipped, and carry a substantial
body explaining *why*. See `e21c2a4` and `f6a54e7` for the house style.

### Message Guidelines

- Average message length: ~57 characters
- Keep first line concise and descriptive
- Use imperative mood ("Add feature" not "Added feature")


*Commit message example*

```text
fix: one error vocabulary — REST status stops depending on which class was thrown
```

*Commit message example*

```text
docs: review artifact for PR #28
```

## Architecture

### Project Structure: Single Package

This project uses **hybrid** module organization.

### Source Layout

```
src/
├── kagi/
├── util/
```

### Entry Points

- `src/index.ts`

### Guidelines

- This project uses a hybrid organization
- Follow existing patterns when adding new code

## Code Style

### Language: TypeScript

### Naming Conventions

| Element | Convention |
|---------|------------|
| Files | single lowercase word (`rest.ts`, `landing.ts`, `http.ts`) |
| Functions | camelCase |
| Classes | PascalCase |
| Constants | SCREAMING_SNAKE_CASE |

Corrected by hand. The generator reported files as camelCase; every file in
`src/` is in fact a single lowercase word, which a naive detector reads as
camelCase because it contains no separator. Obeying the generated value would
license `myNewThing.ts`. Multi-word concepts get a directory instead
(`src/kagi/api/`, `src/mcp/`, `src/token/`).

### Import Style: Relative Imports

### Export Style: Named Exports


*Preferred import style*

```typescript
// Use relative imports
import { Button } from '../components/Button'
import { useAuth } from './hooks/useAuth'
```

*Preferred export style*

```typescript
// Use named exports
export function calculateTotal() { ... }
export const TAX_RATE = 0.1
export interface Order { ... }
```

## Testing

### Test Framework: vitest

### File Pattern: `*.test.ts`

### Test Types

- **Unit tests**: Test individual functions and components in isolation
- **Integration tests**: Test interactions between multiple components/services

### Mocking: vi.mock


*Test file structure*

```typescript
import { describe, it, expect } from 'vitest'

describe('MyFunction', () => {
  it('should return expected result', () => {
    const result = myFunction(input)
    expect(result).toBe(expected)
  })
})
```

## Error Handling

### Error Handling Style: Try-Catch Blocks

This project uses **custom error classes** for specific error types.


*Standard error handling pattern*

```typescript
import { logWarn } from "./util/log.js"

try {
  const result = await riskyOperation()
  return result
} catch (err) {
  // `error`, not `msg` — logWarn spreads fields last, so a field named `msg`
  // would overwrite the log message and leave the line without context.
  logWarn("operation failed", { error: err instanceof Error ? err.message : String(err) })
  throw new Error("User-friendly message")
}
```

Corrected by hand. The generated example used `console.error`, which this repo
forbids: `.claude/rules/ecc/typescript/coding-style.md` says "No `console.log`
statements in production code", and `console.*` appears in exactly one file,
`src/util/log.ts`, behind the structured logger above.

## Best Practices

Based on analysis of the codebase, follow these practices:

### Do

- Use conventional commit format (feat:, fix:, etc.)
- Write tests using vitest
- Follow *.test.ts naming pattern
- Name source files as a single lowercase word; reach for a directory when the
  concept needs two
- Put anything importing `cloudflare:*` under `test/workers/` — the Node ESM
  loader cannot resolve those specifiers at all, so it belongs in the workerd
  project or it will not run
- Prefer named exports

### Don't

- Don't write vague commit messages
- Don't skip tests for new features
- Don't deviate from established patterns without discussion

---

*This skill was auto-generated by [ECC Tools](https://ecc.tools). Review and customize as needed for your team.*
