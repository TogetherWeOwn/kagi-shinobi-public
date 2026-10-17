// The clean public release baseline, checked offline against the repo files.
//
// The first public entry had to be written by Release Please onto a clean
// changelog — not stacked above an imported private-repo 1.0.0 whose links
// point at a repo readers cannot see. That first Release PR has now written
// the generated "## 1.0.0 (2026-10-17)" section, so the baseline no longer
// requires a header-only changelog: generated versioned sections are valid
// history, and every versioned heading must carry the Release Please date
// suffix. The first release is unlinked ("## X.Y.Z (YYYY-MM-DD)"); once a
// previous tag exists Release Please links the heading
// ("## [X.Y.Z](...compare/...) (YYYY-MM-DD)"). An undated versioned heading
// in either form would be a ported or hand-written entry, not a generated one.
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

  it("every versioned changelog section is a dated Release Please heading", () => {
    // First release is unlinked; later releases link to the public compare
    // view. An undated versioned heading in either form (a ported "## 1.0.0"
    // or "## [1.0.1](...)", say) is not generated history and would be
    // duplicated or misordered by a later Release PR.
    const versioned = [...changelog.matchAll(/^##\s+(.+)$/gm)]
      .map((m) => (m[1] as string).trim())
      .filter((heading) => /^\[?\d+\.\d+\.\d+/.test(heading));

    for (const heading of versioned) {
      expect(heading, heading).toMatch(
        /^(?:\d+\.\d+\.\d+|\[\d+\.\d+\.\d+\]\(https:\/\/github\.com\/TogetherWeOwn\/kagi-shinobi-public\/compare\/[^)\s]+\)) \(\d{4}-\d{2}-\d{2}\)$/,
      );
    }
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
