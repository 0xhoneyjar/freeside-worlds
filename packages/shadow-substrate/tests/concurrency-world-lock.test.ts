/**
 * concurrency-world-lock.test.ts — B10 (TOCTOU) concurrency proof + the negative
 * control (SDD §4.4.1, task 402.4/402.8). REWRITTEN HONESTLY (FAGAN iter-2,
 * CRITICAL-1): the proof is driven by the GATE's OWN mechanism — its per-world
 * lock × the inner `RoleWriter`'s check-then-create against a SHARED roleset.
 * There is NO external `ledgerMutex` and NO caller-threaded shared ledger; the
 * two batches start blind (no `priorState`).
 *
 * ── WHY TWO GATE INSTANCES (the realistic B10 scenario) ──────────────────────
 * The gate holds a per-batch read-lock on its mode `Ref` (B5). Two `applyBatch`
 * calls on the SAME `ModeControl` are therefore already fully serialized by that
 * mode-lock — the world-lock would be invisible. The race the WORLD-lock exists
 * to close is CROSS-INSTANCE: two separate gateway processes (each with its OWN
 * mode `Ref`, both LIVE) writing to the SAME Discord guild. We model that with
 * TWO independent gate instances (`mode1`/`gate1`, `mode2`/`gate2`) that SHARE
 * the live guild (one `RoleWriter` + its shared roleset) and — in the positive
 * case — share ONE world-lock (the Postgres-advisory-lock seam, keyed on world).
 *
 * The mock writer (helpers/mock-role-writer.ts) models Discord's `GET roles →
 * create-if-absent` against a SHARED roleset, with a `createDelayMs` that widens
 * the (non-atomic) check-then-create window:
 *   - POSITIVE: both gates take the SAME shared world-lock → the two
 *     GET-then-create spans serialize → gate 2's createRole GETs the role gate 1
 *     already created and REUSES it → EXACTLY ONE create. (The gate dedups.)
 *   - NEGATIVE CONTROL: each gate gets its OWN (un-shared) world-lock — i.e. NO
 *     cross-instance serialization → both spans interleave inside the widened
 *     window, both GET "absent", both create → TWO creates. (Proves the window
 *     is wide enough to expose the race, so the positive result is non-tautological.)
 */
import { describe, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import {
  makeGateCheckedRoleWriter,
  GateCheckedRoleWriter,
} from '../src/effectful/gate-checked-role-writer.js';
import { makeModeControl } from '../src/effectful/mode-control.js';
import { makeRecordingEmitter } from '../src/effectful/acvp-emitter.mock.js';
import { makeInMemoryWorldLock } from '../src/effectful/world-lock.mock.js';
import { makeInMemoryAllowlist } from '../src/effectful/resolve-authz.mock.js';
import { makeRecordingRoleWriter } from './helpers/mock-role-writer.js';
import { batch, capabilityFor, createOp, HASH_A, TEST_WORLD } from './helpers/batch.js';

const ROLE_KEY = 'purupuru:holder';
// The actor the test batch carries (helpers/batch.ts authzContext default).
const TEST_ACTOR = 'cm-actor-1';

describe('B10 — concurrent same-world batches (two gate instances) create EXACTLY ONE role', () => {
  test('two instances sharing ONE world-lock ⇒ 1 create (no external mutex, no threaded ledger)', async () => {
    // ONE shared live guild (RoleWriter + shared roleset), widened race window.
    const { layer: writerLayer, recorder: writerRec } = makeRecordingRoleWriter({
      createDelayMs: 25,
    });
    const { layer: emitterLayer } = makeRecordingEmitter();
    const { layer: allowlistLayer } = makeInMemoryAllowlist({ [TEST_WORLD]: [TEST_ACTOR] });
    // ONE shared world-lock layer — the cross-instance Postgres-advisory-lock
    // seam. `Layer.mergeAll` of the shared services, built ONCE inside a scope
    // (memoized) so BOTH gate instances resolve the SAME WorldLock + RoleWriter
    // service instances — a re-built layer would give each gate its own lock map
    // and defeat the cross-instance serialization we're proving.
    const sharedLock = makeInMemoryWorldLock();
    const shared = Layer.mergeAll(writerLayer, emitterLayer, allowlistLayer, sharedLock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Build the shared base ONCE; both gates resolve from this context.
          const sharedCtx = yield* Layer.build(shared);

          // TWO independent gate instances — separate ModeControl (separate mode
          // Ref), both LIVE — modeling two gateway processes hitting one guild.
          const mode1 = yield* makeModeControl('LIVE');
          const mode2 = yield* makeModeControl('LIVE');
          const gate1Ctx = yield* Layer.build(makeGateCheckedRoleWriter(mode1, () => HASH_A)).pipe(
            Effect.provide(sharedCtx),
          );
          const gate2Ctx = yield* Layer.build(makeGateCheckedRoleWriter(mode2, () => HASH_A)).pipe(
            Effect.provide(sharedCtx),
          );

          const b1 = batch({ ops: [createOp(ROLE_KEY)] });
          const b2 = batch({ ops: [createOp(ROLE_KEY)] });
          const cap1 = capabilityFor(b1);
          const cap2 = capabilityFor(b2);

          // run BOTH concurrently — each starts BLIND (no priorState ledger). The
          // dedup is purely the SHARED world-lock × the inner check-then-create.
          // Each gate's applyBatch runs with the SHARED base context (so the
          // WorldLock/RoleWriter are the one shared instance) + its own gate Tag.
          const run1 = GateCheckedRoleWriter.pipe(
            Effect.flatMap((gate) => gate.applyBatch(b1, cap1)),
            Effect.provide(gate1Ctx),
            Effect.provide(sharedCtx),
          );
          const run2 = GateCheckedRoleWriter.pipe(
            Effect.flatMap((gate) => gate.applyBatch(b2, cap2)),
            Effect.provide(gate2Ctx),
            Effect.provide(sharedCtx),
          );

          yield* Effect.all([run1, run2], { concurrency: 'unbounded' });
        }),
      ),
    );

    // EXACTLY ONE create — the shared world-lock serialized the two instances'
    // spans and the second instance's createRole GETs the first's role from the
    // shared roleset.
    expect(writerRec.createCountFor(ROLE_KEY)).toBe(1);
  });

  test('negative control: each instance has its OWN world-lock (no shared lock) ⇒ double-creates (2)', async () => {
    // Same two concurrent instances + ONE shared guild, but each gate gets its
    // OWN world-lock (NOT shared) — there is no cross-instance serialization.
    // This is the race the (shared) world-lock prevents; here we PROVE the
    // widened window is wide enough to expose it (so the positive test above is
    // a real serialization effect, not a tautology). Expect TWO creates.
    const { layer: writerLayer, recorder: writerRec } = makeRecordingRoleWriter({
      createDelayMs: 25,
    });
    const { layer: emitterLayer } = makeRecordingEmitter();
    const { layer: allowlistLayer } = makeInMemoryAllowlist({ [TEST_WORLD]: [TEST_ACTOR] });
    // The shared guild (RoleWriter + roleset), built ONCE. NO world-lock here —
    // each gate brings its own (un-shared) lock below.
    const sharedGuild = Layer.mergeAll(writerLayer, emitterLayer, allowlistLayer);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const guildCtx = yield* Layer.build(sharedGuild);

          const mode1 = yield* makeModeControl('LIVE');
          const mode2 = yield* makeModeControl('LIVE');
          // TWO SEPARATE world-locks — each instance locks against itself only,
          // so they do NOT serialize across instances (the un-fixed B10 race).
          const env1 = Layer.build(
            Layer.provideMerge(makeGateCheckedRoleWriter(mode1, () => HASH_A), makeInMemoryWorldLock()),
          ).pipe(Effect.provide(guildCtx));
          const env2 = Layer.build(
            Layer.provideMerge(makeGateCheckedRoleWriter(mode2, () => HASH_A), makeInMemoryWorldLock()),
          ).pipe(Effect.provide(guildCtx));
          const gate1Ctx = yield* env1;
          const gate2Ctx = yield* env2;

          const b1 = batch({ ops: [createOp(ROLE_KEY)] });
          const b2 = batch({ ops: [createOp(ROLE_KEY)] });
          const cap1 = capabilityFor(b1);
          const cap2 = capabilityFor(b2);

          const run1 = GateCheckedRoleWriter.pipe(
            Effect.flatMap((gate) => gate.applyBatch(b1, cap1)),
            Effect.provide(gate1Ctx),
            Effect.provide(guildCtx),
          );
          const run2 = GateCheckedRoleWriter.pipe(
            Effect.flatMap((gate) => gate.applyBatch(b2, cap2)),
            Effect.provide(gate2Ctx),
            Effect.provide(guildCtx),
          );

          yield* Effect.all([run1, run2], { concurrency: 'unbounded' });
        }),
      ),
    );

    // both created — without a SHARED cross-instance lock the widened window
    // exposes the race, so the positive test's single create is a real effect of
    // the shared world-lock.
    expect(writerRec.createCountFor(ROLE_KEY)).toBe(2);
  });
});
