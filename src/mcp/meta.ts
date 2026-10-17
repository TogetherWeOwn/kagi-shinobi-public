// MetaBlock helpers. Every canonical response type carries a MetaBlock so
// callers can budget cost, spot cache hits, and correlate with Kagi trace IDs.

import type { ImplKind, MetaBlock } from "../kagi/types.js";

export interface MetaInit {
  impl: ImplKind;
  start_ms: number;
  cache_hit?: boolean;
  cache_age_s?: number;
  cost_cents?: number;
  trace_id?: string;
  session_stale?: boolean;
  refresh_triggered?: boolean;
  warnings?: string[];
}

export function buildMeta(init: MetaInit): MetaBlock {
  const meta: MetaBlock = {
    impl: init.impl,
    cache_hit: init.cache_hit ?? false,
    elapsed_ms: Math.max(0, Date.now() - init.start_ms),
  };
  if (init.cache_age_s !== undefined) meta.cache_age_s = init.cache_age_s;
  if (init.cost_cents !== undefined) meta.cost_cents = init.cost_cents;
  if (init.trace_id) meta.trace_id = init.trace_id;
  if (init.session_stale !== undefined) meta.session_stale = init.session_stale;
  if (init.refresh_triggered !== undefined) meta.refresh_triggered = init.refresh_triggered;
  if (init.warnings && init.warnings.length > 0) meta.warnings = init.warnings;
  return meta;
}

export function addWarning(meta: MetaBlock, msg: string): MetaBlock {
  const list = meta.warnings ? [...meta.warnings, msg] : [msg];
  return { ...meta, warnings: list };
}
