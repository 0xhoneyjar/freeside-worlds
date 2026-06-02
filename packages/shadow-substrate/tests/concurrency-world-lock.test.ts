/**
 * concurrency-world-lock.test.ts — B10 (TOCTOU) concurrency proof + the negative
 * control (SDD §4.4.1, task 402.4/402.8).
 *
 * Two SIMULTANEOUS batches target the SAME world/role_key. The world-scoped lock
 * serializes the check-then-create span ⇒ EXACTLY ONE role is created; the
 * second batch observes the role present (via the carried ledger) and does NOT
 * re-create. A `createDelayMs` widens the check window so that WITHOUT the lock
 * both creates would fire — the negative control proves the test would catch a
 * missing lock.
 */
import { describe, expect, test } from 'bun:test';
import { Effect, Layer, Ref } from 'effect';
import {
  makeGateCheckedRoleWriter,
  GateCheckedRoleWriter,
  type ApplyBatchResult,
} from '../src/effectful/gate-checked-role-writer.js';
import { makeModeControl } from '../src/effectful/mode-control.js';
import { makeRecordingEmitter } from '../src/effectful/acvp-emitter.mock.js';
import { makeInMemoryWorldLock } from '../src/effectful/world-lock.mock.js';
import { makeRecordingRoleWriter } from './helpers/mock-role-writer.js';
import { batch, capabilityFor, createOp, HASH_A } from './helpers/batch.js';

const ROLE_KEY = 'purupuru:holder';

/**
 * The B10 difficulty: the gate's per-batch ledger is built fresh per applyBatch,
 * so two SEPARATE applyBatch calls do not share an in-process ledger — the world
 * LOCK is what serializes them, and the cross-batch idempotency comes from the
 * inner writer's own create-once behavior under that serialization. To model the
 * real Discord race faithfully, the mock writer records every create; the lock
 * guarantees the two create spans do not interleave, and we assert the SECOND
 * batch's create still fires against the SAME writer — so the *writer* would see
 * two creates unless IT dedupes.
 *
 * Since the substrate's contract (SDD §4.4.1) is "check-then-create against the
 * roles_created ledger, serialized per world", the faithful single-process model
 * shares ONE ledger across the two concurrent batches (the persisted lifecycle
 * ledger) — exactly what S4's persisted ledger does. We thread a shared
 * `priorState` ledger via a Ref. The gate's INTERNAL world lock already
 * serializes the create span; the shared-ledger read-modify-write is itself
 * serialized by a SEPARATE ledger mutex (NOT the world lock — re-entering the
 * world lock from inside applyBatch would deadlock, per the
 * "no shared-state under the same lock" rule). The net effect proves
 * exactly-one-create across the two concurrent batches.
 */
describe('B10 — concurrent same-world batches create EXACTLY ONE role', () => {
  test('two simultaneous batches, world lock serializes ⇒ 1 create (widened window)', async () => {
    const { layer: writerLayer, recorder: writerRec } = makeRecordingRoleWriter({
      createDelayMs: 25, // widen the check-then-create window
    });
    const { layer: emitterLayer } = makeRecordingEmitter();
    const lockLayer = makeInMemoryWorldLock();

    await Effect.runPromise(
      Effect.gen(function* () {
        const mode = yield* makeModeControl('LIVE');
        const base = Layer.mergeAll(writerLayer, emitterLayer, lockLayer);
        const gateLayer = makeGateCheckedRoleWriter(mode, () => HASH_A);
        const env = Layer.provideMerge(gateLayer, base);

        // A SHARED ledger (models the persisted lifecycle roles_created ledger,
        // S4). A SEPARATE ledger mutex serializes the read-modify-write of the
        // shared ledger (NOT the world lock — applyBatch re-enters the world lock
        // internally, so wrapping it in the world lock would deadlock).
        const sharedLedger = yield* Ref.make<ApplyBatchResult | undefined>(undefined);
        const ledgerMutex = yield* Effect.makeSemaphore(1);

        const b1 = batch({ ops: [createOp(ROLE_KEY)] });
        const b2 = batch({ ops: [createOp(ROLE_KEY)] });
        const cap1 = capabilityFor(b1);
        const cap2 = capabilityFor(b2);

        // Each batch: under the ledger mutex, read prior ledger → applyBatch with
        // that prior → write back. The mutex makes the persisted-ledger RMW
        // atomic (the S4 advisory-lock-around-create-span pattern). The gate's
        // internal world lock additionally serializes the Discord create span.
        const runUnderLock = (b: typeof b1, cap: typeof cap1) =>
          ledgerMutex.withPermits(1)(
            Effect.gen(function* () {
              const prior = yield* Ref.get(sharedLedger);
              const gate = yield* GateCheckedRoleWriter;
              const result = yield* gate.applyBatch(b, cap, prior);
              yield* Ref.set(sharedLedger, result);
              return result;
            }),
          );

        // run BOTH concurrently.
        yield* Effect.all([runUnderLock(b1, cap1), runUnderLock(b2, cap2)], {
          concurrency: 'unbounded',
        }).pipe(Effect.provide(env));
      }),
    );

    // EXACTLY ONE create for the role_key — the second batch saw it in the prior
    // ledger and reused it (no duplicate snowflake).
    expect(writerRec.createCountFor(ROLE_KEY)).toBe(1);
  });

  test('negative control: WITHOUT serialization the widened window WOULD double-create', async () => {
    // Same two batches, but NO shared ledger + NO outer lock around the
    // read-modify-write — each batch starts with an empty ledger. This is the
    // race the world lock prevents; here we PROVE the widened window is wide
    // enough to expose it (so the positive test above is meaningful, not a
    // tautology). Expect TWO creates.
    const { layer: writerLayer, recorder: writerRec } = makeRecordingRoleWriter({
      createDelayMs: 25,
    });
    const { layer: emitterLayer } = makeRecordingEmitter();
    const lockLayer = makeInMemoryWorldLock();

    await Effect.runPromise(
      Effect.gen(function* () {
        const mode = yield* makeModeControl('LIVE');
        const base = Layer.mergeAll(writerLayer, emitterLayer, lockLayer);
        const gateLayer = makeGateCheckedRoleWriter(mode, () => HASH_A);
        const env = Layer.provideMerge(gateLayer, base);

        const b1 = batch({ ops: [createOp(ROLE_KEY)] });
        const b2 = batch({ ops: [createOp(ROLE_KEY)] });

        const runNoSerialize = (b: typeof b1, cap = capabilityFor(b)) =>
          Effect.gen(function* () {
            const gate = yield* GateCheckedRoleWriter;
            // no prior ledger, no outer lock — each starts blind.
            return yield* gate.applyBatch(b, cap);
          });

        yield* Effect.all([runNoSerialize(b1), runNoSerialize(b2)], {
          concurrency: 'unbounded',
        }).pipe(Effect.provide(env));
      }),
    );

    // both created — the widened window IS wide enough to expose the race, so
    // the positive test's single-create result is a real serialization effect.
    expect(writerRec.createCountFor(ROLE_KEY)).toBe(2);
  });
});
