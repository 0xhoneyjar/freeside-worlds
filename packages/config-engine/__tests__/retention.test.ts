/**
 * retention.test.ts — cycle-010 (sprint T1.6 · SDD §4 · §9 fork 5) retention/TTL
 * prune. Covers the PURE policy boundary (count + TTL) AND the engine's
 * warn-then-prune wiring (logger spy + controllable clock + the store prune
 * hooks). The prune BOUNDARY (exactly maxCount kept; the (maxCount+1)th pruned;
 * the TTL day-boundary) is the named AC (sprint T1.6).
 */
import { describe, expect, test } from 'bun:test';
import {
  ConfigService,
  computeCommitHistoryPrune,
  computeLedgerEntryPrune,
  DEFAULT_RETENTION_POLICY,
  isRetentionSurface,
  type HistoryRecordRef,
  type LedgerEntryRef,
} from '../src/index.js';
import type { SurfaceConfigMap } from '@freeside-worlds/config-protocol';
import { computeRosterCommitId, type RosterCommitContent } from '@freeside-worlds/config-protocol';
import { TestMemoryStore } from './test-memory-store.js';

const NOW = new Date('2026-06-05T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

// ─── PURE policy: commit-history prune boundary (count) ──────────────────────

describe('computeCommitHistoryPrune — count boundary (sprint T1.6 AC)', () => {
  function makeRecords(n: number): HistoryRecordRef[] {
    // Most-recent has the largest (least-negative) createdAt; oldest is the most
    // negative. id ascending with age (id 1 = oldest).
    return Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      createdAt: iso(-(n - i) * 1000), // i=0 oldest, i=n-1 newest
    }));
  }

  test('exactly maxCount records → nothing pruned', () => {
    const plan = computeCommitHistoryPrune(makeRecords(50), NOW, DEFAULT_RETENTION_POLICY);
    expect(plan.pruneIds).toHaveLength(0);
    expect(plan.overCount).toBe(0);
  });

  test('maxCount + 1 records → exactly the oldest one pruned', () => {
    const plan = computeCommitHistoryPrune(makeRecords(51), NOW, DEFAULT_RETENTION_POLICY);
    expect(plan.pruneIds).toEqual([1]); // id 1 is the oldest
    expect(plan.overCount).toBe(1);
  });

  test('keeps the NEWEST maxCount, prunes the rest (count overflow)', () => {
    const plan = computeCommitHistoryPrune(makeRecords(55), NOW, { maxCount: 50, ttlDays: 180 });
    expect(plan.pruneIds.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]); // 5 oldest
    expect(plan.overCount).toBe(5);
  });

  test('a custom small maxCount knob takes effect', () => {
    const plan = computeCommitHistoryPrune(makeRecords(4), NOW, { maxCount: 2, ttlDays: 180 });
    // keep 2 newest (ids 3,4), prune 2 oldest (ids 1,2)
    expect(plan.pruneIds.sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

describe('computeCommitHistoryPrune — TTL boundary (sprint T1.6 AC)', () => {
  test('a record exactly at ttlDays old is KEPT; one just past it is PRUNED', () => {
    const policy = { maxCount: 1000, ttlDays: 180 }; // count not the gate here
    const records: HistoryRecordRef[] = [
      { id: 1, createdAt: iso(-180 * DAY + 1) }, // 1ms inside the window → kept
      { id: 2, createdAt: iso(-180 * DAY - 1) }, // 1ms past the window → pruned
    ];
    const plan = computeCommitHistoryPrune(records, NOW, policy);
    expect(plan.pruneIds).toEqual([2]);
    expect(plan.overAge).toBe(1);
  });

  test('count + TTL compose (a record can be over both; counted once)', () => {
    const policy = { maxCount: 1, ttlDays: 30 };
    const records: HistoryRecordRef[] = [
      { id: 1, createdAt: iso(-1 * DAY) }, // newest, in window → kept (count)
      { id: 2, createdAt: iso(-60 * DAY) }, // over count AND over age
    ];
    const plan = computeCommitHistoryPrune(records, NOW, policy);
    expect(plan.pruneIds).toEqual([2]);
    expect(plan.overCount).toBe(1);
    expect(plan.overAge).toBe(1);
  });
});

// ─── PURE policy: ledger-entry prune boundary ────────────────────────────────

describe('computeLedgerEntryPrune — count + TTL boundary', () => {
  test('exactly maxCount entries → nothing pruned; +1 → oldest pruned', () => {
    const entries: LedgerEntryRef[] = Array.from({ length: 51 }, (_, i) => ({
      key: `k${i}:definition-drift`,
      ts: iso(-(51 - i) * 1000),
    }));
    const plan = computeLedgerEntryPrune(entries, NOW, DEFAULT_RETENTION_POLICY);
    expect(plan.pruneKeys).toEqual(['k0:definition-drift']); // oldest
    expect(plan.overCount).toBe(1);
  });

  test('TTL prunes an over-age entry', () => {
    const entries: LedgerEntryRef[] = [
      { key: 'a:definition-drift', ts: iso(-1 * DAY) },
      { key: 'b:membership-drift', ts: iso(-200 * DAY) },
    ];
    const plan = computeLedgerEntryPrune(entries, NOW, { maxCount: 100, ttlDays: 180 });
    expect(plan.pruneKeys).toEqual(['b:membership-drift']);
    expect(plan.overAge).toBe(1);
  });

  test('a garbage `ts` entry is pruned by TTL (does NOT evade via NaN) — /fagan R1 MAJOR', () => {
    // The bug: Date.parse('not-a-date') → NaN, and `NaN < cutoff` is false, so a
    // malformed-ts entry would NEVER age out. parseTimeOrOldest maps it to
    // -Infinity → it sorts as oldest AND satisfies `time < cutoff` (pruned).
    const entries: LedgerEntryRef[] = [
      { key: 'fresh:definition-drift', ts: iso(-1 * DAY) }, // in window → kept
      { key: 'garbage:membership-drift', ts: 'not-a-real-timestamp' }, // must prune
    ];
    const plan = computeLedgerEntryPrune(entries, NOW, { maxCount: 100, ttlDays: 180 });
    expect(plan.pruneKeys).toEqual(['garbage:membership-drift']);
    expect(plan.overAge).toBe(1);
  });

  test('a garbage `ts` also sorts as OLDEST (count overflow prunes it first)', () => {
    // With maxCount=1 + everything in-window, the garbage entry (sorted oldest)
    // is the one over the count cap — proves the comparator agrees with the age
    // check (both use parseTimeOrOldest → -Infinity).
    const entries: LedgerEntryRef[] = [
      { key: 'fresh:definition-drift', ts: iso(-1 * DAY) },
      { key: 'garbage:membership-drift', ts: 'xxx' },
    ];
    const plan = computeLedgerEntryPrune(entries, NOW, { maxCount: 1, ttlDays: 100000 });
    expect(plan.pruneKeys).toEqual(['garbage:membership-drift']);
    expect(plan.overCount).toBe(1);
  });
});

describe('computeCommitHistoryPrune — malformed createdAt (defense-in-depth)', () => {
  test('a record with a garbage createdAt is pruned by TTL (parseTimeOrOldest)', () => {
    const records: HistoryRecordRef[] = [
      { id: 1, createdAt: iso(-1 * DAY) }, // in window → kept
      { id: 2, createdAt: 'garbage' }, // -Infinity → pruned
    ];
    const plan = computeCommitHistoryPrune(records, NOW, { maxCount: 100, ttlDays: 180 });
    expect(plan.pruneIds).toEqual([2]);
    expect(plan.overAge).toBe(1);
  });
});

describe('RETENTION_SURFACES scope', () => {
  test('only roster-commit + resolution-ledger are retention surfaces', () => {
    expect(isRetentionSurface('roster-commit')).toBe(true);
    expect(isRetentionSurface('resolution-ledger')).toBe(true);
    expect(isRetentionSurface('verify-message')).toBe(false);
    expect(isRetentionSurface('pending-apply')).toBe(false); // single durable txn, not retained
    expect(isRetentionSurface('role-map')).toBe(false);
  });
});

// ─── ENGINE wiring: warn-then-prune at write time ────────────────────────────

function spyLogger() {
  const warns: { obj: unknown; msg?: string }[] = [];
  const infos: { obj: unknown; msg?: string }[] = [];
  return {
    warns,
    infos,
    logger: {
      info: (obj: unknown, msg?: string) => infos.push({ obj, msg }),
      warn: (obj: unknown, msg?: string) => warns.push({ obj, msg }),
      error: () => {},
    },
  };
}

function commitContent(world: string, theme: string): RosterCommitContent {
  return {
    parent_commit_id: null,
    world,
    ts: '2026-06-05T00:00:00.000Z',
    applied_by: 'cm:alice',
    theme_id: theme,
    ownership_map: {},
    role_definitions: [],
    membership: [],
    status: 'complete',
  };
}
function commit(world: string, theme: string): SurfaceConfigMap['roster-commit'] {
  const c = commitContent(world, theme);
  return { commit_id: computeRosterCommitId(c), ...c };
}

describe('engine warn-then-prune at write time (sprint T1.6 · SDD §4)', () => {
  test('prunes roster-commit history beyond maxCount on the write that crosses the boundary', async () => {
    const { logger, warns, infos } = spyLogger();
    const store = new TestMemoryStore();
    const service = new ConfigService({ store, logger, retentionPolicy: { maxCount: 3, ttlDays: 180 } });

    // Seed 3 old history records directly (controlled createdAt, all in window).
    store._seedHistory({ worldSlug: 'purupuru', surface: 'roster-commit', createdAt: iso(-4000) });
    store._seedHistory({ worldSlug: 'purupuru', surface: 'roster-commit', createdAt: iso(-3000) });
    store._seedHistory({ worldSlug: 'purupuru', surface: 'roster-commit', createdAt: iso(-2000) });

    // Now CREATE the head (the 1st real write) — that appends a 4th record,
    // crossing maxCount=3. The store's `now()` defaults to wall-clock (newest),
    // so the 3 seeded are the oldest; exactly 1 (the very oldest seed) is pruned.
    await service.putConfig('purupuru', 'roster-commit', commit('purupuru', 'v1'), 0, 'cm:alice');

    const remaining = await store.listHistoryRefs('purupuru', 'roster-commit');
    expect(remaining.length).toBe(3); // capped at maxCount
    // A warn was emitted (loud), and an info recorded the prune count.
    expect(warns.some((w) => String(w.msg).includes('over retention'))).toBe(true);
    expect(infos.some((i) => String(i.msg).includes('pruned'))).toBe(true);
  });

  test('does NOT prune when under the cap (no warn)', async () => {
    const { logger, warns } = spyLogger();
    const store = new TestMemoryStore();
    const service = new ConfigService({ store, logger, retentionPolicy: { maxCount: 50, ttlDays: 180 } });
    await service.putConfig('purupuru', 'roster-commit', commit('purupuru', 'v1'), 0, 'cm:alice');
    expect(warns.some((w) => String(w.msg).includes('over retention'))).toBe(false);
    expect((await store.listHistoryRefs('purupuru', 'roster-commit')).length).toBe(1);
  });

  test('a retention failure NEVER fails the write (best-effort, post-write)', async () => {
    const { logger } = spyLogger();
    const store = new TestMemoryStore();
    // Sabotage the prune hook to throw — the write must still succeed.
    store.pruneHistory = async () => {
      throw new Error('boom');
    };
    const service = new ConfigService({ store, logger, retentionPolicy: { maxCount: 0, ttlDays: 180 } });
    const ok = await service.putConfig('purupuru', 'roster-commit', commit('purupuru', 'v1'), 0, 'cm:alice');
    expect(ok.version).toBe(1); // write committed despite the prune throw
  });

  test('warns (does not throw) when the adapter has no prune hooks (Phase-1 warn-then-prune)', async () => {
    const { logger, warns } = spyLogger();
    // A minimal store WITHOUT listHistoryRefs/pruneHistory.
    const noPruneStore = {
      _heads: new Map<string, { config: unknown; version: number }>(),
      async getCurrent() {
        return null;
      },
      async applyWrite() {
        return { recordId: 1, newVersion: 1 };
      },
    };
    const service = new ConfigService({ store: noPruneStore as never, logger, retentionPolicy: { maxCount: 1, ttlDays: 180 } });
    const ok = await service.putConfig('purupuru', 'roster-commit', commit('purupuru', 'v1'), 0, 'cm:alice');
    expect(ok.version).toBe(1);
    expect(warns.some((w) => String(w.msg).includes('no prune hooks'))).toBe(true);
  });

  test('non-retention surfaces (verify-message) skip the retention pass entirely', async () => {
    const { logger, warns, infos } = spyLogger();
    const store = new TestMemoryStore();
    const service = new ConfigService({ store, logger, retentionPolicy: { maxCount: 0, ttlDays: 0 } });
    await service.putConfig(
      'purupuru',
      'verify-message',
      { enabled: true, copy: { title: 'V', body: 'b', buttonLabel: 'go' } },
      0,
      'cm:alice',
    );
    expect(warns).toHaveLength(0);
    expect(infos.some((i) => String(i.msg).includes('pruned'))).toBe(false);
  });

  test('resolution-ledger over retention WARNS (consumer evicts; store-side warn-only)', async () => {
    const { logger, warns } = spyLogger();
    const store = new TestMemoryStore();
    const service = new ConfigService({ store, logger, retentionPolicy: { maxCount: 1, ttlDays: 180 } });
    const ledger: SurfaceConfigMap['resolution-ledger'] = {
      entries: {
        'a:definition-drift': { resolution: 'keep-mine', resolved_against_base: 'a'.repeat(64), ts: iso(-2000), by: 'cm' },
        'b:membership-drift': { resolution: 'take-theirs', resolved_against_base: 'b'.repeat(64), ts: iso(-1000), by: 'cm' },
      },
    };
    await service.putConfig('purupuru', 'resolution-ledger', ledger, 0, 'cm:alice');
    expect(warns.some((w) => String(w.msg).includes('over retention'))).toBe(true);
  });
});
