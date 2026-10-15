# Changelog

## 1.0.0 (2026-10-05)


### Features

* add kagi-shinobi ECC bundle ([#29](https://github.com/TogetherWeOwn/kagi-shinobi/issues/29)) ([af25192](https://github.com/TogetherWeOwn/kagi-shinobi/commit/af2519297c5e8727adb9e5d98fd90f4690214aae))
* **cache:** wire read-through result cache that works on workers.dev ([#47](https://github.com/TogetherWeOwn/kagi-shinobi/issues/47)) ([2787b23](https://github.com/TogetherWeOwn/kagi-shinobi/commit/2787b23b4bd0da01bf07145b82edbf1ab83aa2b5))
* **mcp:** concise search output with stable citation ids and dedupe ([#42](https://github.com/TogetherWeOwn/kagi-shinobi/issues/42)) ([6a721f7](https://github.com/TogetherWeOwn/kagi-shinobi/commit/6a721f70de985d6d0b0f129cc8d5b696adc52c65))
* scoped client keys, global Kagi call budget, SearXNG GET /search ([#41](https://github.com/TogetherWeOwn/kagi-shinobi/issues/41)) ([5d5ecca](https://github.com/TogetherWeOwn/kagi-shinobi/commit/5d5eccaf026ac940d2641bca15f8a7224c8e686b))
* **search:** add SearXNG fallback engine behind engine=auto ([#45](https://github.com/TogetherWeOwn/kagi-shinobi/issues/45)) ([c4f69a8](https://github.com/TogetherWeOwn/kagi-shinobi/commit/c4f69a8a4c58dcef86f407a4eb19638e1cb96495))


### Bug Fixes

* bound per-request fan-out, and stop overclaiming in the auth comment ([#18](https://github.com/TogetherWeOwn/kagi-shinobi/issues/18)) ([5af83c9](https://github.com/TogetherWeOwn/kagi-shinobi/commit/5af83c9fb902a046691484f9a2c5535d01f8bb47))
* bound token cache staleness and coordinate browser refreshes ([#15](https://github.com/TogetherWeOwn/kagi-shinobi/issues/15)) ([9757843](https://github.com/TogetherWeOwn/kagi-shinobi/commit/97578435ce70ce03e8507bd0a49d172c86d6fbd1))
* **ci:** list both sides of a rename in the change filter ([#57](https://github.com/TogetherWeOwn/kagi-shinobi/issues/57)) ([74c1939](https://github.com/TogetherWeOwn/kagi-shinobi/commit/74c19390189c87a3add310c820de22c110ebff30))
* mark deep_research_plan's budget_cents optional, as it always claimed ([#21](https://github.com/TogetherWeOwn/kagi-shinobi/issues/21)) ([ba27694](https://github.com/TogetherWeOwn/kagi-shinobi/commit/ba276941ea136510276de1d47b3533b16be0a2cf))
* one error vocabulary — REST status stops depending on which class was thrown ([#28](https://github.com/TogetherWeOwn/kagi-shinobi/issues/28)) ([0003fd5](https://github.com/TogetherWeOwn/kagi-shinobi/commit/0003fd51a41b88a844115df41f69a049ca5331d3))
* one MCP error envelope — kagi_summarizer stops disagreeing with itself ([#25](https://github.com/TogetherWeOwn/kagi-shinobi/issues/25)) ([34c20d5](https://github.com/TogetherWeOwn/kagi-shinobi/commit/34c20d5e99d69cbe1538adf91b8dc2eef56759e8))
* parse Small Web feed as Atom and correct the v0 feed URL ([#2](https://github.com/TogetherWeOwn/kagi-shinobi/issues/2)) ([a38e632](https://github.com/TogetherWeOwn/kagi-shinobi/commit/a38e6322324d7ffa737988497f60de7edf4cdb25))
* **scrape:** refresh Chrome fingerprint and fail loudly on markup change ([#46](https://github.com/TogetherWeOwn/kagi-shinobi/issues/46)) ([991ffd1](https://github.com/TogetherWeOwn/kagi-shinobi/commit/991ffd15e0b04be2811629b6236773e53e76407f))
* withhold token state from unauthenticated /health callers ([#14](https://github.com/TogetherWeOwn/kagi-shinobi/issues/14)) ([7148edf](https://github.com/TogetherWeOwn/kagi-shinobi/commit/7148edf1f6696ce017488c20e20abe11db9af04b))
