/**
 * role-map-additivity.test.ts — cycle-010 (sprint T1.2 · FR-2/FR-3) the
 * additivity proof: existing stored role-maps validate + round-trip through
 * PUT/GET with NO migration for the `owner` field, plus a backfill helper for the
 * one field S2 made required (`display_name`).
 *
 * ── HONEST ADDITIVITY (verified, not assumed) ───────────────────────────────
 *   • `owner` is PLAIN-OPTIONAL in S2 → a role-map WITHOUT `owner` decodes +
 *     round-trips UNCHANGED (the consumer applies `owner ?? 'manual'`). This is
 *     the genuine cycle-010 additive proof.
 *   • `display_name` is REQUIRED in S2 (FR-2 mutable Discord name) → a TRULY
 *     pre-S2 map (no display_name) does NOT decode. `backfillRoleMapDisplayNames`
 *     (pure, default = role_key) migrates it to a decodable shape with zero
 *     manual edits — the additivity is preserved THROUGH the backfill, not by
 *     pretending the field was always optional.
 */
import { describe, expect, test } from 'bun:test';
import { ConfigService, ConfigValidationError } from '../src/index.js';
import {
  validateSurfacePayload,
  backfillRoleMapDisplayNames,
  type SurfaceConfigMap,
} from '@freeside-worlds/config-protocol';
import { TestMemoryStore } from './test-memory-store.js';

function newService() {
  const store = new TestMemoryStore();
  return { store, service: new ConfigService({ store }) };
}

describe('role-map additivity — owner is optional (genuine additive proof)', () => {
  // A role-map carrying display_name but NO `owner` — the cycle-010 additive case.
  const noOwnerMap: SurfaceConfigMap['role-map'] = {
    enabled: true,
    namespace_prefix: 'pp',
    rules: [
      {
        role_key: 'pp:sovereign',
        display_name: 'Sovereign',
        qualifies: { source: 'tier', min_tier: 'gold' },
        create_if_absent: true,
      },
    ],
  };

  test('a role-map with NO owner field validates (owner optional)', () => {
    const r = validateSurfacePayload('purupuru', 'role-map', noOwnerMap);
    expect(r.ok).toBe(true);
  });

  test('a role-map with NO owner round-trips PUT→GET unchanged', async () => {
    const { service } = newService();
    const ok = await service.putConfig('purupuru', 'role-map', noOwnerMap, 0, 'cm:alice');
    expect(ok.version).toBe(1);
    const read = await service.getConfig('purupuru', 'role-map');
    const got = read!.envelope.config as SurfaceConfigMap['role-map'];
    // `owner` stays ABSENT (not coerced to a value) — preserves the frozen hash.
    expect(('owner' in got.rules[0]!)).toBe(false);
    expect(got.rules[0]!.display_name).toBe('Sovereign');
  });

  test('a role-map WITH explicit owner also validates + round-trips (the new path)', async () => {
    const { service } = newService();
    const withOwner: SurfaceConfigMap['role-map'] = {
      ...noOwnerMap,
      rules: [{ ...noOwnerMap.rules[0]!, owner: 'freeside' }],
    };
    const ok = await service.putConfig('purupuru', 'role-map', withOwner, 0, 'cm:alice');
    expect(ok.version).toBe(1);
    const read = await service.getConfig('purupuru', 'role-map');
    expect((read!.envelope.config as SurfaceConfigMap['role-map']).rules[0]!.owner).toBe('freeside');
  });
});

describe('role-map additivity — display_name backfill (sprint T1.2)', () => {
  // A TRULY pre-S2 role-map: NO display_name, NO owner.
  const preS2Raw = {
    enabled: true,
    namespace_prefix: 'pp',
    rules: [
      { role_key: 'pp:sovereign', qualifies: { source: 'tier', min_tier: 'gold' }, create_if_absent: true },
      { role_key: 'pp:initiate', qualifies: { source: 'tier', min_tier: 'bronze' }, create_if_absent: true },
    ],
  };

  test('a pre-S2 map (no display_name) does NOT decode (display_name is required)', () => {
    const r = validateSurfacePayload('purupuru', 'role-map', preS2Raw as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.instancePath.includes('display_name'))).toBe(true);
    }
  });

  test('backfillRoleMapDisplayNames defaults display_name from role_key → decodes', () => {
    const migrated = backfillRoleMapDisplayNames(preS2Raw);
    const r = validateSurfacePayload('purupuru', 'role-map', migrated as SurfaceConfigMap['role-map']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const rules = (r.value.config as SurfaceConfigMap['role-map']).rules;
      expect(rules[0]!.display_name).toBe('pp:sovereign');
      expect(rules[1]!.display_name).toBe('pp:initiate');
    }
  });

  test('a backfilled map round-trips PUT→GET (zero manual edits needed)', async () => {
    const { service } = newService();
    const migrated = backfillRoleMapDisplayNames(preS2Raw) as SurfaceConfigMap['role-map'];
    const ok = await service.putConfig('purupuru', 'role-map', migrated, 0, 'cm:alice');
    expect(ok.version).toBe(1);
  });

  test('backfill is non-destructive: a rule that already has display_name is untouched', () => {
    const mixed = {
      enabled: true,
      namespace_prefix: 'pp',
      rules: [
        { role_key: 'pp:a', display_name: 'Alpha', qualifies: { source: 'tier', min_tier: 'g' }, create_if_absent: true },
        { role_key: 'pp:b', qualifies: { source: 'tier', min_tier: 'b' }, create_if_absent: true },
      ],
    };
    const out = backfillRoleMapDisplayNames(mixed);
    const rules = out.rules as { role_key: string; display_name: string }[];
    expect(rules[0]!.display_name).toBe('Alpha'); // untouched
    expect(rules[1]!.display_name).toBe('pp:b'); // backfilled
  });

  test('backfill does NOT add owner (absent-is-correct, hash-preserving)', () => {
    const out = backfillRoleMapDisplayNames(preS2Raw);
    const rules = out.rules as Record<string, unknown>[];
    expect('owner' in rules[0]!).toBe(false);
  });
});
