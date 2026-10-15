// Vitest config — two projects, one report.
//
//   unit    : pure logic (parsers, canonical types, error taxonomy, helpers)
//             runs in plain Node against the stubs in test/_helpers.ts.
//   workers : anything that touches a Workers binding or a runtime global
//             (KV, Durable Objects, caches.default, cloudflare:* imports).
//             Runs in workerd via Miniflare, bindings resolved from
//             wrangler.jsonc.
//
// The split exists because src/index.ts -> src/research/run.ts imports
// `cloudflare:workers`, which the Node ESM loader cannot resolve at all
// ("Only URLs with a scheme in: file, data, and node are supported").
// Anything reachable from that import must live under test/workers/.
//
// Keeping the fast pure suite in Node is deliberate: workerd start-up
// dominates runtime, and most of this codebase is parsing.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          // test/e2e/** belongs to Playwright (npm run test:e2e). Its specs are
          // *.spec.ts, so the glob above already misses them; this entry is
          // what keeps a *.test.ts written there from being run by this
          // runner, where its Playwright imports would fail for reasons that
          // have nothing to do with the code under test.
          exclude: ["test/workers/**", "test/e2e/**"],
          environment: "node",
          globals: false,
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // Isolates storage per test — but do not treat it as a general
            // reset. It does NOT roll back a Durable Object's SQL storage, a
            // KV write made by loadToken() when it seeds from
            // KAGI_SESSION_TOKEN has been observed surviving into the next
            // test, and module globals (store.ts's memoryCache) are outside
            // its reach entirely. Suites that need a clean slate reset it
            // themselves — see the beforeEach in test/workers/cost.test.ts,
            // test/workers/resources.test.ts, and
            // test/token/refresh-browser.test.ts.
            isolatedStorage: true,
          }),
        ],
        test: {
          name: "workers",
          include: ["test/workers/**/*.test.ts"],
          globals: false,
        },
      },
    ],
    coverage: {
      // istanbul, not v8: workerd does not expose V8's coverage API, so the
      // workers project cannot use the v8 provider. Keeping both projects on
      // istanbul means one merged report.
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      // Ratchet, not an aspiration. The floors sit a few points under the
      // measured numbers (98.7 / 92.9 / 99.6 / 99.6) so ordinary churn does
      // not fail CI, while a real regression does. The house rule is 80%;
      // these are deliberately well above it, because the suite is already
      // there and letting it slide back is the failure mode worth catching.
      // Raise them when the numbers rise. Do not lower them to make a change
      // pass — add the test instead.
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
});
