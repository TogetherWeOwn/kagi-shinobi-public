// Production deploy gate (ADR 0018). Runs as the `guard` job in
// .github/workflows/deploy.yml, before the `production` job.
//
//   node ci/deploy-gate.ts      (Node >= 24 strips the types natively)
//
// It refuses unless ALL of these hold, in either mode:
//   - the workflow itself runs from refs/heads/main,
//   - the input is a vMAJOR.MINOR.PATCH tag that exists and peels to a commit,
//   - that commit is on main (an ancestor of, or equal to, main's head),
//   - a published (non-draft) GitHub release of that exact tag exists and the
//     package.json at that commit carries the same version,
//   - the `production` Environment keeps a main-only deployment branch policy,
//   - the latest full-suite ci.yml run on that exact SHA is a success. A run
//     that is still in flight is waited for: release-please calls the deploy
//     workflow the moment the Release PR merges, which is the same instant the
//     push-to-main CI run starts.
//
// And one thing that depends on the mode:
//   - PRODUCTION_AUTO_APPROVE === "true": the evidence above IS the approval.
//     The Environment may have no required reviewer.
//   - anything else (unset, "false", "TRUE", " true", ...): legacy mode. The
//     Environment must still list a required reviewer, so a run that would
//     silently auto-create or have lost its reviewer is refused up front.
//
// The module is import-safe (the CLI below only runs when it is the entry
// point) and has no dependency beyond fetch, so test/ci/deploy-gate.test.ts
// drives every branch with a stub.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export class GateError extends Error {}

export type Env = Record<string, string | undefined>;
export type Mode = "auto" | "legacy";

export interface Deps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

export interface Evidence {
  mode: Mode;
  tag: string;
  sha: string;
  releaseId: number;
  ciRunId: number;
}

const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const MAIN_REF = "refs/heads/main";
const CI_WORKFLOW = "ci.yml";
// A `pull_request` run is change-gated (docs-only PRs skip the heavy job), so
// it proves less than the full suite. push, workflow_dispatch and schedule
// force every area true — see the `changes` job in ci.yml.
const FULL_SUITE_EVENTS = new Set(["push", "workflow_dispatch", "schedule"]);

const DEFAULT_CI_WAIT_MINUTES = 30;
const DEFAULT_CI_POLL_SECONDS = 20;
// push-to-main CI is registered within seconds of the push. If nothing has
// shown up after this long there is no run to wait for.
const NO_RUN_GRACE_MS = 3 * 60_000;

export function autoApproveEnabled(env: Env): boolean {
  return env.PRODUCTION_AUTO_APPROVE === "true";
}

// Tag text is operator input and ends up in a log. JSON.stringify keeps a
// newline or `::command::` from being interpreted by the Actions log parser.
function show(value: unknown): string {
  return JSON.stringify(String(value ?? "")).slice(0, 80);
}

export function assertVersionTag(tag: string | undefined): string {
  if (!tag || !VERSION_TAG.test(tag)) {
    throw new GateError(`refusing to deploy non-release ref: ${show(tag)}`);
  }
  return tag;
}

export function assertMainRef(ref: string | undefined): void {
  if (ref !== MAIN_REF) {
    throw new GateError(`production deploys run from ${MAIN_REF} only, not ${show(ref)}`);
  }
}

export interface EnvironmentInfo {
  name?: string;
  protection_rules?: Array<{ type?: string; reviewers?: unknown[] }>;
  deployment_branch_policy?: {
    protected_branches?: boolean;
    custom_branch_policies?: boolean;
  } | null;
}

export interface BranchPolicies {
  branch_policies?: Array<{ name?: string; type?: string }>;
}

// The server-side half of the control: CLOUDFLARE_* are environment secrets,
// and only a deployment from main can read them. That is what keeps a branch
// with an edited deploy.yml from reaching production, so it is what must never
// quietly widen.
export function assertEnvironment(
  environment: EnvironmentInfo,
  policies: BranchPolicies,
  mode: Mode,
): void {
  if (environment.name !== "production") {
    throw new GateError("production Environment not found");
  }
  const policy = environment.deployment_branch_policy;
  const rules = environment.protection_rules ?? [];
  if (
    policy?.custom_branch_policies !== true ||
    policy?.protected_branches !== false ||
    !rules.some((rule) => rule.type === "branch_policy")
  ) {
    throw new GateError("production Environment must keep its main-only deployment branch policy");
  }
  const branches = policies.branch_policies ?? [];
  if (
    branches.length === 0 ||
    !branches.every((p) => p.name === "main" && (p.type === undefined || p.type === "branch"))
  ) {
    throw new GateError("production Environment may deploy from main only");
  }
  if (mode === "legacy") {
    const review = rules.find((rule) => rule.type === "required_reviewers");
    if (!review || !review.reviewers?.length) {
      throw new GateError(
        "legacy mode: production Environment must require a reviewer " +
          "(set PRODUCTION_AUTO_APPROVE=true to replace the reviewer with this gate)",
      );
    }
  }
}

interface CiRun {
  id: number;
  event?: string;
  status?: string | null;
  conclusion?: string | null;
  head_sha?: string;
  head_repository?: { full_name?: string } | null;
}

export type CiVerdict =
  | { state: "success"; runId: number }
  | { state: "failed"; runId: number; detail: string }
  | { state: "pending"; detail: string; noRun?: boolean };

// Pure: the decision for one poll of the ci.yml runs listed for a SHA.
export function evaluateCi(runs: CiRun[], sha: string, repository: string): CiVerdict {
  const exact = runs.filter(
    (run) =>
      Number.isSafeInteger(run.id) &&
      run.head_sha === sha &&
      run.head_repository?.full_name === repository &&
      FULL_SUITE_EVENTS.has(run.event ?? ""),
  );
  if (exact.length === 0) {
    return { state: "pending", detail: `no full-suite ${CI_WORKFLOW} run on ${sha}`, noRun: true };
  }
  const latest = exact.reduce((a, b) => (b.id > a.id ? b : a));
  if (latest.status !== "completed") {
    return { state: "pending", detail: `${CI_WORKFLOW} run ${latest.id} is ${latest.status}` };
  }
  if (latest.conclusion === "success") return { state: "success", runId: latest.id };
  return {
    state: "failed",
    runId: latest.id,
    detail:
      `latest ${CI_WORKFLOW} run ${latest.id} on ${sha} concluded ${latest.conclusion}; ` +
      `fix it or dispatch CI on the tag (Actions -> CI -> Run workflow) and re-run`,
  };
}

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function runGate(env: Env, partial: Partial<Deps> = {}): Promise<Evidence> {
  const deps: Deps = {
    fetch: partial.fetch ?? fetch,
    sleep: partial.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: partial.now ?? (() => Date.now()),
    log: partial.log ?? ((line) => console.log(line)),
  };

  const repository = env.GITHUB_REPOSITORY ?? "";
  if (!REPOSITORY.test(repository)) throw new GateError("GITHUB_REPOSITORY is missing or malformed");
  if (!env.GITHUB_TOKEN) throw new GateError("GITHUB_TOKEN is missing");
  const mode: Mode = autoApproveEnabled(env) ? "auto" : "legacy";
  const tag = assertVersionTag(env.TAG);
  assertMainRef(env.GITHUB_REF);
  deps.log(`deploy gate: mode=${mode} tag=${tag}`);

  const apiBase = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
  const repoUrl = `${apiBase}/repos/${repository}`;
  const get = async <T>(path: string, missing?: string): Promise<T> => {
    const response = await deps.fetch(`${repoUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404 && missing) throw new GateError(missing);
    if (!response.ok) {
      throw new GateError(`GitHub API ${path.split("?")[0]} failed (HTTP ${response.status})`);
    }
    return (await response.json()) as T;
  };

  // 1. The tag exists and peels to a commit. Annotated tags add a level.
  let ref = await get<{ object?: { type?: string; sha?: string } }>(
    `/git/ref/tags/${tag}`,
    `tag ${tag} does not exist`,
  );
  let object = ref.object;
  for (let hops = 0; object?.type === "tag" && hops < 3; hops++) {
    ref = await get(`/git/tags/${object.sha}`, `tag ${tag} does not resolve`);
    object = ref.object;
  }
  const sha = object?.sha ?? "";
  if (object?.type !== "commit" || !SHA.test(sha)) {
    throw new GateError(`tag ${tag} does not point at a commit`);
  }

  // 2. That commit is on main. `behind` = the commit is an ancestor of main.
  const compare = await get<{ status?: string }>(`/compare/main...${sha}`);
  if (compare.status !== "identical" && compare.status !== "behind") {
    throw new GateError(`commit ${sha} (tag ${tag}) is not on main (compare: ${compare.status})`);
  }

  // 3. The release and the tag agree: a published release of this exact tag,
  //    and the version in the tagged tree is the tag's version.
  const release = await get<{ id?: number; tag_name?: string; draft?: boolean }>(
    `/releases/tags/${tag}`,
    `no GitHub release for tag ${tag}`,
  );
  if (release.tag_name !== tag || release.draft !== false || !Number.isSafeInteger(release.id)) {
    throw new GateError(`release for tag ${tag} is missing, draft, or mismatched`);
  }
  const pkg = await get<{ content?: string; encoding?: string }>(`/contents/package.json?ref=${sha}`);
  if (pkg.encoding !== "base64" || !pkg.content) throw new GateError("package.json is unreadable at the tag");
  const bytes = Uint8Array.from(atob(pkg.content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  const version = (JSON.parse(new TextDecoder().decode(bytes)) as { version?: string }).version;
  if (version !== tag.slice(1)) {
    throw new GateError(`package.json at ${sha} is version ${show(version)}, not ${tag.slice(1)}`);
  }

  // 4. The Environment.
  const environment = await get<EnvironmentInfo>(
    "/environments/production",
    "production Environment does not exist",
  );
  const policies = await get<BranchPolicies>("/environments/production/deployment-branch-policies");
  assertEnvironment(environment, policies, mode);

  // 5. CI on the exact SHA, waiting for one that is still running.
  const started = deps.now();
  const waitMs = positive(env.CI_WAIT_MINUTES, DEFAULT_CI_WAIT_MINUTES) * 60_000;
  const pollMs = positive(env.CI_POLL_SECONDS, DEFAULT_CI_POLL_SECONDS) * 1000;
  for (;;) {
    const list = await get<{ total_count?: number; workflow_runs?: CiRun[] }>(
      `/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${sha}&per_page=100`,
    );
    const runs = list.workflow_runs ?? [];
    if (typeof list.total_count === "number" && list.total_count > runs.length) {
      throw new GateError(`incomplete ${CI_WORKFLOW} run list for ${sha}`);
    }
    const verdict = evaluateCi(runs, sha, repository);
    if (verdict.state === "success") {
      deps.log(`deploy gate: ${tag} = ${sha}, ${CI_WORKFLOW} run ${verdict.runId} green, release ${release.id}`);
      return { mode, tag, sha, releaseId: release.id as number, ciRunId: verdict.runId };
    }
    if (verdict.state === "failed") throw new GateError(verdict.detail);
    const waited = deps.now() - started;
    if (waited >= waitMs || (verdict.noRun && waited >= NO_RUN_GRACE_MS)) {
      throw new GateError(`${verdict.detail}; gave up after ${Math.round(waited / 60_000)} min`);
    }
    deps.log(`deploy gate: waiting - ${verdict.detail}`);
    await deps.sleep(pollMs);
  }
}

async function main(): Promise<void> {
  try {
    const evidence = await runGate(process.env);
    const out = process.env.GITHUB_OUTPUT;
    if (out) appendFileSync(out, `sha=${evidence.sha}\nmode=${evidence.mode}\n`);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      appendFileSync(
        summary,
        `Deploy gate passed (${evidence.mode} mode): \`${evidence.tag}\` = \`${evidence.sha}\`, ` +
          `release ${evidence.releaseId}, CI run ${evidence.ciRunId}.\n`,
      );
    }
  } catch (error) {
    const message = error instanceof GateError ? error.message : `gate error: ${String(error)}`;
    // One line: a newline would end the ::error:: workflow command early.
    console.error(`::error title=Production deploy refused::${message.replace(/[\r\n]+/g, " ")}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
