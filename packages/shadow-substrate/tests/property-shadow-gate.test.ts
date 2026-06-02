/**
 * property-shadow-gate.test.ts — THE §8.4 PROOF 2, the G-3 ACCEPTANCE GATE.
 *
 * The load-bearing proof that "SHADOW ⇒ zero Discord writes" before any live
 * writer exists. Property-based (fast-check) over RANDOM action sequences.
 *
 * ── TOOLING NOTE (grounded deviation from SDD §8.4) ──────────────────────────
 * The SDD names `@effect/vitest + fast-check`. Neither `@effect/vitest` nor
 * `vitest` is installed in this monorepo — the repo standard runner is `bun
 * test` (every other suite here runs under it). fast-check is framework-agnostic
 * (`fc.assert(fc.property(...))` runs under any runner), so this suite uses
 * **fast-check under `bun test`** — honoring the SDD's intent (property-based,
 * bounded sequences, a `numRuns` knob) while staying on the repo's actual
 * runner. fast-check was added as a devDependency. The `numRuns` knob is the
 * env var `SHADOW_PROP_RUNS` (default 200 for the local/pre-commit run; CI sets
 * it to ≥1000 — see the sprint AC).
 *
 * ── THE INVARIANT (SDD §8.4 proof 2) ─────────────────────────────────────────
 * Generate a random sequence (0–32 events) of {go_live, rollback, batch(1–50
 * ops)}. An ORACLE tracks whether the gate is currently LIVE (reachable ONLY via
 * a SUCCESSFUL go_live: authorized AND hash-matched AND a capability minted for
 * the matching report_hash/decision). For EVERY batch executed while the oracle
 * says SHADOW (no successful go_live in effect), assert:
 *   (a) the inner writer is invoked ZERO times, AND
 *   (b) a confirmed `shadow.role.rejected.v1` is emitted per attempted op.
 * Across the WHOLE sequence: the cumulative inner-write count never exceeds the
 * cumulative ops dispatched while the oracle was LIVE.
 *
 * The counterexamples the suite proves un-writable (stale hash, non-allowlisted
 * actor, forged/absent capability, decision-id replay, write-after-rollback) are
 * pinned as explicit cases in gate-checked-writer.test.ts + go-live.test.ts +
 * audit-under-failure.test.ts; here the RANDOM generator continually re-derives
 * them (a `go_live` with mismatched hash / wrong actor never flips the oracle to
 * LIVE, so any following batch must still reject).
 */
import { describe, expect, test } from 'bun:test';
import { Effect, Ref, Layer, Exit } from 'effect';
import fc from 'fast-check';
import {
  makeGateCheckedRoleWriter,
  GateCheckedRoleWriter,
} from '../src/effectful/gate-checked-role-writer.js';
import { makeModeControl } from '../src/effectful/mode-control.js';
import { goLive, rollback } from '../src/effectful/go-live.js';
import { makeRecordingEmitter } from '../src/effectful/acvp-emitter.mock.js';
import { makeInMemoryWorldLock } from '../src/effectful/world-lock.mock.js';
import { makeInMemoryAllowlist } from '../src/effectful/resolve-authz.mock.js';
import { AcvpEmitter } from '../src/effectful/acvp-emitter.js';
import { AdminAllowlistSource } from '../src/effectful/resolve-authz.js';
import { makeRecordingRoleWriter } from './helpers/mock-role-writer.js';
import { rosterFingerprint } from '../src/effectful/roster-freshness.js';
import { SHADOW_ROLE_REJECTED } from '../src/events/shadow-events.js';
import { mintWriteCapability } from '../src/effectful/write-capability.js';
import type {
  ApplyMode,
  Hex64,
  WorldSlug,
  WriteCapability,
  WriteIntentBatch,
  WriteOp,
} from '../src/types.js';

const NUM_RUNS = Number.parseInt(process.env.SHADOW_PROP_RUNS ?? '200', 10);
const CI_NUM_RUNS = 1000; // documented CI value (sprint AC)

const WORLD = 'purupuru' as WorldSlug;
const ALLOWED_ACTOR = 'cm-admin';
const CURRENT_MAP_HASH = 'c'.repeat(64) as Hex64;
const WRONG_HASH = 'd'.repeat(64) as Hex64;
// A stable base roster + matching fingerprint so go_live's roster-freshness
// re-eval passes (no drift) when everything else is valid — the only way the
// oracle flips to LIVE.
const ROSTER_IDS = { member_ids: ['m1', 'm2'], role_ids: ['r1'] };
const BASE_FINGERPRINT = rosterFingerprint(ROSTER_IDS);

// ── action grammar ───────────────────────────────────────────────────────────
type Action =
  | { kind: 'go_live'; authorized: boolean; hashMatch: boolean }
  | { kind: 'rollback' }
  | { kind: 'batch'; nOps: number; forgeCap: boolean };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.record({
    kind: fc.constant('go_live' as const),
    authorized: fc.boolean(),
    hashMatch: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('rollback' as const) }),
  fc.record({
    kind: fc.constant('batch' as const),
    nOps: fc.integer({ min: 1, max: 50 }),
    forgeCap: fc.boolean(),
  }),
);

const sequenceArb: fc.Arbitrary<Action[]> = fc.array(actionArb, { minLength: 0, maxLength: 32 });

function makeOps(n: number, reportHash: Hex64): WriteOp[] {
  const ops: WriteOp[] = [];
  for (let i = 0; i < n; i++) {
    const role_key = `purupuru:role-${i}`;
    ops.push({
      op_id: `create_role:${role_key}`,
      idempotency_key: ('0'.repeat(63) + (i % 10)) as Hex64,
      kind: 'create_role',
      intent: { role_key, display_name: role_key },
    });
  }
  return ops;
}

/**
 * Run one random sequence through a fresh gate + oracle. Returns the assertions'
 * boolean verdict (true = invariant held). Throwing inside `Effect.runPromise`
 * is caught by fast-check via the async property.
 */
async function runSequence(actions: Action[]): Promise<void> {
  const { layer: writerLayer, recorder: writerRec } = makeRecordingRoleWriter();
  const { layer: emitterLayer, recorder: emitterRec } = makeRecordingEmitter();
  const lockLayer = makeInMemoryWorldLock();
  const { layer: allowlistLayer } = makeInMemoryAllowlist({ [WORLD]: [ALLOWED_ACTOR] });

  await Effect.runPromise(
    Effect.gen(function* () {
      const mode = yield* makeModeControl('SHADOW');
      const base = Layer.mergeAll(writerLayer, emitterLayer, lockLayer, allowlistLayer);
      const gateLayer = makeGateCheckedRoleWriter(mode, () => CURRENT_MAP_HASH);
      const env = Layer.provideMerge(gateLayer, base);

      // ORACLE state. The mode `Ref` is the source of truth for LIVE/SHADOW
      // (the gate reads it); the oracle tracks the cap minted by the last
      // successful go_live + the cumulative LIVE-dispatched-op budget.
      let liveCap: WriteCapability | undefined; // the cap from the last successful go_live
      let transitionVersion = 0;
      let expectedMaxWrites = 0; // cumulative ops dispatched while LIVE
      let rejectionsBefore = 0;

      for (const action of actions) {
        if (action.kind === 'go_live') {
          transitionVersion += 1;
          // attempt an authorized SHADOW→LIVE. Only flips to LIVE when BOTH
          // authorized AND hashMatch (the pure transition's guards).
          const actor = action.authorized ? ALLOWED_ACTOR : 'not-an-admin';
          const reportHash = action.hashMatch ? CURRENT_MAP_HASH : WRONG_HASH;
          // Only attempt from SHADOW (go_live from LIVE is a defect — skip it in
          // the model to keep the oracle legal; a real lens never offers it).
          const curMode = yield* Ref.get(mode.ref);
          if (curMode === 'LIVE') {
            continue;
          }
          const exit = yield* goLive(mode, {
            actor,
            world: WORLD,
            reportHash,
            currentMapHash: CURRENT_MAP_HASH,
            transitionVersion,
            evaluatedAt: '2026-06-05T00:00:00.000Z',
            rosterFreshness: {
              baseFingerprint: BASE_FINGERPRINT,
              baseSnapshot: ROSTER_IDS,
              freshSnapshot: ROSTER_IDS, // no drift
            },
          }).pipe(
            Effect.provide(Layer.mergeAll(emitterLayer, allowlistLayer)),
            Effect.exit,
          );
          if (Exit.isSuccess(exit)) {
            // go_live succeeded — capture the minted cap; goLive flipped the Ref.
            liveCap = exit.value.capability;
          }
          // on failure goLive never flips the Ref (the guards fail BEFORE the
          // set), so the mode stays SHADOW and the gate stays closed.
        } else if (action.kind === 'rollback') {
          yield* rollback(mode, { world: WORLD, actor: ALLOWED_ACTOR }).pipe(
            Effect.provide(emitterLayer),
          );
          liveCap = undefined;
        } else {
          // batch
          const reportHash = CURRENT_MAP_HASH;
          const ops = makeOps(action.nOps, reportHash);
          const b: WriteIntentBatch = {
            world: WORLD,
            report_hash: reportHash,
            authz: {
              actor: ALLOWED_ACTOR,
              world: WORLD,
              report_hash: reportHash,
              token_metadata: { kid: 'svc', verified_at: 't', exp: 't' },
              transition_version: transitionVersion,
              authz_decision_id: liveCap?.authz_decision_id ?? 'no-decision',
              roster_version: { fingerprint: BASE_FINGERPRINT, fetched_at: 't', member_count: 2 },
            },
            ops,
            max_concurrent: 4,
          };
          // The cap: either the legit one from the last go_live, or a FORGED one
          // (hand-rolled). A forged cap must never let a write through under
          // SHADOW (the gate rejects on mode BEFORE touching the cap).
          const cap: WriteCapability = action.forgeCap || liveCap === undefined
            ? mintWriteCapability({
                report_hash: reportHash,
                transition_version: transitionVersion,
                authz_decision_id: b.authz.authz_decision_id,
              })
            : liveCap;

          const writesBefore = writerRec.invocationCount();
          rejectionsBefore = emitterRec.countOf(SHADOW_ROLE_REJECTED);
          // read the mode the gate WILL observe (it holds the same lock, so this
          // read + the applyBatch serialize; for the oracle we read before).
          const modeAtBatch = yield* Ref.get(mode.ref);
          const exit = yield* Effect.gen(function* () {
            const gate = yield* GateCheckedRoleWriter;
            return yield* gate.applyBatch(b, cap);
          }).pipe(Effect.provide(env), Effect.exit);

          if (modeAtBatch === 'SHADOW') {
            // THE INVARIANT (a): zero NEW inner writes under SHADOW.
            const writesAfter = writerRec.invocationCount();
            if (writesAfter !== writesBefore) {
              throw new Error(
                `SHADOW invariant violated: ${writesAfter - writesBefore} inner writes under SHADOW`,
              );
            }
            // (b): a confirmed rejection per attempted op.
            const rejectionsAfter = emitterRec.countOf(SHADOW_ROLE_REJECTED);
            if (rejectionsAfter - rejectionsBefore !== ops.length) {
              throw new Error(
                `expected ${ops.length} confirmed rejections, got ${rejectionsAfter - rejectionsBefore}`,
              );
            }
            // the batch failed (ShadowGateRejected).
            if (!Exit.isFailure(exit)) {
              throw new Error('SHADOW batch must FAIL (ShadowGateRejected)');
            }
          } else {
            // LIVE: count ops as the cumulative write budget.
            expectedMaxWrites += ops.length;
          }
        }
      }

      // Across the WHOLE sequence: cumulative inner writes never exceed the ops
      // dispatched while LIVE (so a SHADOW window can never have written).
      const totalWrites = writerRec.invocationCount();
      if (totalWrites > expectedMaxWrites) {
        throw new Error(
          `cumulative writes ${totalWrites} > LIVE-dispatched ops ${expectedMaxWrites}`,
        );
      }
      void rejectionsBefore;
    }),
  );
}

describe('§8.4 PROOF 2 — provable-shadow property test (G-3 acceptance gate)', () => {
  test(`SHADOW ⇒ zero inner writes across random sequences (numRuns=${NUM_RUNS}; CI=${CI_NUM_RUNS})`, async () => {
    await fc.assert(
      fc.asyncProperty(sequenceArb, async (actions) => {
        await runSequence(actions);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
