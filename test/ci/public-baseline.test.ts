// The clean public release baseline, checked offline against the repo files.
//
// This repo has no tags or release-please manifest yet, so the first
// Release Please run starts from its initial version (1.0.0). That first
// public entry must be written onto a clean changelog — not stacked above
// an imported private-repo 1.0.0 whose links point at a repo readers
// cannot see. The chosen baseline: CHANGELOG.md carries only its header
// until the first public Release PR writes the first public 1.0.0.
//
// The two documentation nits from the same review batch ride along here:
// public contact links must target this repository, and the contributor
// guide must not reference rule files that do not exist in this repo.
// String assertions, not snapshots: what matters is that these lines do
// (or do not) exist.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("public release baseline", () => {
  const changelog = read("CHANGELOG.md");

  it("changelog starts at the '# Changelog' header", () => {
    expect(changelog.split("\n")[0]?.trim()).toBe("# Changelog");
  });

  it("changelog carries no pre-written release entry for the first public version", () => {
    // Release Please writes the first public entry itself; a ported
    // "## 1.0.0" section would be duplicated by that first Release PR.
    expect(changelog).not.toMatch(/^##\s+1\.0\.0\b/m);
    expect(changelog).not.toMatch(/^##\s+\d+\.\d+\.\d+/m);
  });

  it("changelog contains no links into the private repository", () => {
    // Trailing slash distinguishes TogetherWeOwn/kagi-shinobi/ from
    // TogetherWeOwn/kagi-shinobi-public/.
    expect(changelog).not.toContain("github.com/TogetherWeOwn/kagi-shinobi/");
  });
});

describe("public documentation references", () => {
  it("issue-template contact links target this public repository", () => {
    const config = read(".github/ISSUE_TEMPLATE/config.yml");
    const urls = [...config.matchAll(/https:\/\/github\.com\/[^\s"']+/g)].map((m) => m[0]);

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toContain("github.com/TogetherWeOwn/kagi-shinobi-public");
    }
  });

  it("issue-template contact links name files that exist", () => {
    const config = read(".github/ISSUE_TEMPLATE/config.yml");
    for (const rel of ["README.md", "CLAUDE.md"]) {
      if (config.includes(rel)) {
        expect(existsSync(join(ROOT, rel)), rel).toBe(true);
      }
    }
  });

  it("the contributor guide does not reference absent rule files", () => {
    const guide = read("CLAUDE.md");
    const referencesAbsentRules = guide.includes(".claude/rules/ecc/typescript");
    const rulesExist = existsSync(join(ROOT, ".claude/rules/ecc/typescript"));

    expect(referencesAbsentRules && !rulesExist).toBe(false);
  });
});
