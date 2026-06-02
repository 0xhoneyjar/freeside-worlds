/**
 * tests/helpers/harness.ts — the shared gate test environment (SDD §8.4).
 *
 * Builds a `GateCheckedRoleWriter` over recording mock Layers (RoleWriter +
 * AcvpEmitter + WorldLock) so a test can: run `applyBatch`, then inspect the
 * inner-writer recorder (ZERO invocations under SHADOW) + the emitter recorder
 * (confirmed rejection/intent/applied counts). The `Layer.provideMerge(gate,
 * base)` shape exposes BOTH the gate Tag AND the base services (applyBatch's R
 * channel) in one env.
 */
import { Effect, Layer, Ref } from 'effect';
import {
  makeGateCheckedRoleWriter,
  GateCheckedRoleWriter,
  type ApplyBatchResult,
} from '../../src/effectful/gate-checked-role-writer.js';
import { makeModeControl, type ModeControl } from '../../src/effectful/mode-control.js';
import { makeRecordingEmitter, type Recorder, type MockEmitterOptions } from '../../src/effectful/acvp-emitter.mock.js';
import { makeInMemoryWorldLock } from '../../src/effectful/world-lock.mock.js';
import { makeInMemoryAllowlist, type AllowlistController } from '../../src/effectful/resolve-authz.mock.js';
import { makeRecordingRoleWriter, type WriterRecorder, type MockWriterOptions } from './mock-role-writer.js';
import type { ApplyMode, Hex64, WriteCapability, WriteIntentBatch } from '../../src/types.js';
import { HASH_A, TEST_WORLD } from './batch.js';

export interface Harness {
  readonly mode: ModeControl;
  readonly writerRec: WriterRecorder;
  readonly emitterRec: Recorder;
  /** the allowlist controller — `revoke(world, actor)` models a mid-flow revocation. */
  readonly allowlist: AllowlistController;
  /** apply a batch through the gate, returning the terminal result. */
  applyBatch(
    batch: WriteIntentBatch,
    cap: WriteCapability,
    priorState?: ApplyBatchResult,
  ): Effect.Effect<ApplyBatchResult, unknown>;
  /** flip the SAME mode Ref the gate reads (R-10 / mode-race tests). */
  setMode(m: ApplyMode): Effect.Effect<void>;
}

export interface HarnessOptions {
  readonly initialMode?: ApplyMode;
  readonly currentMapHash?: Hex64;
  readonly writer?: MockWriterOptions;
  readonly emitter?: MockEmitterOptions;
  /**
   * The world admin allowlist the gate's fresh write-boundary re-check (CRITICAL-2)
   * resolves against. Defaults to granting `cm-actor-1` (the batch helper's
   * default actor) for TEST_WORLD, so the LIVE happy path passes out of the box.
   * A test may pass an empty/other allowlist to exercise the denial path, or use
   * the returned `allowlist` controller to revoke mid-flow.
   */
  readonly allowlist?: Readonly<Record<string, ReadonlyArray<string>>>;
}

/**
 * Build a harness as an Effect (the mode Ref + lock are created in Effect). Run
 * the returned `harness.applyBatch(...)` inside the same Effect scope. The gate's
 * full environment — RoleWriter + AcvpEmitter + WorldLock + AdminAllowlistSource
 * — is wired here in one `Layer.provideMerge` shape (CLEANUP 3: the single shared
 * harness for the acceptance + audit suites).
 */
export function makeHarness(opts: HarnessOptions = {}): Effect.Effect<Harness> {
  const { layer: writerLayer, recorder: writerRec } = makeRecordingRoleWriter(opts.writer);
  const { layer: emitterLayer, recorder: emitterRec } = makeRecordingEmitter(opts.emitter);
  const lockLayer = makeInMemoryWorldLock();
  const { layer: allowlistLayer, controller: allowlist } = makeInMemoryAllowlist(
    opts.allowlist ?? { [TEST_WORLD]: ['cm-actor-1'] },
  );
  const currentMapHash = opts.currentMapHash ?? HASH_A;

  return Effect.gen(function* () {
    const mode = yield* makeModeControl(opts.initialMode ?? 'SHADOW');
    const base = Layer.mergeAll(writerLayer, emitterLayer, lockLayer, allowlistLayer);
    const gateLayer = makeGateCheckedRoleWriter(mode, () => currentMapHash);
    const env = Layer.provideMerge(gateLayer, base);

    const harness: Harness = {
      mode,
      writerRec,
      emitterRec,
      allowlist,
      applyBatch: (batch, cap, priorState) =>
        Effect.gen(function* () {
          const gate = yield* GateCheckedRoleWriter;
          return yield* gate.applyBatch(batch, cap, priorState);
        }).pipe(Effect.provide(env)) as Effect.Effect<ApplyBatchResult, unknown>,
      setMode: (m) => Ref.set(mode.ref, m),
    };
    return harness;
  });
}
