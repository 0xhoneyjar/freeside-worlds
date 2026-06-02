/**
 * gate-checked-writer.test.ts — the gate's behavioral acceptance gates
 * (SDD §4.4, tasks 402.1/.2/.8). Companion to the §8.4 PROPERTY test
 * (property-shadow-gate.test.ts) — this file pins the specific scenarios the
 * sprint AC enumerates with concrete assertions; the property test then proves
 * they hold across RANDOM sequences.
 *
 *   - SHADOW ⇒ inner writer invoked ZERO times + a confirmed rejection per op.
 *   - R-10: flipping the Ref to LIVE after Layer provision makes the next batch
 *     WRITE (no stale SHADOW capture).
 *   - LIVE happy path: writes happen + intent/applied events confirmed; audit
 *     ordering = intent BEFORE the write.
 *   - B3/B14 confused-deputy: batch report_hash / authz_decision_id mismatch ⇒
 *     hard refusal, ZERO writes.
 */
import { describe, expect, test } from 'bun:test';
import { Effect, Exit, Layer, Cause, Ref } from 'effect';
import {
  makeGateCheckedRoleWriter,
  GateCheckedRoleWriter,
} from '../src/effectful/gate-checked-role-writer.js';
import { makeModeControl } from '../src/effectful/mode-control.js';
import { makeRecordingEmitter } from '../src/effectful/acvp-emitter.mock.js';
import { makeInMemoryWorldLock } from '../src/effectful/world-lock.mock.js';
import { makeRecordingRoleWriter } from './helpers/mock-role-writer.js';
import { batch, capabilityFor, mintCap, HASH_A, HASH_B } from './helpers/batch.js';
import { SHADOW_ROLE_REJECTED, SHADOW_ROLE_INTENT, SHADOW_ROLE_APPLIED } from '../src/events/shadow-events.js';
import { ShadowGateRejected, WriteError } from '../src/errors.js';

/** Build the full gate environment for a test, returning the recorders. */
function harness(initialMode: 'SHADOW' | 'LIVE', currentMapHash = HASH_A) {
  const { layer: writerLayer, recorder: writerRec } = makeRecordingRoleWriter();
  const { layer: emitterLayer, recorder: emitterRec } = makeRecordingEmitter();
  const lockLayer = makeInMemoryWorldLock();

  const program = Effect.gen(function* () {
    const mode = yield* makeModeControl(initialMode);
    const base = Layer.mergeAll(writerLayer, emitterLayer, lockLayer);
    const gateLayer = makeGateCheckedRoleWriter(mode, () => currentMapHash);
    // `env` exposes BOTH the base services (applyBatch's R channel) AND the gate
    // Tag: provideMerge(gate, base) satisfies the gate's deps from base AND keeps
    // base's services in the output.
    const env = Layer.provideMerge(gateLayer, base);
    return { mode, gateLayer, env };
  });

  return { program, writerRec, emitterRec, writerLayer, emitterLayer, lockLayer };
}

describe('GateCheckedRoleWriter — SHADOW rejects ALL writes (FR-3)', () => {
  test('SHADOW ⇒ ZERO inner writes + a confirmed rejection per op + fail(ShadowGateRejected)', async () => {
    const { program, writerRec, emitterRec } = harness('SHADOW');
    const b = batch(); // 2 ops
    const cap = capabilityFor(b);

    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.flatMap(({ gateLayer, env }) =>
          Effect.gen(function* () {
            const gate = yield* GateCheckedRoleWriter;
            return yield* gate.applyBatch(b, cap);
          }).pipe(Effect.provide(env)),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe('Some');
      expect((err as { value: unknown }).value).toBeInstanceOf(ShadowGateRejected);
    }
    // THE invariant: zero inner-writer invocations under SHADOW.
    expect(writerRec.invocationCount()).toBe(0);
    // a confirmed rejection per attempted op (2 ops).
    expect(emitterRec.countOf(SHADOW_ROLE_REJECTED)).toBe(2);
    // and NO intent / applied events.
    expect(emitterRec.countOf(SHADOW_ROLE_INTENT)).toBe(0);
    expect(emitterRec.countOf(SHADOW_ROLE_APPLIED)).toBe(0);
  });
});

describe('GateCheckedRoleWriter — R-10 read-at-invocation (no stale SHADOW capture)', () => {
  test('flip Ref to LIVE AFTER Layer provision ⇒ the next applyBatch WRITES', async () => {
    const { program, writerRec, emitterRec } = harness('SHADOW');
    const b = batch();
    const cap = capabilityFor(b);

    const result = await Effect.runPromise(
      program.pipe(
        Effect.flatMap(({ mode, env }) =>
          Effect.gen(function* () {
            // mode is SHADOW at Layer-build. Flip the SAME Ref the gate reads to
            // LIVE AFTER provision — the gate must observe it at invocation.
            yield* Ref.set(mode.ref, 'LIVE');
            const gate = yield* GateCheckedRoleWriter;
            return yield* gate.applyBatch(b, cap);
          }).pipe(Effect.provide(env)),
        ),
      ),
    );

    // It wrote (no stale SHADOW capture): 1 create + 1 assign.
    expect(writerRec.invocationCount()).toBe(2);
    expect(result.status).toBe('done');
    expect(emitterRec.countOf(SHADOW_ROLE_INTENT)).toBe(2);
    expect(emitterRec.countOf(SHADOW_ROLE_APPLIED)).toBe(2);
    expect(emitterRec.countOf(SHADOW_ROLE_REJECTED)).toBe(0);
  });
});

describe('GateCheckedRoleWriter — LIVE happy path + audit ordering', () => {
  test('LIVE ⇒ writes happen; intent emitted BEFORE the write; applied after', async () => {
    const { program, writerRec, emitterRec } = harness('LIVE');
    const b = batch({ ops: [batch().ops[0]!] }); // single create op
    const cap = capabilityFor(b);

    const result = await Effect.runPromise(
      program.pipe(
        Effect.flatMap(({ env }) =>
          Effect.gen(function* () {
            const gate = yield* GateCheckedRoleWriter;
            return yield* gate.applyBatch(b, cap);
          }).pipe(Effect.provide(env)),
        ),
      ),
    );

    expect(result.status).toBe('done');
    expect(writerRec.createCountFor('purupuru:holder')).toBe(1);
    // ordering: the intent event was recorded BEFORE the applied event, and the
    // single create was recorded between them (intent → write → applied).
    const types = emitterRec.events.map((e) => e.event_type);
    const intentIdx = types.indexOf(SHADOW_ROLE_INTENT);
    const appliedIdx = types.indexOf(SHADOW_ROLE_APPLIED);
    expect(intentIdx).toBeGreaterThanOrEqual(0);
    expect(appliedIdx).toBeGreaterThan(intentIdx);
    expect(result.roles_created.length).toBe(1);
    expect(result.roles_created[0]!.role_key).toBe('purupuru:holder');
  });
});

describe('GateCheckedRoleWriter — B3/B14 confused-deputy / replay guard', () => {
  test('batch report_hash ≠ capability report_hash ⇒ hard refusal, ZERO writes', async () => {
    const { program, writerRec } = harness('LIVE', HASH_A);
    // batch authz.report_hash = HASH_A (matches current map), but the capability
    // was minted for HASH_B — a replayed/forged cap.
    const b = batch({ report_hash: HASH_A });
    const forgedCap = mintCap(HASH_B, b.authz.transition_version, b.authz.authz_decision_id);

    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.flatMap(({ env }) =>
          Effect.gen(function* () {
            const gate = yield* GateCheckedRoleWriter;
            return yield* gate.applyBatch(b, forgedCap);
          }).pipe(Effect.provide(env)),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const e = (Cause.failureOption(exit.cause) as { value: WriteError }).value;
      expect(e).toBeInstanceOf(WriteError);
      expect(e.kind).toBe('op_failed');
    }
    expect(writerRec.invocationCount()).toBe(0);
  });

  test('batch authz_decision_id ≠ capability authz_decision_id ⇒ hard refusal (B3 replay), ZERO writes', async () => {
    const { program, writerRec } = harness('LIVE', HASH_A);
    const b = batch({ report_hash: HASH_A });
    // cap bound to a DIFFERENT authz decision than the batch carries.
    const replayCap = mintCap(HASH_A, b.authz.transition_version, 'a-different-revoked-decision');

    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.flatMap(({ env }) =>
          Effect.gen(function* () {
            const gate = yield* GateCheckedRoleWriter;
            return yield* gate.applyBatch(b, replayCap);
          }).pipe(Effect.provide(env)),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(writerRec.invocationCount()).toBe(0);
  });

  test('batch report_hash ≠ CURRENT map hash ⇒ unbound batch refused, ZERO writes', async () => {
    // current map hash is HASH_B; the batch + its cap are both for HASH_A — a
    // stale/unbound batch (the map changed since authorization).
    const { program, writerRec } = harness('LIVE', HASH_B);
    const b = batch({ report_hash: HASH_A });
    const cap = capabilityFor(b);

    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.flatMap(({ env }) =>
          Effect.gen(function* () {
            const gate = yield* GateCheckedRoleWriter;
            return yield* gate.applyBatch(b, cap);
          }).pipe(Effect.provide(env)),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(writerRec.invocationCount()).toBe(0);
  });
});
