// Env binding surface.
//
// wrangler.jsonc bindings + vars are generated into worker-configuration.d.ts
// by `wrangler types`, which populates `Cloudflare.Env`. Secrets don't live in
// wrangler.jsonc (they're set at runtime via `wrangler secret put`), so we
// augment Cloudflare.Env below so the type system knows they exist.
//
// If you add a new binding or a new var, edit wrangler.jsonc and re-run
// `npm run cf-typegen`. If you add a new secret, add it to this augmentation.
//
// The typegen runs with `--strict-vars=false` on purpose. Wrangler's default
// types each var as the literal currently sitting in wrangler.jsonc —
// `KAGI_MODE: "scrape"`, `PER_BEARER_RPM: "60"` — which is a fact about the
// config file, not about runtime. Vars are operator-tunable, so the literals
// are wrong the moment anyone changes one: `mode === "api"` becomes a
// comparison TypeScript rejects as impossible, though the tri-mode dispatcher
// in ADR 0001 exists precisely to handle the other three values, and a test
// setting PER_BEARER_RPM to "0" stops type-checking against a "60" literal.
// Declaring a var here instead does NOT widen the generated member — it
// contradicts it, which TypeScript 7 reports as TS2430 and TypeScript 5.9
// silently accepted. Keep vars out of this augmentation.

declare global {
  namespace Cloudflare {
    interface Env {
      // Secrets only.
      ADMIN_TOKEN: string;
      // Scrape mode
      KAGI_SESSION_TOKEN?: string;
      KAGI_EMAIL?: string;
      KAGI_PASSWORD?: string;
      // Official API mode (S3+). When absent, api-mode calls throw
      // KagiNotConfiguredError before hitting the network.
      KAGI_API_KEY?: string;
      CAPTCHA_WEBHOOK_URL?: string;
      // Scoped client keys, JSON {name: sha256hex(key)}. See ADR 0013.
      CLIENT_KEYS?: string;
      // SearXNG fallback (ADR 0014). SEARXNG_BASE_URL is a var in
      // wrangler.jsonc (a hostname, not a credential); the Access service
      // token pair are secrets, set only when the Tunnel sits behind
      // Cloudflare Access. Absent for a VPC-adjacent binding.
      SEARXNG_ACCESS_CLIENT_ID?: string;
      SEARXNG_ACCESS_CLIENT_SECRET?: string;
    }
  }
}

export type Env = Cloudflare.Env;
