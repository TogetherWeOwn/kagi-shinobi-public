# Dependency security maintenance

## Installation policy

The project `.npmrc` disables automatic lifecycle scripts and requires a three-day
release age for new resolutions. npm 11.19.0 supports both settings. Older npm
versions may ignore `min-release-age`; use a supporting npm version when resolving
updates. A frozen install does not retrospectively check publication ages in an
existing lockfile.

Keep `ignore-scripts=true` for clean installs, including CI. Run the named commands
in `package.json` explicitly; do not enable all install scripts to fix a missing
binary. The locked install-hook candidates are `core-js-pure@3.50.0`,
`esbuild@0.28.1` and `0.28.2`, `fsevents@2.3.3`, and
`workerd@1.20260815.1` and `1.20261023.1`. None has an approved script exception.
The clean install, type generation, tests, bundle dry-run and HTTP E2E checks in
GitHub Actions must verify that the optional native packages suffice without
those hooks. If they do not, review the exact artifact and a narrow exception
rather than disabling this policy globally.

## Compatible security group (2026-11-09)

Only these five lockfile entries change; the direct manifest ranges and all
other resolutions stay unchanged:

| Package | Before | After | Dependabot alert numbers |
| --- | --- | --- | --- |
| `body-parser` | 2.3.0 | 2.4.0 | 26 |
| `fast-uri` | 3.1.8 | 3.1.9 | 27–30 |
| `ip-address` | 10.7.2 | 10.7.4 | 24 |
| `qs` | 6.16.0 | 6.16.1 | 34 |
| `vite` | 8.3.2 | 8.3.3 | 17–22 |

These are the minimum patched versions covering all advisories observed for
these packages, not a claim that the whole dependency tree is clean. Registry
publication timestamps for all five predate the three-day cutoff. Node 22 meets
their engine requirements.

Resolution used npm 11.19.0 with an explicit five-package update allowlist.
Temporary resolution-only overrides selected the versions above and retained
`rolldown@1.2.12` and `postcss@8.5.28`; they were removed before validation and
are not part of the manifest. The initial unconstrained allowlist attempt also
moved Rolldown's exact-pinned native bindings, so that attempt was discarded.
Comparing every installed exact dependency edge before and after the final update
found no drift across 223 held package paths, including nested copies. No
installed dependency-version assertions or additional security pin guard existed
in the tests. No override is introduced to force an incompatible dependency.

The existing CI suite is the compatibility/regression check; no application
behavior or test expectation changes. Full suites run in GitHub Actions, not as
local CI mirrors. `npm ci --dry-run` only validates lock/manifest consistency;
it is not clean-install or build evidence.

## Unresolved, separately scoped work

The compatible group addresses 13 of the 29 observed alert records. The other 16
remain unresolved pending a separately reviewed parent upgrade or replacement:

- `miniflare@5.20260815.0-alpha` pins `sharp@0.35.2` and `undici@7.29.0`.
  The required advisory floors are `sharp@0.35.5` (both sharp advisories) and
  `undici@7.30.1` (all eleven observed undici advisories). The worker test pool
  owns this older Miniflare. The separate Wrangler subtree already has those
  patched versions; upgrading only the root Wrangler does not repair the test
  pool's copies.
- The Puppeteer dependency chain uses `basic-ftp@5.3.1`; the reported patch is
  `6.2.1`, outside its parent's `^5.0.2` range. Do not force a major override.
- `extract-zip@2.0.1` has two advisories without a patched release in the
  observed metadata. Review a supported parent replacement or removal; do not
  claim this is fixed by choosing a different minimum patched version.
- The post-update npm audit also reports the test pool's exact-pinned
  `zod@4.4.3` (the advisory floor is `4.6.6`). This is additional residual work,
  not one of the original 29 Dependabot alert records.

The post-update npm audit reports 13 vulnerable package records (12 high and
one moderate), including affected ancestor packages. Package records, unique
advisories and Dependabot alert records are different counts. These findings are
not dismissed, accepted as safe, or evidence of proven runtime exploitation.

Existing dependency PRs updating Wrangler and agents do not own this five-package
group and must not be modified as part of it. Preserve source reconciliation,
installation, release and repository-retirement holds; this maintenance does not
authorize a deployment or an archive.
