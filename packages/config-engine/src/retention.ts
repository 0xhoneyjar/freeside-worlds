/**
 * retention.ts — cycle-010 (Roles-as-Code) NET-NEW retention/TTL prune policy
 * (sprint T1.6 · SDD §4 · §9 fork 5).
 *
 * The store is append-only — it had NO prune logic before this. RosterCommit
 * history (the `roster-commit` surface's config_record log) and the
 * ResolutionLedger grow unbounded without a retention policy. Phase-1 (§9 fork 5:
 * "ship the knobs + warn; prune is a fast-follow") = a PURE policy computing what
 * is over-retention + a WARN log at write time. The actual delete is gated on an
 * adapter implementing the optional `pruneHistory` port method; until then the
 * policy WARNS (loud, never silent growth) — exactly the warn-then-prune posture.
 *
 * Two retention surfaces (SDD §4):
 *   • `roster-commit`     — APPEND-ONLY history; prune by record count (last-N)
 *                           + age (TTL). `computeCommitHistoryPrune`.
 *   • `resolution-ledger` — ONE versioned document; prune by ENTRY count (last-N
 *                           by `ts`) + age (TTL). `computeLedgerEntryPrune`.
 *
 * Defaults (SDD §9 fork 5): last-50 + 180d. Both are knobs (`RetentionPolicy`).
 *
 * PURE: no I/O, no clock — the caller passes `now` so the boundary is testable.
 */

import type { Surface } from '@freeside-worlds/config-protocol';

/** The two surfaces under retention (sprint T1.6 / SDD §4). */
export const RETENTION_SURFACES: ReadonlySet<Surface> = new Set<Surface>([
  'roster-commit',
  'resolution-ledger',
]);

export function isRetentionSurface(surface: Surface): boolean {
  return RETENTION_SURFACES.has(surface);
}

/** Knobs (SDD §9 fork 5 defaults). Both tunable per-deployment. */
export interface RetentionPolicy {
  /** keep at most this many (commit history records / ledger entries). */
  maxCount: number;
  /** drop anything older than this many days. */
  ttlDays: number;
}

/** SDD §9 fork 5: last-50 + 180d. */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  maxCount: 50,
  ttlDays: 180,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * cycle-010 (/fagan R1 MAJOR) — parse an iso timestamp, mapping an UNPARSEABLE
 * value to NEGATIVE_INFINITY ("oldest possible") rather than NaN.
 *
 * THE BUG THIS CLOSES: `Date.parse(garbage)` → NaN, and `NaN < cutoffMs` is
 * `false`, so a malformed-`ts` entry would NEVER age out of the TTL prune — a
 * caller could pin a stale resolution forever with a garbage `ts`. Mapping a
 * bad timestamp to -Infinity makes it sort as the OLDEST entry AND always
 * satisfy `time < cutoffMs` (it is pruned by both count overflow and TTL).
 * Used by BOTH the sort comparator AND the `beyondAge` check so the two agree.
 */
function parseTimeOrOldest(ts: string): number {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * A history record reference the prune policy reasons over. The store supplies
 * `id` (the config_record id) + `createdAt` (iso); the policy returns the ids to
 * prune. Deliberately minimal — the policy does not touch payloads.
 */
export interface HistoryRecordRef {
  id: number;
  /** iso-8601. */
  createdAt: string;
}

/** What a prune pass would remove + WHY (for the warn log). */
export interface CommitPrunePlan {
  /** record ids to prune (over-count OR over-age). */
  pruneIds: number[];
  /** how many exceeded the count cap. */
  overCount: number;
  /** how many exceeded the TTL. */
  overAge: number;
  /** total records considered. */
  total: number;
}

/**
 * Compute which `roster-commit` history records are over-retention (PURE).
 * Records are ordered most-recent-first by `createdAt` (ties broken by id desc),
 * then: keep the newest `maxCount`; anything beyond that OR older than `ttlDays`
 * is pruned. A record can be in BOTH sets (counted once in `pruneIds`).
 *
 * NOTE: genesis/parent-chain integrity is the CONSUMER's concern — Phase-1 prune
 * is warn-only, so it never actually severs a chain; when prune graduates, the
 * consumer (apply planner) must keep the base commit reachable. The policy here
 * only IDENTIFIES candidates; it does not enforce chain reachability.
 */
export function computeCommitHistoryPrune(
  records: ReadonlyArray<HistoryRecordRef>,
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): CommitPrunePlan {
  const sorted = [...records].sort((a, b) => {
    // /fagan R1 MAJOR: an unparseable createdAt maps to -Infinity (oldest), so a
    // malformed record sorts last AND is pruned by both count + TTL (never NaN).
    const at = parseTimeOrOldest(a.createdAt);
    const bt = parseTimeOrOldest(b.createdAt);
    if (bt !== at) return bt - at; // most-recent first
    return b.id - a.id; // tie-break: higher id (later) first
  });

  const cutoffMs = now.getTime() - policy.ttlDays * MS_PER_DAY;
  const prune = new Set<number>();
  let overCount = 0;
  let overAge = 0;

  sorted.forEach((rec, idx) => {
    const beyondCount = idx >= policy.maxCount;
    const beyondAge = parseTimeOrOldest(rec.createdAt) < cutoffMs;
    if (beyondCount) overCount++;
    if (beyondAge) overAge++;
    if (beyondCount || beyondAge) prune.add(rec.id);
  });

  return {
    pruneIds: [...prune],
    overCount,
    overAge,
    total: records.length,
  };
}

/** A ResolutionLedger entry reference the prune policy reasons over. */
export interface LedgerEntryRef {
  /** the composite "role_key:conflict_type" key. */
  key: string;
  /** iso-8601 of the resolution. */
  ts: string;
}

/** What a ledger prune pass would remove + WHY. */
export interface LedgerPrunePlan {
  /** composite keys to prune (over-count OR over-age). */
  pruneKeys: string[];
  overCount: number;
  overAge: number;
  total: number;
}

/**
 * Compute which `resolution-ledger` ENTRIES are over-retention (PURE). The
 * ledger is one versioned document, so retention is per-ENTRY: keep the newest
 * `maxCount` entries by `ts`; anything beyond that OR older than `ttlDays` is
 * pruned.
 *
 * IMPORTANT — this is distinct from the STALENESS eviction (SDD §2.5 SKP-002,
 * per-slice base move): staleness is a CONSUMER decision (the apply planner
 * evicts an entry when ITS slice base moved). Retention here is the BOUNDED-SIZE
 * policy (age + count) that prevents unbounded ledger growth — orthogonal to
 * staleness, and the only thing the store-side policy enforces.
 */
export function computeLedgerEntryPrune(
  entries: ReadonlyArray<LedgerEntryRef>,
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): LedgerPrunePlan {
  const sorted = [...entries].sort((a, b) => {
    // /fagan R1 MAJOR: an unparseable `ts` maps to -Infinity (oldest), so a
    // garbage-`ts` entry sorts last AND is pruned by both count + TTL — it can
    // no longer evade the TTL via `NaN < cutoff === false`.
    const at = parseTimeOrOldest(a.ts);
    const bt = parseTimeOrOldest(b.ts);
    if (bt !== at) return bt - at; // most-recent first
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; // stable tie-break
  });

  const cutoffMs = now.getTime() - policy.ttlDays * MS_PER_DAY;
  const prune = new Set<string>();
  let overCount = 0;
  let overAge = 0;

  sorted.forEach((entry, idx) => {
    const beyondCount = idx >= policy.maxCount;
    const beyondAge = parseTimeOrOldest(entry.ts) < cutoffMs;
    if (beyondCount) overCount++;
    if (beyondAge) overAge++;
    if (beyondCount || beyondAge) prune.add(entry.key);
  });

  return {
    pruneKeys: [...prune],
    overCount,
    overAge,
    total: entries.length,
  };
}
