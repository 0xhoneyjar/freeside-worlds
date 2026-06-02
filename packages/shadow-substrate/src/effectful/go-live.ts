/**
 * effectful/go-live.ts — the authorized SHADOW→LIVE orchestration + the SOLE
 * `WriteCapability` mint site (SDD §4.4/§6.2, tasks 402.3/.5/.9).
 *
 * This is the ONLY place `mintWriteCapability` is called. It composes the
 * preflights into the authorized transition:
 *
 *   1. `resolveAuthz` (effectful, B3/B4) → grant/deny + a stable
 *      `authz_decision_id`. The go_live confirm uses `bypassCache:true` (B6) so
 *      the highest-risk write is gated on a FRESH allowlist read.
 *   2. roster-freshness re-eval (B1) → `GuardFailed("roster_drift")` if the
 *      freshly-loaded roster drifted beyond threshold since report-gen.
 *   3. the pure `transition('SHADOW','go_live', guardInputs)` → LIVE | GuardFailed.
 *   4. on success: flip the mode `Ref` to LIVE, emit `shadow.mode.transitioned.v1`,
 *      and MINT the `WriteCapability` bound to the report_hash + transition
 *      version + authz_decision_id.
 *
 * The minted capability is the compile-time seam the LIVE writer's signature
 * requires (B9); the ENFORCED boundary remains `GateCheckedRoleWriter`. The
 * capability is returned to the caller (the lens's go_live action) which then
 * calls `applyBatch(batch, cap)`.
 */
import { Effect, Ref } from 'effect';
import { transition } from '../pure/transition.js';
import { GuardFailed } from '../errors.js';
import type { AuthzError } from '../errors.js';
import type {
  ApplyMode,
  Hex64,
  WorldSlug,
  WriteCapability,
} from '../types.js';
import type { ModeControl } from './mode-control.js';
import { resolveAuthz, AdminAllowlistSource } from './resolve-authz.js';
import { AcvpEmitter } from './acvp-emitter.js';
import { mintWriteCapability } from './write-capability.js';
import {
  evalRosterFreshness,
  type RosterIdentitySnapshot,
} from './roster-freshness.js';
import { SHADOW_MODE_TRANSITIONED } from '../events/shadow-events.js';

export interface GoLiveInput {
  readonly actor: string;
  readonly world: WorldSlug;
  /** the report's `role_map_hash` (the FR-7 guard input). */
  readonly reportHash: Hex64;
  /** `roleMapVersionHash(current map)` — re-derived fresh at go_live. */
  readonly currentMapHash: Hex64;
  /** ties the minted capability + batch to ONE authorized transition. */
  readonly transitionVersion: number;
  /** caller-supplied ISO timestamp (no clock read in the substrate). */
  readonly evaluatedAt: string;
  /** SOFT 2-week-soak advisory (FR-7) — surfaced, NEVER blocks. */
  readonly soakSatisfied?: boolean;
  /** B1 roster-freshness: the frozen base fingerprint + snapshot + fresh read. */
  readonly rosterFreshness: {
    readonly baseFingerprint: Hex64;
    readonly baseSnapshot: RosterIdentitySnapshot;
    readonly freshSnapshot: RosterIdentitySnapshot;
    readonly threshold?: number;
  };
}

export interface GoLiveOutput {
  readonly mode: ApplyMode;
  readonly capability: WriteCapability;
  readonly authzDecisionId: string;
}

/**
 * Run the authorized go_live. EFFECTFUL — requires `AdminAllowlistSource` +
 * `AcvpEmitter`. On any guard/authz failure it fails loud in the typed channel
 * and NEVER mints a capability / flips the mode (so the gate stays closed).
 *
 * B6: `resolveAuthz` runs with `bypassCache:true` — the go_live confirm is gated
 * on a fresh allowlist read, never a cached grant.
 */
export function goLive(
  mode: ModeControl,
  input: GoLiveInput,
): Effect.Effect<GoLiveOutput, GuardFailed | AuthzError, AdminAllowlistSource | AcvpEmitter> {
  return Effect.gen(function* () {
    // 1. authz preflight (FRESH — B6).
    const decision = yield* resolveAuthz({
      actor: input.actor,
      world: input.world,
      evaluatedAt: input.evaluatedAt,
      bypassCache: true,
    });

    // 2. roster-freshness re-eval (B1) — separate from the rules-hash guard.
    yield* evalRosterFreshness({
      baseFingerprint: input.rosterFreshness.baseFingerprint,
      baseSnapshot: input.rosterFreshness.baseSnapshot,
      freshSnapshot: input.rosterFreshness.freshSnapshot,
      threshold: input.rosterFreshness.threshold,
    });

    // 3. the PURE transition over already-resolved guard inputs.
    const newMode = yield* transition('SHADOW', 'go_live', {
      report_hash: input.reportHash,
      current_map_hash: input.currentMapHash,
      authz_decision: decision.decision === 'grant',
      soak_satisfied: input.soakSatisfied,
    });

    // 4. authorized — flip the mode, audit the transition, MINT the capability.
    //    The mode flip + the `mode.transitioned` audit + the mint run UNDER the
    //    SHARED mode lock (B5/CRITICAL-3): SHADOW→LIVE (here) and LIVE→SHADOW
    //    (`rollback`) take the SAME lock, so the two transitions serialize and a
    //    go_live can never race a rollback's flip. No deadlock: the lens calls
    //    `goLive` BEFORE `applyBatch` (never nested inside an applyBatch that
    //    already holds the lock).
    return yield* mode.withModeLock(
      Effect.gen(function* () {
        // CLEANUP: if the world is ALREADY LIVE, short-circuit — no spurious
        // `mode.transitioned` audit + no redundant mint. (The property test's
        // model already skips go_live-from-LIVE; the production path is now
        // faithful to it.) We still return a freshly-minted capability bound to
        // this authorized decision so the caller has a usable cap.
        const current = yield* Ref.get(mode.ref);
        const capability = mintWriteCapability({
          report_hash: input.reportHash,
          transition_version: input.transitionVersion,
          authz_decision_id: decision.authz_decision_id,
        });

        if (current === 'LIVE') {
          return {
            mode: 'LIVE' as ApplyMode,
            capability,
            authzDecisionId: decision.authz_decision_id,
          };
        }

        yield* Ref.set(mode.ref, newMode);

        yield* AcvpEmitter.pipe(
          Effect.flatMap((emitter) =>
            emitter.emitConfirmed({
              event_type: SHADOW_MODE_TRANSITIONED,
              payload: {
                world: input.world,
                from: 'SHADOW',
                to: 'LIVE',
                actor: input.actor,
                report_hash: input.reportHash,
              },
            }),
          ),
          // a mode-transition audit hiccup does not un-flip the mode; the intent/
          // applied per-op events (write-after-audit) are the load-bearing trail.
          Effect.catchAll(() => Effect.void),
        );

        return {
          mode: newMode,
          capability,
          authzDecisionId: decision.authz_decision_id,
        };
      }),
    );
  });
}

/**
 * `rollback` — flip the mode `Ref` back to SHADOW + audit the transition. Always
 * allowed (instant). It takes the SHARED mode lock (B5): because
 * `GateCheckedRoleWriter` holds the SAME lock for a whole batch, a rollback that
 * races an in-flight batch serializes to the batch boundary — the flip to SHADOW
 * either lands BEFORE the batch starts (the batch then sees SHADOW and rejects)
 * or AFTER it terminates. A write NEVER executes under a SHADOW-flipped mode
 * mid-batch. This is the B5 inverse-race fix.
 */
export function rollback(
  mode: ModeControl,
  input: { readonly world: WorldSlug; readonly actor: string },
): Effect.Effect<ApplyMode, never, AcvpEmitter> {
  return mode.withModeLock(
    Effect.gen(function* () {
      yield* Ref.set(mode.ref, 'SHADOW');
      yield* AcvpEmitter.pipe(
        Effect.flatMap((emitter) =>
          emitter.emitConfirmed({
            event_type: SHADOW_MODE_TRANSITIONED,
            payload: { world: input.world, from: 'LIVE', to: 'SHADOW', actor: input.actor },
          }),
        ),
        Effect.catchAll(() => Effect.void),
      );
      return 'SHADOW' as ApplyMode;
    }),
  );
}
