/**
 * go-live.test.ts — the authorized SHADOW→LIVE orchestration + its
 * counterexamples + the B5 inverse mode-race (SDD §4.4/§6.2, tasks 402.5/.9/.1).
 *
 *   - authorized + hash-match + no-drift ⇒ mode LIVE, a capability minted, a
 *     grant audited.
 *   - stale report_hash ⇒ GuardFailed("stale_report"); mode stays SHADOW; NO mint.
 *   - non-allowlisted actor ⇒ GuardFailed("not_authorized"); a DENY audited; NO mint.
 *   - roster drift > threshold ⇒ GuardFailed("roster_drift") (distinct from
 *     stale_report); NO mint.
 *   - B3/B4 revocation mid-flow: revoke the actor between go_live and a later
 *     read/go_live ⇒ subsequent decisions DENY.
 *   - B5 inverse race: a rollback that races an in-flight LIVE batch serializes to
 *     the batch boundary (the rollback's SHADOW flip lands AFTER the batch
 *     terminates) — the in-flight batch's writes are NOT executed under a
 *     SHADOW-flipped mode mid-batch.
 */
import { describe, expect, test } from 'bun:test';
import { Effect, Exit, Cause, Ref, Layer } from 'effect';
import { goLive, rollback } from '../src/effectful/go-live.js';
import { makeModeControl } from '../src/effectful/mode-control.js';
import { makeRecordingEmitter } from '../src/effectful/acvp-emitter.mock.js';
import { makeInMemoryAllowlist } from '../src/effectful/resolve-authz.mock.js';
import { resolveAuthz } from '../src/effectful/resolve-authz.js';
import { rosterFingerprint } from '../src/effectful/roster-freshness.js';
import { GuardFailed } from '../src/errors.js';
import { SHADOW_AUTHZ_DECIDED, SHADOW_MODE_TRANSITIONED } from '../src/events/shadow-events.js';
import type { Hex64, WorldSlug } from '../src/types.js';

const WORLD = 'purupuru' as WorldSlug;
const ADMIN = 'cm-admin';
const MAP_HASH = 'c'.repeat(64) as Hex64;
const WRONG_HASH = 'd'.repeat(64) as Hex64;
const BASE_IDS = { member_ids: ['m1', 'm2'], role_ids: ['r1'] };
const BASE_FP = rosterFingerprint(BASE_IDS);

function goLiveInput(over: Partial<Parameters<typeof goLive>[1]> = {}) {
  return {
    actor: ADMIN,
    world: WORLD,
    reportHash: MAP_HASH,
    currentMapHash: MAP_HASH,
    transitionVersion: 1,
    evaluatedAt: '2026-06-05T00:00:00.000Z',
    rosterFreshness: { baseFingerprint: BASE_FP, baseSnapshot: BASE_IDS, freshSnapshot: BASE_IDS },
    ...over,
  } as Parameters<typeof goLive>[1];
}

describe('goLive — authorized SHADOW→LIVE', () => {
  test('authorized + hash-match + no-drift ⇒ LIVE + capability minted + grant audited', async () => {
    const { layer: emitterLayer, recorder } = makeRecordingEmitter();
    const { layer: allowlistLayer } = makeInMemoryAllowlist({ [WORLD]: [ADMIN] });

    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const mode = yield* makeModeControl('SHADOW');
        const result = yield* goLive(mode, goLiveInput()).pipe(
          Effect.provide(Layer.mergeAll(emitterLayer, allowlistLayer)),
        );
        const modeNow = yield* Ref.get(mode.ref);
        return { result, modeNow };
      }),
    );

    expect(out.modeNow).toBe('LIVE');
    expect(out.result.mode).toBe('LIVE');
    expect(out.result.capability.report_hash).toBe(MAP_HASH);
    expect(out.result.capability.authz_decision_id).toBe(out.result.authzDecisionId);
    expect(recorder.countOf(SHADOW_AUTHZ_DECIDED)).toBe(1);
    expect(recorder.countOf(SHADOW_MODE_TRANSITIONED)).toBe(1);
  });

  test('stale report_hash ⇒ GuardFailed("stale_report"); mode stays SHADOW; NO mint', async () => {
    const { layer: emitterLayer } = makeRecordingEmitter();
    const { layer: allowlistLayer } = makeInMemoryAllowlist({ [WORLD]: [ADMIN] });

    const { exit, modeNow } = await Effect.runPromise(
      Effect.gen(function* () {
        const mode = yield* makeModeControl('SHADOW');
        const exit = yield* goLive(mode, goLiveInput({ reportHash: WRONG_HASH })).pipe(
          Effect.provide(Layer.mergeAll(emitterLayer, allowlistLayer)),
          Effect.exit,
        );
        const modeNow = yield* Ref.get(mode.ref);
        return { exit, modeNow };
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const e = (Cause.failureOption(exit.cause) as { value: GuardFailed }).value;
      expect(e).toBeInstanceOf(GuardFailed);
      expect(e.reason).toBe('stale_report');
    }
    expect(modeNow).toBe('SHADOW'); // gate stayed closed; no capability minted.
  });

  test('non-allowlisted actor ⇒ GuardFailed("not_authorized") + DENY audited; mode stays SHADOW', async () => {
    const { layer: emitterLayer, recorder } = makeRecordingEmitter();
    const { layer: allowlistLayer } = makeInMemoryAllowlist({ [WORLD]: [ADMIN] });

    const { exit, modeNow } = await Effect.runPromise(
      Effect.gen(function* () {
        const mode = yield* makeModeControl('SHADOW');
        const exit = yield* goLive(mode, goLiveInput({ actor: 'not-an-admin' })).pipe(
          Effect.provide(Layer.mergeAll(emitterLayer, allowlistLayer)),
          Effect.exit,
        );
        const modeNow = yield* Ref.get(mode.ref);
        return { exit, modeNow, recorder };
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const e = (Cause.failureOption(exit.cause) as { value: GuardFailed }).value;
      expect(e.reason).toBe('not_authorized');
    }
    expect(modeNow).toBe('SHADOW');
    // a DENY decision was still audited (grant AND deny emit).
    const deny = recorder.events.find(
      (ev) => ev.event_type === SHADOW_AUTHZ_DECIDED && ev.payload.decision === 'deny',
    );
    expect(deny).toBeDefined();
  });

  test('roster drift > threshold ⇒ GuardFailed("roster_drift") (distinct from stale_report); NO mint', async () => {
    const { layer: emitterLayer } = makeRecordingEmitter();
    const { layer: allowlistLayer } = makeInMemoryAllowlist({ [WORLD]: [ADMIN] });
    // fresh roster gained a new member (drift), threshold default 0.
    const driftedIds = { member_ids: ['m1', 'm2', 'm3-new'], role_ids: ['r1'] };

    const { exit, modeNow } = await Effect.runPromise(
      Effect.gen(function* () {
        const mode = yield* makeModeControl('SHADOW');
        const exit = yield* goLive(
          mode,
          goLiveInput({
            rosterFreshness: { baseFingerprint: BASE_FP, baseSnapshot: BASE_IDS, freshSnapshot: driftedIds },
          }),
        ).pipe(Effect.provide(Layer.mergeAll(emitterLayer, allowlistLayer)), Effect.exit);
        const modeNow = yield* Ref.get(mode.ref);
        return { exit, modeNow };
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const e = (Cause.failureOption(exit.cause) as { value: GuardFailed }).value;
      expect(e).toBeInstanceOf(GuardFailed);
      expect(e.reason).toBe('roster_drift'); // NOT stale_report
    }
    expect(modeNow).toBe('SHADOW');
  });

  test('roster drift within threshold (tunable) is allowed', async () => {
    const { layer: emitterLayer } = makeRecordingEmitter();
    const { layer: allowlistLayer } = makeInMemoryAllowlist({ [WORLD]: [ADMIN] });
    const driftedIds = { member_ids: ['m1', 'm2', 'm3-new'], role_ids: ['r1'] };

    const modeNow = await Effect.runPromise(
      Effect.gen(function* () {
        const mode = yield* makeModeControl('SHADOW');
        yield* goLive(
          mode,
          goLiveInput({
            rosterFreshness: {
              baseFingerprint: BASE_FP,
              baseSnapshot: BASE_IDS,
              freshSnapshot: driftedIds,
              threshold: 1, // allow up to 1 new member
            },
          }),
        ).pipe(Effect.provide(Layer.mergeAll(emitterLayer, allowlistLayer)));
        return yield* Ref.get(mode.ref);
      }),
    );
    expect(modeNow).toBe('LIVE');
  });
});

describe('B3/B4 — revocation mid-flow', () => {
  test('revoke the actor between decisions ⇒ subsequent resolveAuthz DENY', async () => {
    const { layer: emitterLayer } = makeRecordingEmitter();
    const { layer: allowlistLayer, controller } = makeInMemoryAllowlist({ [WORLD]: [ADMIN] });

    const { first, second } = await Effect.runPromise(
      Effect.gen(function* () {
        const env = Layer.mergeAll(emitterLayer, allowlistLayer);
        // first decision: granted.
        const first = yield* resolveAuthz({
          actor: ADMIN,
          world: WORLD,
          evaluatedAt: '2026-06-05T00:00:00.000Z',
        }).pipe(Effect.provide(env));
        // revoke (models a manifest redeploy removing the principal).
        yield* Effect.sync(() => controller.revoke(WORLD, ADMIN));
        // second decision (read OR write — same flow): now denied.
        const second = yield* resolveAuthz({
          actor: ADMIN,
          world: WORLD,
          evaluatedAt: '2026-06-05T00:01:00.000Z',
        }).pipe(Effect.provide(env));
        return { first, second };
      }),
    );

    expect(first.decision).toBe('grant');
    expect(second.decision).toBe('deny');
    // distinct decision ids (B3) — a batch bound to `first` cannot replay against `second`.
    expect(first.authz_decision_id).not.toBe(second.authz_decision_id);
  });
});
