// Acceptance test: valid Release Please changelog sections are allowed.
//
// The first public Release Please run has now written "## 1.0.0
// (2026-10-17)" into CHANGELOG.md. That generated history is valid and
// must remain intact. The pre-release baseline in public-baseline.test.ts
// was written for the moment *before* that first entry existed and
// rejects every versioned heading; after the first release it must be
// narrowed so generated sections pass, while the baseline's other
// public-repo constraints (header first, no links into the private
// repository) stay in force.
//
// The "baseline does not reject ..." tests below exercise the baseline's
// own negative assertions behaviourally, whatever their exact wording
// after the fix: every `.not.toMatch(<regex>)` / `.not.toContain(<string>)`
// pattern in public-baseline.test.ts is applied to a synthetic valid
// changelog, and none of them may reject it. Deleting the generated
// 1.0.0 section instead of narrowing the assertion fails the history
// controls, so the fix cannot be taken out on CHANGELOG.md.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const changelog = read("CHANGELOG.md");
const baselineSource = read("test/ci/public-baseline.test.ts");

type NegativePattern = { description: string; rejects: (text: string) => boolean };

function baselineNegativePatterns(): NegativePattern[] {
  const patterns: NegativePattern[] = [];
  for (const match of baselineSource.matchAll(/\.not\.toMatch\(\/((?:\\.|[^/\\\n])+)\/([gimsuy]*)/g)) {
    const [, source, flags] = match;
    patterns.push({
      description: `not.toMatch(/${source}/${flags ?? ""})`,
      rejects: (text) => new RegExp(source as string, flags ?? "").test(text),
    });
  }
  for (const match of baselineSource.matchAll(/\.not\.toContain\(\s*"([^"\n]*)"\s*\)/g)) {
    const needle = match[1] as string;
    patterns.push({
      description: `not.toContain(${JSON.stringify(needle)})`,
      rejects: (text) => text.includes(needle),
    });
  }
  return patterns;
}

const VALID_RELEASE_CHANGELOG = [
  "# Changelog",
  "",
  "## 1.1.0 (2026-11-01)",
  "",
  "### Features",
  "",
  "* an entry ([abc1234](https://github.com/TogetherWeOwn/kagi-shinobi-public/commit/abc1234))",
  "",
  "## 1.0.0 (2026-10-17)",
  "",
  "### Bug Fixes",
  "",
  "* the first public entry ([#1](https://github.com/TogetherWeOwn/kagi-shinobi-public/issues/1))",
  "",
].join("\n");

describe("generated Release Please history is preserved", () => {
  it("changelog still starts at the '# Changelog' header", () => {
    expect(changelog.split("\n")[0]?.trim()).toBe("# Changelog");
  });

  it("changelog preserves the generated 1.0.0 release section", () => {
    expect(changelog).toContain("## 1.0.0 (2026-10-17)");
  });

  it("every versioned changelog heading is a dated Release Please heading", () => {
    const versioned = [...changelog.matchAll(/^##\s+(.+)$/gm)]
      .map((m) => (m[1] as string).trim())
      .filter((heading) => /^\d+\.\d+\.\d+/.test(heading));

    expect(versioned.length).toBeGreaterThan(0);
    for (const heading of versioned) {
      expect(heading, heading).toMatch(/^\d+\.\d+\.\d+ \(\d{4}-\d{2}-\d{2}\)$/);
    }
  });

  it("changelog contains no links into the private repository", () => {
    // Trailing slash distinguishes TogetherWeOwn/kagi-shinobi/ from
    // TogetherWeOwn/kagi-shinobi-public/.
    expect(changelog).not.toContain("github.com/TogetherWeOwn/kagi-shinobi/");
  });
});

describe("public baseline accepts valid generated sections", () => {
  it("baseline negative patterns do not reject a valid Release Please changelog", () => {
    const rejecting = baselineNegativePatterns()
      .filter((pattern) => pattern.rejects(VALID_RELEASE_CHANGELOG))
      .map((pattern) => pattern.description);

    expect(rejecting).toEqual([]);
  });

  it("baseline negative patterns do not reject the actual changelog", () => {
    const rejecting = baselineNegativePatterns()
      .filter((pattern) => pattern.rejects(changelog))
      .map((pattern) => pattern.description);

    expect(rejecting).toEqual([]);
  });
});
