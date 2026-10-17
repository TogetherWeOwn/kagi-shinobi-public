// The production deploy gate (ci/deploy-gate.ts, ADR 0018).
//
// Two things are pinned here, and the second is the one a unit test on the
// gate alone cannot show:
//   1. the gate's decisions, in both modes, against a stubbed GitHub API;
//   2. that the workflows are WIRED to it — `deploy` needs `guard`, deploys the
//      SHA the guard approved, and the release-please caller grants the
//      `actions: read` the guard needs. Delete any of those and the gate is
//      decoration, with every test in (1) still green.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GateError,
  assertEnvironment,
  assertMainRef,
  assertVersionTag,
  autoApproveEnabled,
  evaluateCi,
  runGate,
  type BranchPolicies,
  type Deps,
  type Env,
  type EnvironmentInfo,
} from "../../ci/deploy-gate";

const REPO = "TogetherWeOwn/kagi-shinobi";
const TAG = "v1.2.3";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

interface Run {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_repository: { full_name: string };
}

const run = (id: number, over: Partial<Run> = {}): Run => ({
  id,
  event: "push",
  status: "completed",
  conclusion: "success",
  head_sha: SHA,
  head_repository: { full_name: REPO },
  ...over,
});

const reviewerEnvironment = (): EnvironmentInfo => ({
  name: "production",
  protection_rules: [
    { type: "required_reviewers", reviewers: [{ type: "User" }] },
    { type: "branch_policy" },
  ],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
});

// What the operator leaves behind: no reviewer, main-only policy intact.
const autoEnvironment = (): EnvironmentInfo => ({
  name: "production",
  protection_rules: [{ type: "branch_policy" }],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
});

const mainOnly = (): BranchPolicies => ({ branch_policies: [{ name: "main", type: "branch" }] });

// A GitHub that is right about everything unless a test says otherwise. Each
// field is what the API would return; `null` means 404.
interface World {
  tagRef: unknown;
  tagObjects: Record<string, unknown>;
  compareStatus: string;
  release: unknown;
  version: string;
  environment: EnvironmentInfo | null;
  policies: BranchPolicies;
  // One entry per poll; the last repeats.
  ciPolls: Run[][];
  status: Record<string, number>;
}

const world = (over: Partial<World> = {}): World => ({
  tagRef: { object: { type: "commit", sha: SHA } },
  tagObjects: {},
  compareStatus: "behind",
  release: { id: 42, tag_name: TAG, draft: false },
  version: "1.2.3",
  // Matches baseEnv()'s legacy mode: tests that want auto set both.
  environment: reviewerEnvironment(),
  policies: mainOnly(),
  ciPolls: [[run(7)]],
  status: {},
  ...over,
});

interface Harness {
  deps: Partial<Deps>;
  calls: string[];
  logs: string[];
  clock: () => number;
}

function harness(w: World): Harness {
  let t = 0;
  let poll = 0;
  const calls: string[] = [];
  const logs: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const stub = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace(`/repos/${REPO}`, "") + url.search;
    calls.push(path);
    const forced = w.status[url.pathname.replace(`/repos/${REPO}`, "")];
    if (forced) return json({ message: "forced" }, forced);
    let m: RegExpMatchArray | null;
    if ((m = url.pathname.match(/\/git\/ref\/tags\/(.+)$/))) {
      return w.tagRef === null || m[1] !== TAG ? json({}, 404) : json(w.tagRef);
    }
    if ((m = url.pathname.match(/\/git\/tags\/([0-9a-f]+)$/))) {
      const body = w.tagObjects[m[1]];
      return body ? json(body) : json({}, 404);
    }
    if (url.pathname.includes("/compare/")) return json({ status: w.compareStatus });
    if (url.pathname.includes("/releases/tags/")) {
      return w.release === null ? json({}, 404) : json(w.release);
    }
    if (url.pathname.endsWith("/contents/package.json")) {
      const content = btoa(JSON.stringify({ name: "kagi-shinobi", version: w.version }));
      return json({ encoding: "base64", content });
    }
    if (url.pathname.endsWith("/deployment-branch-policies")) return json(w.policies);
    if (url.pathname.endsWith("/environments/production")) {
      return w.environment === null ? json({}, 404) : json(w.environment);
    }
    if (url.pathname.endsWith("/workflows/ci.yml/runs")) {
      const runs = w.ciPolls[Math.min(poll++, w.ciPolls.length - 1)];
      return json({ total_count: runs.length, workflow_runs: runs });
    }
    throw new Error(`unexpected request: ${path}`);
  };
  return {
    calls,
    logs,
    clock: () => t,
    deps: {
      fetch: stub as typeof fetch,
      // Sleeping advances the fake clock, so a 30-minute wait costs no time.
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      log: (line) => logs.push(line),
    },
  };
}

const baseEnv = (over: Env = {}): Env => ({
  GITHUB_REPOSITORY: REPO,
  GITHUB_TOKEN: "t",
  GITHUB_REF: "refs/heads/main",
  TAG,
  ...over,
});

const gate = (w: World, env: Env = baseEnv()) => {
  const h = harness(w);
  return { h, result: runGate(env, h.deps) };
};

const refuses = async (w: World, pattern: RegExp, env: Env = baseEnv()) => {
  const { result } = gate(w, env);
  await expect(result).rejects.toBeInstanceOf(GateError);
  await expect(gate(w, env).result).rejects.toThrow(pattern);
};

describe("mode", () => {
  it("is auto only for the exact string true", () => {
    expect(autoApproveEnabled({ PRODUCTION_AUTO_APPROVE: "true" })).toBe(true);
    for (const v of [undefined, "", "false", "TRUE", "True", "1", " true", "true ", "yes"]) {
      expect(autoApproveEnabled({ PRODUCTION_AUTO_APPROVE: v })).toBe(false);
    }
  });

  it("passes with no reviewer when PRODUCTION_AUTO_APPROVE=true", async () => {
    const { h, result } = gate(
      world({ environment: autoEnvironment() }),
      baseEnv({ PRODUCTION_AUTO_APPROVE: "true" }),
    );
    expect(await result).toEqual({ mode: "auto", tag: TAG, sha: SHA, releaseId: 42, ciRunId: 7 });
    expect(h.logs[0]).toContain("mode=auto");
  });

  it("legacy: refuses a reviewer-less environment", async () => {
    await refuses(world({ environment: autoEnvironment() }), /legacy mode: .*require a reviewer/);
  });

  it("legacy: refuses a reviewers rule with an empty reviewer list", async () => {
    const environment = autoEnvironment();
    environment.protection_rules?.push({ type: "required_reviewers", reviewers: [] });
    await refuses(world({ environment }), /require a reviewer/);
  });

  it("legacy: passes when a reviewer is required", async () => {
    const { result } = gate(world({ environment: reviewerEnvironment() }));
    expect(await result).toMatchObject({ mode: "legacy", sha: SHA });
  });

  it.each([undefined, "", "false", "TRUE", "1", " true"])(
    "anything but true (%j) is legacy and refuses a reviewer-less environment",
    async (flag) => {
      await refuses(
        world({ environment: autoEnvironment() }),
        /legacy mode/,
        baseEnv({ PRODUCTION_AUTO_APPROVE: flag }),
      );
    },
  );

  it("auto mode tolerates a reviewer that is still configured", async () => {
    const { result } = gate(
      world({ environment: reviewerEnvironment() }),
      baseEnv({ PRODUCTION_AUTO_APPROVE: "true" }),
    );
    expect(await result).toMatchObject({ mode: "auto" });
  });
});

// Every check below must hold in BOTH modes: auto mode removes the human, not
// the evidence.
describe.each([
  ["auto", { PRODUCTION_AUTO_APPROVE: "true" }, autoEnvironment],
  ["legacy", {}, reviewerEnvironment],
] as const)("%s mode refuses", (_mode, extra, environment) => {
  const env = () => baseEnv(extra);
  const w = (over: Partial<World> = {}) => world({ environment: environment(), ...over });

  it("a green baseline (sanity: the cases below each break exactly one thing)", async () => {
    expect(await gate(w(), env()).result).toMatchObject({ sha: SHA });
  });

  it.each(["main", "v1.2", "v1.2.3-rc1", "1.2.3", "v1.2.3\n", "v01.2.3x", "", "refs/tags/v1.2.3"])(
    "a non-release tag %j",
    async (tag) => {
      await refuses(w(), /refusing to deploy non-release ref/, baseEnv({ ...extra, TAG: tag }));
    },
  );

  it("a missing tag input", async () => {
    await refuses(w(), /non-release ref/, baseEnv({ ...extra, TAG: undefined }));
  });

  it.each(["refs/heads/feature", "refs/tags/v1.2.3", "refs/pull/1/merge", undefined])(
    "a workflow running from %j",
    async (ref) => {
      await refuses(w(), /from refs\/heads\/main only/, baseEnv({ ...extra, GITHUB_REF: ref }));
    },
  );

  it("a tag that does not exist", async () => {
    await refuses(w({ tagRef: null }), /tag v1\.2\.3 does not exist/, env());
  });

  it("a tag that points at a tree or blob", async () => {
    await refuses(
      w({ tagRef: { object: { type: "tree", sha: SHA } } }),
      /does not point at a commit/,
      env(),
    );
  });

  it("a commit that is not on main (ahead / diverged)", async () => {
    for (const compareStatus of ["ahead", "diverged"]) {
      await refuses(w({ compareStatus }), /is not on main/, env());
    }
  });

  it("a tag with no GitHub release", async () => {
    await refuses(w({ release: null }), /no GitHub release for tag v1\.2\.3/, env());
  });

  it("a draft release", async () => {
    await refuses(w({ release: { id: 1, tag_name: TAG, draft: true } }), /draft, or mismatched/, env());
  });

  it("a release whose tag differs", async () => {
    await refuses(
      w({ release: { id: 1, tag_name: "v9.9.9", draft: false } }),
      /draft, or mismatched/,
      env(),
    );
  });

  it("a package.json version that is not the tag's", async () => {
    await refuses(w({ version: "1.2.4" }), /is version "1\.2\.4", not 1\.2\.3/, env());
  });

  it("an environment that does not exist", async () => {
    await refuses(w({ environment: null }), /production Environment does not exist/, env());
  });

  it("an environment that lost its main-only branch policy", async () => {
    for (const broken of [
      { ...environment(), deployment_branch_policy: null },
      {
        ...environment(),
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      },
      { ...environment(), protection_rules: (environment().protection_rules ?? []).filter((r) => r.type !== "branch_policy") },
    ]) {
      await refuses(w({ environment: broken }), /main-only deployment branch policy/, env());
    }
  });

  it("an environment whose policy allows more than main", async () => {
    for (const branch_policies of [
      [],
      [{ name: "*", type: "branch" }],
      [{ name: "main", type: "branch" }, { name: "release/*", type: "branch" }],
      [{ name: "main", type: "tag" }],
    ]) {
      await refuses(w({ policies: { branch_policies } }), /may deploy from main only/, env());
    }
  });

  it("a GitHub API error, without leaking the response", async () => {
    await refuses(
      w({ status: { "/releases/tags/v1.2.3": 500 } }),
      /GitHub API \/releases\/tags\/v1\.2\.3 failed \(HTTP 500\)/,
      env(),
    );
  });
});

describe("tag resolution", () => {
  it("peels an annotated tag to its commit and gates on that SHA", async () => {
    const tagSha = "c".repeat(40);
    const w = world({
      tagRef: { object: { type: "tag", sha: tagSha } },
      tagObjects: { [tagSha]: { object: { type: "commit", sha: SHA } } },
    });
    const { h, result } = gate(w);
    expect((await result).sha).toBe(SHA);
    expect(h.calls.find((c) => c.includes("/compare/"))).toBe(`/compare/main...${SHA}`);
    expect(h.calls.find((c) => c.includes("/workflows/ci.yml"))).toContain(`head_sha=${SHA}`);
  });

  it("refuses a tag chain that never reaches a commit", async () => {
    const loop = "c".repeat(40);
    const w = world({
      tagRef: { object: { type: "tag", sha: loop } },
      tagObjects: { [loop]: { object: { type: "tag", sha: loop } } },
    });
    await expect(gate(w).result).rejects.toThrow(/does not point at a commit/);
  });

  it("accepts a commit equal to main's head", async () => {
    expect(await gate(world({ compareStatus: "identical" })).result).toMatchObject({ sha: SHA });
  });
});

describe("CI on the exact SHA", () => {
  it("refuses when the latest run failed, and says how to recover", async () => {
    const w = world({ ciPolls: [[run(7, { conclusion: "failure" })]] });
    await expect(gate(w).result).rejects.toThrow(/run 7 .* concluded failure; .*dispatch CI on the tag/);
  });

  it.each(["cancelled", "timed_out", "action_required", "skipped", "neutral", null])(
    "refuses a completed run that concluded %j",
    async (conclusion) => {
      await expect(gate(world({ ciPolls: [[run(7, { conclusion })]] })).result).rejects.toThrow(
        /concluded/,
      );
    },
  );

  it("refuses an older success when a newer run on the same SHA failed", async () => {
    const w = world({ ciPolls: [[run(7), run(9, { conclusion: "failure" })]] });
    await expect(gate(w).result).rejects.toThrow(/run 9 .* concluded failure/);
  });

  it("accepts a newer success over an older failure (a re-dispatched CI)", async () => {
    const w = world({ ciPolls: [[run(7, { conclusion: "failure" }), run(9)]] });
    expect(await gate(w).result).toMatchObject({ ciRunId: 9 });
  });

  it("ignores pull_request runs: they are change-gated, not the full suite", async () => {
    const w = world({ ciPolls: [[run(7, { event: "pull_request" })]] });
    await expect(gate(w).result).rejects.toThrow(/no full-suite ci\.yml run/);
  });

  it.each(["push", "workflow_dispatch", "schedule"])("accepts a %s run", async (event) => {
    expect(await gate(world({ ciPolls: [[run(7, { event })]] })).result).toMatchObject({ ciRunId: 7 });
  });

  it("ignores runs for another SHA or from a fork", async () => {
    const w = world({
      ciPolls: [[run(7, { head_sha: OTHER_SHA }), run(8, { head_repository: { full_name: "evil/fork" } })]],
    });
    await expect(gate(w).result).rejects.toThrow(/no full-suite ci\.yml run/);
  });

  it("gives up quickly when no run ever shows up", async () => {
    const { h, result } = gate(world({ ciPolls: [[]] }));
    await expect(result).rejects.toThrow(/no full-suite ci\.yml run .* gave up after 3 min/);
    expect(h.clock()).toBeLessThan(4 * 60_000);
  });

  it("waits for a run that is still going, then passes", async () => {
    const w = world({
      ciPolls: [
        [],
        [run(7, { status: "queued", conclusion: null })],
        [run(7, { status: "in_progress", conclusion: null })],
        [run(7)],
      ],
    });
    const { h, result } = gate(w);
    expect(await result).toMatchObject({ ciRunId: 7 });
    expect(h.logs.filter((l) => l.includes("waiting"))).toHaveLength(3);
    expect(h.clock()).toBe(3 * 20_000);
  });

  it("stops waiting for a run that never finishes (CI_WAIT_MINUTES)", async () => {
    const w = world({ ciPolls: [[run(7, { status: "in_progress", conclusion: null })]] });
    const { h, result } = gate(w, baseEnv({ CI_WAIT_MINUTES: "2", CI_POLL_SECONDS: "30" }));
    await expect(result).rejects.toThrow(/run 7 is in_progress; gave up after 2 min/);
    expect(h.clock()).toBe(2 * 60_000);
  });

  it("refuses a run list GitHub says is truncated", async () => {
    const h = harness(world());
    const inner = h.deps.fetch as typeof fetch;
    const deps: Partial<Deps> = {
      ...h.deps,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const res = await inner(input, init);
        if (!String(input).includes("/runs?")) return res;
        return new Response(JSON.stringify({ total_count: 150, workflow_runs: [run(7)] }));
      }) as typeof fetch,
    };
    await expect(runGate(baseEnv({ PRODUCTION_AUTO_APPROVE: "true" }), deps)).rejects.toThrow(/incomplete ci\.yml run list/);
  });

  it("checks CI last, so a bad tag never waits", async () => {
    const { h, result } = gate(world({ release: null, ciPolls: [[]] }));
    await expect(result).rejects.toThrow(/no GitHub release/);
    expect(h.calls.some((c) => c.includes("/workflows/"))).toBe(false);
  });
});

describe("request hygiene", () => {
  it("needs a well-formed repository and a token", async () => {
    await expect(gate(world(), baseEnv({ GITHUB_REPOSITORY: "nope" })).result).rejects.toThrow(/GITHUB_REPOSITORY/);
    await expect(gate(world(), baseEnv({ GITHUB_TOKEN: "" })).result).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it("makes no request at all before the cheap input checks pass", async () => {
    const { h, result } = gate(world(), baseEnv({ GITHUB_REF: "refs/heads/feature" }));
    await expect(result).rejects.toThrow();
    expect(h.calls).toEqual([]);
  });

  it("does not echo hostile tag text as a workflow command", () => {
    const hostile = "v1\n::add-mask::x";
    try {
      assertVersionTag(hostile);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toMatch(/\n/);
      expect((e as Error).message).toContain("\\n::add-mask");
    }
  });
});

describe("pure helpers", () => {
  it("assertMainRef / assertVersionTag", () => {
    expect(() => assertMainRef("refs/heads/main")).not.toThrow();
    expect(() => assertMainRef("refs/heads/main2")).toThrow(GateError);
    expect(assertVersionTag("v10.20.30")).toBe("v10.20.30");
  });

  it("assertEnvironment names the wrong environment", () => {
    expect(() => assertEnvironment({ name: "staging" }, mainOnly(), "auto")).toThrow(/not found/);
  });

  it("evaluateCi picks the highest run id, not list order", () => {
    const verdict = evaluateCi([run(9, { conclusion: "failure" }), run(7)], SHA, REPO);
    expect(verdict).toMatchObject({ state: "failed", runId: 9 });
  });
});

// (2) The wiring. String assertions, not a YAML parse: the repo has no YAML
// dependency, and what matters is that these lines exist.
describe("workflow wiring", () => {
  const read = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../../.github/workflows/${name}`, import.meta.url).href), "utf8");
  const deploy = read("deploy.yml");
  const jobBlock = (job: string) => {
    const start = deploy.indexOf(`\n  ${job}:\n`);
    expect(start, `job ${job}`).toBeGreaterThan(-1);
    const rest = deploy.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z-]+:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };

  it("runs the gate script in a guard job, handing it the mode switch, tag and token", () => {
    const guard = jobBlock("guard");
    expect(guard).toContain("run: node ci/deploy-gate.ts");
    expect(guard).toMatch(/PRODUCTION_AUTO_APPROVE: \$\{\{ vars\.PRODUCTION_AUTO_APPROVE \}\}/);
    expect(guard).toMatch(/TAG: \$\{\{ inputs\.tag \}\}/);
    expect(guard).toMatch(/GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    expect(guard).toMatch(/actions: read/);
    expect(guard).toMatch(/sha: \$\{\{ steps\.gate\.outputs\.sha \}\}/);
    // Not the production environment: the guard must run before any approval.
    expect(guard).not.toMatch(/\n    environment:/);
  });

  it("the deploy job needs the guard and deploys the SHA it approved", () => {
    const job = jobBlock("deploy");
    expect(job).toMatch(/\n    needs: guard\n/);
    expect(job).toMatch(/\n    environment: production\n/);
    expect(job).toMatch(/ref: \$\{\{ needs\.guard\.outputs\.sha \}\}/);
    expect(job).toMatch(/GUARDED_SHA: \$\{\{ needs\.guard\.outputs\.sha \}\}/);
    // The tag name is no longer what gets checked out: it can move.
    expect(job).not.toMatch(/ref: refs\/tags\//);
  });

  it("only the deploy job can see the production secrets", () => {
    expect(jobBlock("guard")).not.toMatch(/secrets\./);
    expect(deploy.match(/secrets\.CLOUDFLARE_API_TOKEN/g)).toHaveLength(1);
  });

  it("has exactly the two jobs, so nothing deploys around the guard", () => {
    expect(deploy.match(/\n {2}[a-z-]+:\n/g)?.map((s) => s.trim())).toEqual(["guard:", "deploy:"]);
  });

  it("release-please grants the called workflow actions: read", () => {
    const rp = read("release-please.yml");
    const call = rp.slice(rp.indexOf("\n  deploy:\n"));
    expect(call).toMatch(/permissions:\n {6}contents: read\n {6}actions: read\n/);
    expect(call).toMatch(/uses: \.\/\.github\/workflows\/deploy\.yml/);
    // No `secrets: inherit` — the Cloudflare secrets stay behind the environment.
    expect(call).not.toMatch(/^\s*secrets:\s*inherit/m);
  });
});
