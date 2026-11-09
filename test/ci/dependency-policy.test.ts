// A release-age setting alone silently does nothing under the npm bundled
// with Node 22. Keep the strict engine and both installer entry points wired
// together; a frozen install cannot catch a too-young prior resolution.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("dependency installation policy", () => {
  it("requires a policy-capable npm instead of warning on an unsupported age setting", () => {
    const manifest = JSON.parse(read("package.json")) as { engines: { npm: string } };
    const config = Object.fromEntries(
      read(".npmrc")
        .split("\n")
        .filter((line) => line.includes("=") && !line.startsWith("#"))
        .map((line) => line.trim().split("=")),
    );

    expect(manifest.engines.npm).toBe(">=11.19.0");
    expect(config["engine-strict"]).toBe("true");
    expect(config["min-release-age"]).toBe("3");
    expect(config["ignore-scripts"]).toBe("true");
  });

  it.each(["ci", "deploy"])("bootstraps npm before the strict %s project install", (workflow) => {
    const source = read(`.github/workflows/${workflow}.yml`);
    const bootstrap = source.indexOf("- name: Install policy-capable npm");
    const install = source.indexOf("- run: npm ci");

    expect(bootstrap).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(bootstrap);
    const step = source.slice(bootstrap, install);
    expect(step).toContain("working-directory: ${{ runner.temp }}");
    expect(step).toContain('TOOL_DIR="$RUNNER_TEMP/kagi-npm-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"');
    expect(step).toContain('npm install --prefix "$TOOL_DIR" --no-save --package-lock=false npm@11.19.0 --ignore-scripts');
    expect(step).toContain('"$TOOL_DIR/node_modules/.bin" >> "$GITHUB_PATH"');
    expect(step).not.toContain("--global");
  });
});
