/**
 * resolve-authz.test.ts — the FR-10 authz preflight + read-path + loaders
 * (SDD §6.2/§4.2, tasks 402.5/402.6, B3/B4).
 */
import { describe, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { resolveAuthz } from '../src/effectful/resolve-authz.js';
import { resolveReader } from '../src/effectful/resolve-reader.js';
import { loadCurrentRoster, loadLatentCounts } from '../src/effectful/loaders.js';
import { makeRecordingEmitter } from '../src/effectful/acvp-emitter.mock.js';
import { makeInMemoryAllowlist } from '../src/effectful/resolve-authz.mock.js';
import { RosterSource, ScoreSource } from '../src/ports/index.js';
import { SHADOW_AUTHZ_DECIDED } from '../src/events/shadow-events.js';
import type { CurrentRoster } from '../src/schemas/render-model.js';
import type { RoleRule } from '../src/schemas/config-surfaces.js';
import type { WorldSlug } from '../src/types.js';

const WORLD = 'purupuru' as WorldSlug;
const ADMIN = 'cm-admin';

describe('resolveAuthz — the ONE authoritative decision flow (B3)', () => {
  test('allowlisted actor ⇒ grant + stable decision id + audited', async () => {
    const { layer: emitterLayer, recorder } = makeRecordingEmitter();
    const { layer: allowlistLayer } = makeInMemoryAllowlist({ [WORLD]: [ADMIN] });

    const decision = await Effect.runPromise(
      resolveAuthz({ actor: ADMIN, world: WORLD, evaluatedAt: 't1' }).pipe(
        Effect.provide(Layer.mergeAll(emitterLayer, allowlistLayer)),
      ),
    );
    expect(decision.decision).toBe('grant');
    expect(decision.authz_decision_id).toMatch(/^[0-9a-f]{64}$/);
    expect(recorder.countOf(SHADOW_AUTHZ_DECIDED)).toBe(1);
  });

  test('decision id is deterministic for the same inputs (replayable reference)', async () => {
    const { layer: emitterLayer } = makeRecordingEmitter();
    const { layer: allowlistLayer } = makeInMemoryAllowlist({ [WORLD]: [ADMIN] });
    const env = Layer.mergeAll(emitterLayer, allowlistLayer);

    const [d1, d2] = await Effect.runPromise(
      Effect.all([
        resolveAuthz({ actor: ADMIN, world: WORLD, evaluatedAt: 'same' }).pipe(Effect.provide(env)),
        resolveAuthz({ actor: ADMIN, world: WORLD, evaluatedAt: 'same' }).pipe(Effect.provide(env)),
      ]),
    );
    expect(d1.authz_decision_id).toBe(d2.authz_decision_id);
  });

  test('grant and deny derive DISTINCT decision ids (B3 — no replay across decisions)', async () => {
    const { layer: emitterLayer } = makeRecordingEmitter();
    const { layer: allowlistLayer } = makeInMemoryAllowlist({ [WORLD]: [ADMIN] });
    const env = Layer.mergeAll(emitterLayer, allowlistLayer);

    const grant = await Effect.runPromise(
      resolveAuthz({ actor: ADMIN, world: WORLD, evaluatedAt: 't' }).pipe(Effect.provide(env)),
    );
    const deny = await Effect.runPromise(
      resolveAuthz({ actor: 'nope', world: WORLD, evaluatedAt: 't' }).pipe(Effect.provide(env)),
    );
    expect(grant.decision).toBe('grant');
    expect(deny.decision).toBe('deny');
    expect(grant.authz_decision_id).not.toBe(deny.authz_decision_id);
  });
});

describe('resolveReader — read-path authority (B4)', () => {
  test('revoked admin loses READ (deny via the same flow)', async () => {
    const { layer: emitterLayer } = makeRecordingEmitter();
    const { layer: allowlistLayer } = makeInMemoryAllowlist({ [WORLD]: [] }); // not allowlisted
    const decision = await Effect.runPromise(
      resolveReader({ actor: ADMIN, world: WORLD, evaluatedAt: 't' }).pipe(
        Effect.provide(Layer.mergeAll(emitterLayer, allowlistLayer)),
      ),
    );
    expect(decision.decision).toBe('deny');
  });
});

describe('loaders — effectful roster/score reads (402.6)', () => {
  test('loadCurrentRoster reads via RosterSource', async () => {
    const roster: CurrentRoster = {
      world: WORLD,
      roles: [{ role_key: 'purupuru:holder', members: 5, managed: true }],
    };
    const rosterLayer = Layer.succeed(RosterSource, {
      currentRoster: () => Effect.succeed(roster),
      // cycle-010 FR-12: the new id-set port method. This loader test does not
      // exercise it; a trivial empty snapshot satisfies the port shape.
      currentRosterIdentity: () => Effect.succeed({ member_ids: [], role_ids: [] }),
    });
    const out = await Effect.runPromise(loadCurrentRoster(WORLD).pipe(Effect.provide(rosterLayer)));
    expect(out).toEqual(roster);
  });

  test('loadLatentCounts reads via ScoreSource with honest source:"MOCK"', async () => {
    const scoreLayer = Layer.succeed(ScoreSource, {
      latentQualified: () => Effect.succeed(42),
    });
    const rules: RoleRule[] = [
      { role_key: 'purupuru:holder', display_name: 'Holder', qualifies: { source: 'tier', min_tier: 't1' }, create_if_absent: true },
    ];
    const out = await Effect.runPromise(loadLatentCounts(WORLD, rules).pipe(Effect.provide(scoreLayer)));
    expect(out).toEqual([{ role_key: 'purupuru:holder', count: 42, source: 'MOCK' }]);
  });
});
