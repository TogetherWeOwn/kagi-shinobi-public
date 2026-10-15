// End-to-end smoke: the worker as a deployed artifact.
//
// Every other suite calls the worker in-process. test/workers/routing.test.ts
// hands `worker.fetch` a hand-built env; test/workers/mcp-schema-contract.test.ts
// drives the MCP server over an InMemoryTransport. Both are faster and more
// precise than anything here, and they own the behaviour they cover.
//
// What neither can show is that wrangler.jsonc assembles into a server that
// starts and answers on a socket. `wrangler deploy --dry-run` proves the bundle
// links; it does not prove the Durable Object migrations, the KV namespace, and
// the Browser Rendering binding all resolve at boot, nor that the vars in that
// file are what the running worker actually sees. That is this project's whole
// job. An assertion a unit or workerd test could make belongs there, not here.
//
// Playwright is used for its `request` fixture and its webServer orchestration
// only. No test launches a browser, so `npx playwright install` is not needed
// and CI never downloads browser binaries — keep it that way.
//
// Two things to know before changing this file:
//
// - Tracing is off (no `trace`/`video`/`screenshot` here, and Playwright's
//   `trace: "on-first-retry"` default only applies when retries run). Turning
//   it on makes Playwright write request headers — including
//   `Authorization: Bearer …` — into test-results/. That directory and
//   playwright-report/ are gitignored for exactly this reason; if you enable
//   tracing, do not redirect its output somewhere tracked.
// - `process.env` type-resolves here only because Playwright's own types import
//   a Node builtin, which transitively pulls in @types/node. tsconfig.json's
//   `types` array does not list it. If a Playwright upgrade stops touching a
//   Node builtin, `process.env.CI` below stops resolving; add @types/node to
//   that array rather than reaching for `any`.

import { defineConfig } from "@playwright/test";
import { E2E_ADMIN_TOKEN, E2E_BASE_URL, E2E_PORT } from "./test/e2e/_config";

export default defineConfig({
  testDir: "./test/e2e",

  // One server, shared by every spec, and the per-bearer rate counter in the
  // Meter DO is shared state keyed by the single ADMIN_TOKEN below. Parallel
  // workers would couple otherwise-independent tests through that counter.
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL: E2E_BASE_URL,
  },

  webServer: {
    // --var supplies ADMIN_TOKEN (a `wrangler secret` in every real
    // environment) without writing a .dev.vars the run would have to clean up.
    // Everything else is left alone deliberately: the point is to exercise the
    // shipped config, so no other var is overridden here.
    //
    // --persist-to keeps this server's KV and Durable Object state out of
    // .wrangler/state, so a token left behind by someone's `npm run dev`
    // cannot change what these tests see, or vice versa.
    //
    // The wipe in front of it is not tidiness. The Meter DO's rate counter is
    // keyed by bearer-hash + epoch-minute and only prunes buckets older than
    // two minutes (src/meter/meter.ts), and every spec authenticates as the
    // one E2E_ADMIN_TOKEN — so without this, reruns inside the same wall-clock
    // minute accumulate into a single bucket and eventually trip PER_BEARER_RPM
    // (60), failing tests for a reason that has nothing to do with the change
    // being debugged. CI never sees it (fresh checkout); the local dev loop
    // does. rmSync via node rather than `rm -rf` so the command is not
    // shell-specific.
    command: [
      `node -e "require('fs').rmSync('.wrangler/e2e-state',{recursive:true,force:true})"`,
      "&& npx wrangler dev",
      `--port ${E2E_PORT}`,
      `--var ADMIN_TOKEN:${E2E_ADMIN_TOKEN}`,
      "--persist-to .wrangler/e2e-state",
    ].join(" "),
    // /health is the public route, so the readiness probe needs no credential.
    url: `${E2E_BASE_URL}/health`,
    // Never adopt a server someone already had running: it would have a
    // different ADMIN_TOKEN (or none), and the failure would surface as a
    // confusing 401 rather than "the server is not the one this suite booted".
    reuseExistingServer: false,
    // workerd cold start on a clean checkout is the slow part, not the worker.
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
