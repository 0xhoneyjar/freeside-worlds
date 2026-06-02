/**
 * mode-race.test.ts — the B5 INVERSE mode-race proof (SDD §4.4.0/§4.5, task 402.1).
 *
 * The forward race (R-10) is "go_live flips LIVE after Layer build ⇒ next batch
 * writes" — covered in gate-checked-writer.test.ts. The INVERSE race is: a
 * `rollback` (LIVE→SHADOW) that lands AFTER the gate read the mode but BEFORE the
 * batch's writes complete would, without the lock, let a write execute under a
 * mode that has already flipped to SHADOW.
 *
 * Fix (B5): the gate holds the SHARED mode read-lock for the WHOLE batch;
 * `rollback` takes the SAME lock to flip. So a rollback racing an in-flight batch
 * SERIALIZES to the batch boundary — it flips to SHADOW only AFTER the batch
 * terminates. We prove: a LIVE batch with a per-op write delay, raced by a
 * rollback, COMPLETES its writes (the batch ran fully under LIVE), and the mode
 * is SHADOW only after the batch finished.
 */
import { describe, expect, test } from 'bun:test';
import { Effect, Layer, Ref, Fiber } from 'effect';
import {
  makeGateCheckedRoleWriter,
  GateCheckedRoleWriter,
} from '../src/effectful/gate-checked-role-writer.js';
import { makeModeControl } from '../src/effectful/mode-control.js';
import { rollback } from '../src/effectful/go-live.js';
import { makeRecordingEmitter } from '../src/effectful/acvp-emitter.mock.js';
import { makeInMemoryWorldLock } from '../src/effectful/world-lock.mock.js';
import { makeInMemoryAllowlist } from '../src/effectful/resolve-authz.mock.js';
import { makeRecordingRoleWriter } from './helpers/mock-role-writer.js';
import { batch, capabilityFor, createOp, assignOp, HASH_A, TEST_WORLD } from './helpers/batch.js';

// The batch helper's default actor — granted so the LIVE write-boundary
// re-check (CRITICAL-2) passes in these mode-race scenarios.
const BATCH_ACTOR = 'cm-actor-1';

describe('B5 — inverse mode-race: rollback serializes to the batch boundary', () => {
  test('rollback racing an in-flight LIVE batch ⇒ batch completes all writes; SHADOW flip lands AFTER', async () => {
    // Writer with a per-create delay so the batch is genuinely in-flight when the
    // rollback fires.
    const { layer: writerLayer, recorder: writerRec } = makeRecordingRoleWriter({
      createDelayMs: 40,
    });
    const { layer: emitterLayer } = makeRecordingEmitter();
    const lockLayer = makeInMemoryWorldLock();

    const { layer: allowlistLayer } = makeInMemoryAllowlist({ [TEST_WORLD]: [BATCH_ACTOR] });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const mode = yield* makeModeControl('LIVE');
        const base = Layer.mergeAll(writerLayer, emitterLayer, lockLayer, allowlistLayer);
        const gateLayer = makeGateCheckedRoleWriter(mode, () => HASH_A);
        const env = Layer.provideMerge(gateLayer, base);

        // a multi-op batch so the in-flight window is wide.
        const b = batch({
          ops: [
            createOp('purupuru:a'),
            createOp('purupuru:b'),
            assignOp('purupuru:a', 'm1'),
          ],
        });
        const cap = capabilityFor(b);

        // fork the batch (holds the mode lock for its duration).
        const batchFiber = yield* Effect.fork(
          Effect.gen(function* () {
            const gate = yield* GateCheckedRoleWriter;
            return yield* gate.applyBatch(b, cap);
          }).pipe(Effect.provide(env)),
        );

        // give the batch a moment to acquire the mode lock + start writing.
        yield* Effect.sleep('10 millis');

        // fire the rollback CONCURRENTLY — it must WAIT on the shared mode lock
        // until the batch releases it (the batch boundary).
        const rollbackFiber = yield* Effect.fork(
          rollback(mode, { world: TEST_WORLD, actor: 'cm-admin' }).pipe(Effect.provide(emitterLayer)),
        );

        const batchResult = yield* Fiber.join(batchFiber);
        // capture the mode the INSTANT the batch finished — before joining the
        // rollback the flip may not have landed; we join the rollback to ensure
        // it completes.
        yield* Fiber.join(rollbackFiber);
        const finalMode = yield* Ref.get(mode.ref);

        return { batchResult, finalMode, writes: writerRec.invocationCount() };
      }),
    );

    // The batch ran FULLY under LIVE — all 3 ops applied (2 creates + 1 assign).
    expect(result.batchResult.status).toBe('done');
    expect(result.writes).toBe(3);
    // The rollback's SHADOW flip serialized to AFTER the batch (it could not
    // interleave mid-batch). Final mode is SHADOW (the rollback eventually ran).
    expect(result.finalMode).toBe('SHADOW');
  });

  test('rollback BEFORE a batch starts ⇒ the batch sees SHADOW and rejects (no write)', async () => {
    const { layer: writerLayer, recorder: writerRec } = makeRecordingRoleWriter();
    const { layer: emitterLayer } = makeRecordingEmitter();
    const lockLayer = makeInMemoryWorldLock();

    const { layer: allowlistLayer } = makeInMemoryAllowlist({ [TEST_WORLD]: [BATCH_ACTOR] });

    await Effect.runPromise(
      Effect.gen(function* () {
        const mode = yield* makeModeControl('LIVE');
        const base = Layer.mergeAll(writerLayer, emitterLayer, lockLayer, allowlistLayer);
        const gateLayer = makeGateCheckedRoleWriter(mode, () => HASH_A);
        const env = Layer.provideMerge(gateLayer, base);

        // rollback FIRST (completes, flips to SHADOW under the lock).
        yield* rollback(mode, { world: TEST_WORLD, actor: 'cm-admin' }).pipe(
          Effect.provide(emitterLayer),
        );
        const b = batch({ ops: [createOp('purupuru:a')] });
        const cap = capabilityFor(b);
        // now the batch — sees SHADOW, rejects, ZERO writes.
        yield* Effect.gen(function* () {
          const gate = yield* GateCheckedRoleWriter;
          return yield* gate.applyBatch(b, cap);
        }).pipe(Effect.provide(env), Effect.exit);
      }),
    );

    expect(writerRec.invocationCount()).toBe(0);
  });
});
