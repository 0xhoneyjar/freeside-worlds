/**
 * effectful/gate-checked-role-writer.ts — THE GATE (SDD §4.4, tasks 402.1/.2/.4).
 *
 * `GateCheckedRoleWriter` is the substrate-provided wrapper around the inner
 * (actor-supplied) `RoleWriter`. It is THE ENFORCED SECURITY BOUNDARY (B9): the
 * `WriteCapability` is only a compile-time accident-prevention seam — the gate's
 * invocation-time mode read + authz validation + write-after-audit are what
 * actually enforce "SHADOW ⇒ zero writes". A consumer NEVER calls a raw writer
 * directly; the only reachable write path is `applyBatch` on this wrapper.
 *
 * ── WHAT THIS GATE ENFORCES AT THE WRITE BOUNDARY (B9 reframe / SDD §6.2) ─────
 * Stated PRECISELY and honestly (the same discipline as the `WriteCapability`
 * B9 reframe — claim only what is mechanically true here). For a LIVE batch, the
 * gate enforces, in order:
 *   (i)   apply_mode == LIVE READ AT INVOCATION (R-10; never captured at build);
 *   (ii)  `batch.authz.actor` is CURRENTLY in `admin_principals` — a FRESH
 *         server-side `resolveAuthz({actor, world, bypassCache:true})` whose
 *         decision must be `grant` AND whose `freshDecision.actor` must equal
 *         `batch.authz.actor`. The bypassCache closes the mid-flow REVOCATION
 *         window (B4); the `actor` equality pins the fresh grant to the SAME
 *         principal the batch + cap claim (so the actor binding is non-decorative);
 *   (iii) batch ↔ cap binding — `report_hash` + `authz_decision_id` +
 *         `transition_version` all agree across {current map, cap, batch,
 *         batch.authz} (replay / confused-deputy guard, B3/B14);
 *   (iv)  write-after-audit — a CONFIRMED `shadow.role.intent.v1` BEFORE each
 *         inner write (a failed confirm ⇒ no write).
 *
 * What this gate does NOT do (so the boundary is not over-claimed): it does NOT
 * re-verify the identity-api TOKEN at the write boundary — it does not hold the
 * token (`AuthzContext` carries only `token_metadata`, not the bearer token).
 * Actor-IDENTITY AUTHENTICITY (proving the actor string is who they say) is
 * established UPSTREAM: at go_live (token verification per §6.2) and at the
 * config-service API boundary (S2). This gate verifies ALLOWLIST MEMBERSHIP of
 * the claimed actor + the batch↔cap binding — NOT token authenticity. The
 * `authz_decision_id` binding (iii) proves batch↔cap field self-consistency, and
 * (ii)'s `actor` equality pins that self-consistency to the claimed principal;
 * neither, by itself, re-authenticates that principal — that is the upstream
 * boundary's job.
 *
 * Per `applyBatch(batch, cap)`:
 *   1. B5 read-lock: acquire a read-lock on the mode `Ref` for the WHOLE batch
 *      duration so a concurrent `rollback` (LIVE→SHADOW) serializes to a batch
 *      boundary — never interleaving mid-batch.
 *   2. R-10 invocation read: read `apply_mode` from the `Ref` AT INVOCATION
 *      (never captured at Layer-build).
 *   3. B3/B14 confused-deputy / replay BINDING guard: assert `batch.authz` is
 *      bound to THIS authorization — `report_hash` matches the current map hash
 *      AND the capability's AND `batch.report_hash`; `authz_decision_id` /
 *      `transition_version` match the capability's. This binds the batch to the
 *      go_live decision (replay / confused-deputy guard). It is a FIELD match —
 *      NOT a fresh allowlist check (see step 3b).
 *   3b. FRESH ALLOWLIST RE-CHECK (SDD §6.2, CRITICAL-2): BEFORE the write loop,
 *      the gate RE-RESOLVES authz server-side via `resolveAuthz({actor, world,
 *      bypassCache:true})` and asserts the decision is `grant`. This is the
 *      SERVER-SIDE check the §6.2/§4.4.5 "enforced boundary" advertises — it
 *      catches a mid-batch admin REVOCATION (B4) and a forged capability whose
 *      authz fields were self-reported to match. The binding guard (step 3) and
 *      the fresh re-check (3b) are COMPLEMENTARY: binding stops replay against a
 *      different decision; the fresh re-check stops "still-allowlisted?" drift +
 *      forgery. The gate now REQUIRES `AdminAllowlistSource` in context.
 *   4. SHADOW ⇒ per attempted op: emit CONFIRMED `shadow.role.rejected.v1`, then
 *      fail `ShadowGateRejected`. The inner writer is invoked ZERO times.
 *   5. LIVE ⇒ per op (skipping ops already `ok` from a prior run — idempotent
 *      reconciliation): emit + CONFIRM `shadow.role.intent.v1` BEFORE the write
 *      (a failed confirm ⇒ `WriteError("audit_unavailable")`, write does NOT
 *      run); create-ops run inside the per-world lock (B10) and the inner
 *      `RoleWriter.createRole` is CHECK-THEN-CREATE against live state, so the
 *      lock-serialized span dedups creates ACROSS concurrent same-world batches
 *      (the cross-batch B10 guarantee — NOT dependent on the caller threading a
 *      prior ledger); emit `shadow.role.applied.v1` after success (a failed
 *      applied-confirm marks the op `applied_audit_failed`, never silently `ok`);
 *      record per-op status + the ledger.
 */
import { Context, Effect, Layer, Ref } from 'effect';
import {
  ShadowGateRejected,
  WriteError,
  type AuditError,
} from '../errors.js';
import type { ModeControl } from './mode-control.js';
import type {
  AuthzContext,
  WriteCapability,
  WriteIntentBatch,
  WriteOp,
  GoLiveJobState,
  WorldSlug,
  RoleId,
} from '../types.js';
import { RoleWriter } from '../ports/index.js';
import { AcvpEmitter } from './acvp-emitter.js';
import { WorldLock } from './world-lock.js';
import { resolveAuthz, AdminAllowlistSource } from './resolve-authz.js';
import {
  SHADOW_ROLE_REJECTED,
  SHADOW_ROLE_INTENT,
  SHADOW_ROLE_APPLIED,
  type ShadowEvent,
} from '../events/shadow-events.js';

// ─── The gate service shape ──────────────────────────────────────────────────

/**
 * The result of an `applyBatch`. Carries the terminal `GoLiveJobState`-shaped
 * outcome (per-op status + the idempotent `roles_created` ledger) the lens polls.
 */
export type ApplyBatchResult = Omit<GoLiveJobState, 'job_id'>;

/**
 * The gate service. `applyBatch` is the ONLY write path. A SHADOW batch fails
 * `ShadowGateRejected` (after confirming a rejection per op); a LIVE batch
 * returns the terminal job state.
 */
export interface GateCheckedRoleWriterService {
  readonly applyBatch: (
    batch: WriteIntentBatch,
    cap: WriteCapability,
    /** prior op_status for reconciliation (retry re-runs only pending/failed). */
    priorState?: ApplyBatchResult,
  ) => Effect.Effect<
    ApplyBatchResult,
    WriteError | ShadowGateRejected,
    // `AdminAllowlistSource` is REQUIRED (CRITICAL-2): the LIVE path re-resolves
    // authz server-side (fresh allowlist re-check) before the write loop.
    RoleWriter | AcvpEmitter | WorldLock | AdminAllowlistSource
  >;
}

export class GateCheckedRoleWriter extends Context.Tag('shadow/GateCheckedRoleWriter')<
  GateCheckedRoleWriter,
  GateCheckedRoleWriterService
>() {}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Map an op to the audit payload's intent fields. */
function intentFields(op: WriteOp): {
  op_id: string;
  kind: 'create_role' | 'assign_role' | 'revoke_role' | 'rename_role';
  role_key: string;
  member_id?: string;
} {
  // member_id is carried by the per-member ops (assign + revoke); create/rename
  // are role-level and have none. cycle-010 (FR-9): revoke also carries member_id.
  // `WriteOp` is now a discriminated union on `kind` (the /fagan fix), so
  // narrowing on `kind` types `op.intent` precisely — NO cast needed.
  const member_id =
    op.kind === 'assign_role' || op.kind === 'revoke_role'
      ? op.intent.member_id
      : undefined;
  return { op_id: op.op_id, kind: op.kind, role_key: op.intent.role_key, member_id };
}

/**
 * Assert the batch's `AuthzContext` is bound to THIS authorization (B3/B14
 * confused-deputy + replay guard). Fails `WriteError("op_failed")` with a clear
 * message — these are NOT transient, NOT rate-limit, and NOT a SHADOW rejection;
 * a binding mismatch is a hard refusal.
 *
 * MAJOR-4: ALL FOUR of {current map hash, capability report_hash, BATCH
 * report_hash, batch authz report_hash} must agree. Binding only the
 * `authz.report_hash` (and not `batch.report_hash`) left a hole where a batch
 * could field-match authz/cap to the current map while emitting
 * `shadow.role.intent.v1` with a DIFFERENT `batch.report_hash`. The intent event
 * carries `batch.report_hash`, so the audit trail must be bound to the SAME hash.
 */
function assertAuthzBound(
  authz: AuthzContext,
  cap: WriteCapability,
  batchReportHash: string,
  currentMapHash: string,
): Effect.Effect<void, WriteError> {
  if (authz.report_hash !== currentMapHash) {
    return Effect.fail(
      new WriteError({
        kind: 'op_failed',
        message: `authz binding: batch authz.report_hash ≠ current map hash (stale/unbound batch)`,
      }),
    );
  }
  if (authz.report_hash !== batchReportHash) {
    return Effect.fail(
      new WriteError({
        kind: 'op_failed',
        message: `authz binding: batch authz.report_hash ≠ batch.report_hash (the audited intent would carry a different hash than the authorization)`,
      }),
    );
  }
  if (batchReportHash !== cap.report_hash) {
    return Effect.fail(
      new WriteError({
        kind: 'op_failed',
        message: `authz binding: batch report_hash ≠ capability report_hash (confused-deputy)`,
      }),
    );
  }
  if (authz.authz_decision_id !== cap.authz_decision_id) {
    return Effect.fail(
      new WriteError({
        kind: 'op_failed',
        message: `authz binding: batch authz_decision_id ≠ capability authz_decision_id (replay against a different/revoked decision)`,
      }),
    );
  }
  if (authz.transition_version !== cap.transition_version) {
    return Effect.fail(
      new WriteError({
        kind: 'op_failed',
        message: `authz binding: batch transition_version ≠ capability transition_version`,
      }),
    );
  }
  return Effect.void;
}

// ─── The wrapper Layer factory (SDD §4.4.3) ──────────────────────────────────

/**
 * Build the `GateCheckedRoleWriter` Layer.
 *
 * @param mode  the SHARED `ModeControl` (the apply_mode `Ref` + the batch-
 *              duration read-lock). The writer reads the `Ref` AT INVOCATION
 *              (R-10) and holds the SHARED lock for the whole batch (B5) — a
 *              `rollback` that takes the same lock (`rollbackUnderLock`, go-live.ts)
 *              therefore serializes to a batch boundary, never mid-batch.
 * @param currentMapHash  a thunk resolving `roleMapVersionHash(current map)` —
 *                 read fresh per applyBatch so the authz-binding guard checks the
 *                 CURRENT map (not a captured value).
 *
 * The inner `RoleWriter`, `AcvpEmitter`, and `WorldLock` are pulled from context
 * at BUILD time (the actor supplies them as Layers) — this Layer composes them;
 * it does NOT capture them in a way that bypasses the gate. `AdminAllowlistSource`
 * is pulled at INVOCATION time inside `applyBatch`'s LIVE path (via `resolveAuthz`)
 * for the fresh write-boundary allowlist re-check (CRITICAL-2) — it is therefore
 * in the SERVICE method's requirement channel, not in this Layer's build deps.
 * Downstream Layer wiring (S4) MUST provide `AdminAllowlistSource` wherever
 * `applyBatch` is run, in addition to RoleWriter/AcvpEmitter/WorldLock.
 */
export function makeGateCheckedRoleWriter(
  mode: ModeControl,
  currentMapHash: () => string,
): Layer.Layer<GateCheckedRoleWriter, never, RoleWriter | AcvpEmitter | WorldLock> {
  return Layer.effect(
    GateCheckedRoleWriter,
    Effect.gen(function* () {
      const inner = yield* RoleWriter;
      const emitter = yield* AcvpEmitter;
      const worldLock = yield* WorldLock;

      const emitConfirmed = (event: ShadowEvent): Effect.Effect<void, AuditError> =>
        emitter.emitConfirmed(event);

      const service: GateCheckedRoleWriterService = {
        applyBatch: (batch, cap, priorState) =>
          // B5: hold the SHARED mode read-lock for the ENTIRE batch.
          mode.withModeLock(
            Effect.gen(function* () {
              // R-10: read apply_mode AT INVOCATION (never captured at build).
              const mode_value = yield* Ref.get(mode.ref);

              if (mode_value === 'SHADOW') {
                // SHADOW ⇒ ZERO inner writes. Per attempted op, confirm a
                // rejection event, then fail loud. The FIRST op's rejection is
                // confirmed before the typed failure returns; we confirm a
                // rejection for EACH op so the trace shows one rejection per
                // attempted write (the §8.4 invariant).
                for (const op of batch.ops) {
                  const f = intentFields(op);
                  yield* emitConfirmed({
                    event_type: SHADOW_ROLE_REJECTED,
                    payload: {
                      world: batch.world,
                      op_id: f.op_id,
                      kind: f.kind,
                      role_key: f.role_key,
                      member_id: f.member_id,
                      apply_mode: 'SHADOW',
                    },
                  }).pipe(
                    Effect.mapError(
                      (e) =>
                        new WriteError({
                          kind: 'audit_unavailable',
                          message: `rejection audit failed: ${e.message}`,
                        }),
                    ),
                  );
                }
                return yield* Effect.fail(
                  new ShadowGateRejected({
                    world: batch.world,
                    message: 'write attempted under SHADOW — apply_mode is not LIVE',
                  }),
                );
              }

              // LIVE path. First the confused-deputy / replay BINDING guard
              // (B3/B14): bind authz ↔ cap ↔ batch.report_hash ↔ current map.
              yield* assertAuthzBound(batch.authz, cap, batch.report_hash, currentMapHash());

              // CRITICAL-2 / B4 / §6.2: FRESH server-side allowlist re-check at
              // the WRITE BOUNDARY. The gate ENFORCES (per the header) exactly:
              //   - apply_mode == LIVE read at invocation (above);
              //   - batch.authz.actor is CURRENTLY in admin_principals — re-resolve
              //     authz bypassing the cache, decision must be `grant`, AND the
              //     fresh decision's actor must equal batch.authz.actor (the grant
              //     is pinned to the SAME principal the batch + cap claim);
              //   - the batch↔cap binding (assertAuthzBound, above);
              //   - write-after-audit (in the LIVE loop).
              // bypassCache closes the mid-batch admin REVOCATION window (B4) and
              // catches a forged capability whose authz fields were self-reported
              // to match. It is IN ADDITION to the binding guard above (which stays
              // — that is the replay / confused-deputy bind to the go_live
              // decision). The `evaluatedAt` is the batch's already-verified token
              // timestamp (no clock read in the substrate).
              //
              // What this re-check does NOT do: it does NOT re-verify the
              // identity-api TOKEN — the gate does not hold the bearer token
              // (`AuthzContext` carries only `token_metadata`). Actor-IDENTITY
              // authenticity is established UPSTREAM (go_live token verification
              // per §6.2 + the config-service API boundary, S2). This re-check
              // proves allowlist MEMBERSHIP of the claimed actor, not token
              // authenticity — see the file header for the full boundary statement.
              const freshDecision = yield* resolveAuthz({
                actor: batch.authz.actor,
                world: batch.world,
                evaluatedAt: batch.authz.token_metadata.verified_at,
                bypassCache: true,
              }).pipe(
                Effect.mapError(
                  (e) =>
                    new WriteError({
                      kind: 'op_failed',
                      message: `authz re-check failed at write boundary: ${e.message}`,
                    }),
                ),
              );
              if (freshDecision.decision !== 'grant') {
                return yield* Effect.fail(
                  new WriteError({
                    kind: 'op_failed',
                    message: `actor no longer allowlisted at write boundary (revoked/forged authz) — write refused (${freshDecision.reason})`,
                  }),
                );
              }
              // Pin the fresh grant to the CLAIMED principal: the decision we just
              // resolved must be FOR `batch.authz.actor`, not merely SOME granted
              // actor. `resolveAuthz` is called with that actor and echoes it back,
              // so this is a defense-in-depth invariant — it makes the actor
              // binding non-decorative and fails LOUD (zero writes) if a future
              // change ever made the resolved actor diverge from the requested one.
              if (freshDecision.actor !== batch.authz.actor) {
                return yield* Effect.fail(
                  new WriteError({
                    kind: 'op_failed',
                    message: `authz re-check actor mismatch: fresh decision actor (${freshDecision.actor}) ≠ batch.authz.actor (${batch.authz.actor}) — write refused`,
                  }),
                );
              }

              return yield* applyLiveBatch({
                batch,
                cap,
                priorState,
                inner,
                emitConfirmed,
                worldLock,
              });
            }),
          ),
      };

      return service;
    }),
  );
}

// ─── The LIVE apply loop (SDD §4.4.1/§4.4.3) ─────────────────────────────────

interface ApplyLiveDeps {
  readonly batch: WriteIntentBatch;
  readonly cap: WriteCapability;
  readonly priorState: ApplyBatchResult | undefined;
  readonly inner: Context.Tag.Service<RoleWriter>;
  readonly emitConfirmed: (event: ShadowEvent) => Effect.Effect<void, AuditError>;
  readonly worldLock: Context.Tag.Service<WorldLock>;
}

type OpStatus = { op_id: string; status: 'pending' | 'ok' | 'failed'; error?: string };
type LedgerEntry = { role_key: string; role_id: RoleId; op_id: string };

function applyLiveBatch(
  deps: ApplyLiveDeps,
): Effect.Effect<ApplyBatchResult, WriteError, never> {
  const { batch, cap, priorState, inner, emitConfirmed, worldLock } = deps;

  return Effect.gen(function* () {
    // Reconciliation: ops already `ok` in a prior run are SKIPPED (idempotent).
    const priorOk = new Set(
      (priorState?.op_status ?? [])
        .filter((s) => s.status === 'ok')
        .map((s) => s.op_id),
    );
    // The roles_created ledger carries forward across retries so check-then-
    // create never double-creates.
    const ledger: LedgerEntry[] = [...(priorState?.roles_created ?? [])];
    const ledgerByKey = new Map(ledger.map((e) => [e.role_key, e]));
    const opStatus: OpStatus[] = [];

    for (const op of batch.ops) {
      if (priorOk.has(op.op_id)) {
        // already done in a prior run — skip (no re-write, no re-audit).
        opStatus.push({ op_id: op.op_id, status: 'ok' });
        continue;
      }

      const f = intentFields(op);

      // AUDIT FIRST (write-after-audit, CLUSTER 4): confirm the intent BEFORE
      // the write. A failed confirm ⇒ WriteError("audit_unavailable") and the
      // write does NOT run. This fails the WHOLE batch loud (no un-audited LIVE
      // write) — it is NOT a per-op partial failure.
      yield* emitConfirmed({
        event_type: SHADOW_ROLE_INTENT,
        payload: {
          world: batch.world,
          op_id: f.op_id,
          kind: f.kind,
          role_key: f.role_key,
          member_id: f.member_id,
          report_hash: batch.report_hash,
        },
      }).pipe(
        Effect.mapError(
          (e) =>
            new WriteError({
              kind: 'audit_unavailable',
              message: `intent audit failed before write — write blocked: ${e.message}`,
            }),
        ),
      );

      // The write. Create-ops are serialized per world via the WorldLock and do
      // check-then-create against the ledger (B10); assigns are naturally
      // idempotent. A 429 (rate_limited) or op_failed is a PER-OP failure that
      // does NOT abort the batch (partial_failure); audit_unavailable already
      // short-circuited above.
      const opResult = yield* runOp({
        op,
        cap,
        world: batch.world,
        inner,
        worldLock,
        ledgerByKey,
        ledger,
      }).pipe(
        Effect.map((roleId) => ({ ok: true as const, roleId })),
        // Recover per-op WriteError into a recorded failure (partial_failure)
        // EXCEPT audit_unavailable which must fail the batch (handled above; a
        // write-time audit_unavailable cannot occur here).
        Effect.catchTag('WriteError', (e) =>
          e.kind === 'audit_unavailable'
            ? Effect.fail(e)
            : Effect.succeed({ ok: false as const, error: `${e.kind}: ${e.message}` }),
        ),
      );

      if (opResult.ok) {
        // applied event AFTER a successful write. The write already happened (the
        // role is in `ledger`), but post-write audit COMPLETENESS is part of the
        // contract: a confirmed `shadow.role.applied.v1` must exist for an `ok`
        // op (MAJOR-5). If the applied-confirm FAILS, we do NOT silently keep the
        // op `ok` — we record it as `failed` with an `applied_audit_failed:`
        // error so the batch outcome reflects the missing audit record (the
        // batch flips `done`→`partial_failure`). The role stays in `roles_created`
        // so a RETRY recognizes the write happened and re-emits the applied audit
        // (idempotent reconciliation) rather than re-creating. The
        // intent-confirm-BEFORE-write stays the hard gate (no un-audited write);
        // this tightens post-write completeness.
        const roleId = opResult.roleId;
        const appliedConfirm = yield* emitConfirmed({
          event_type: SHADOW_ROLE_APPLIED,
          payload: {
            world: batch.world,
            op_id: f.op_id,
            kind: f.kind,
            role_key: f.role_key,
            member_id: f.member_id,
            role_id: roleId,
            actor: batch.authz.actor,
          },
        }).pipe(
          Effect.as({ confirmed: true as const }),
          Effect.catchAll((e) => Effect.succeed({ confirmed: false as const, error: e.message })),
        );

        if (appliedConfirm.confirmed) {
          opStatus.push({ op_id: op.op_id, status: 'ok' });
        } else {
          opStatus.push({
            op_id: op.op_id,
            status: 'failed',
            error: `applied_audit_failed: write succeeded but the shadow.role.applied.v1 confirm failed — audit record incomplete: ${appliedConfirm.error}`,
          });
        }
      } else {
        opStatus.push({ op_id: op.op_id, status: 'failed', error: opResult.error });
      }
    }

    const completed = opStatus.filter((s) => s.status === 'ok').length;
    const failed = opStatus.filter((s) => s.status === 'failed').length;
    const status: GoLiveJobState['status'] =
      failed === 0 ? 'done' : completed === 0 ? 'failed' : 'partial_failure';

    return {
      status,
      progress: { total: batch.ops.length, completed, failed },
      roles_created: ledger,
      op_status: opStatus,
    } satisfies ApplyBatchResult;
  });
}

interface RunOpDeps {
  readonly op: WriteOp;
  readonly cap: WriteCapability;
  readonly world: WorldSlug;
  readonly inner: Context.Tag.Service<RoleWriter>;
  readonly worldLock: Context.Tag.Service<WorldLock>;
  readonly ledgerByKey: Map<string, LedgerEntry>;
  readonly ledger: LedgerEntry[];
}

/**
 * Run a single op. `assign_role` is naturally idempotent (re-assign is a no-op
 * at Discord) and needs no world lock.
 *
 * `create_role` (B10 TOCTOU — CRITICAL-1): the GET-then-create span runs INSIDE
 * the per-world lock, and the inner `RoleWriter.createRole` is itself CHECK-THEN-
 * CREATE against LIVE state (the port contract — see ports/index.ts). The
 * cross-batch "exactly one create per role_key per world" guarantee is the
 * COMPOSITION of those two facts: the world-lock serializes batch A's and batch
 * B's create spans, and inside its span batch B's `inner.createRole` GETs a live
 * roleset that ALREADY contains the role batch A created, so it reuses A's id
 * WITHOUT a second create. This holds EVEN when each batch's per-invocation
 * `ledgerByKey` is empty (two fresh concurrent batches) — the guarantee does NOT
 * depend on the caller threading a prior ledger or holding an external mutex.
 *
 * The per-batch `ledgerByKey` check below is an ADDITIONAL same-batch / retry
 * fast-path (skip the live GET when THIS batch — or a prior run threaded via
 * `priorState` — already created the role); it does NOT pre-empt the live
 * check for a key this batch hasn't yet created, so it never skips the
 * cross-batch live dedup. Returns the created/reused id for creates; `undefined`
 * for assigns/revokes/renames (those port methods return void).
 *
 * cycle-010 (FR-9/FR-10): `revoke_role` + `rename_role` are NATURALLY idempotent
 * at Discord (removing an absent role / renaming to the same name is a no-op),
 * exactly like `assign_role` — so they take NO world lock and dispatch to the
 * inner writer's `revokeRole`/`renameRole`. Only `create_role` needs the world
 * lock (the B10 GET-then-create span).
 */
function runOp(deps: RunOpDeps): Effect.Effect<RoleId | undefined, WriteError> {
  const { op, cap, world, inner, worldLock, ledgerByKey, ledger } = deps;

  if (op.kind === 'create_role') {
    // Serialize the entire GET-then-create span per world (B10). The inner
    // createRole's own check-then-create against live state is what dedups
    // across concurrent batches once the lock serializes the spans.
    return worldLock.withWorldLock(
      world,
      Effect.gen(function* () {
        // same-batch / retry fast-path: a role already created for this key in
        // THIS batch (or threaded via priorState)? reuse it without a live GET.
        const existing = ledgerByKey.get(op.intent.role_key);
        if (existing !== undefined) {
          return existing.role_id;
        }
        // check-then-create against LIVE state (port contract). For a concurrent
        // same-world batch, this GETs the first batch's role and reuses its id —
        // the cross-batch dedup. The lock guarantees we observe that role.
        // `op.intent` is narrowed to `CreateRoleIntent` by the `kind` guard
        // (discriminated union — /fagan fix), so NO cast is needed.
        const roleId = yield* inner.createRole(cap, op.intent).pipe(
          // a ShadowGateRejected from the inner LIVE writer should never happen
          // (we only get here under LIVE); normalize it to op_failed.
          Effect.catchTag('ShadowGateRejected', (e) =>
            Effect.fail(new WriteError({ kind: 'op_failed', message: e.message })),
          ),
        );
        const entry: LedgerEntry = { role_key: op.intent.role_key, role_id: roleId, op_id: op.op_id };
        ledger.push(entry);
        ledgerByKey.set(op.intent.role_key, entry);
        return roleId;
      }),
    );
  }

  // The idempotent, lock-free per-member / role-rename ops. Each dispatches to
  // its inner port method; a ShadowGateRejected from the inner LIVE writer
  // should never happen here (we only reach this under LIVE) — normalize it to
  // op_failed, exactly as the assign path always has.
  const normalize = <A>(e: Effect.Effect<A, WriteError | ShadowGateRejected>) =>
    e.pipe(
      Effect.catchTag('ShadowGateRejected', (g) =>
        Effect.fail(new WriteError({ kind: 'op_failed', message: g.message })),
      ),
      Effect.as(undefined),
    );

  if (op.kind === 'revoke_role') {
    // FR-9: revoke ONE member from a role. Idempotent; no world lock.
    // `op.intent` is narrowed to `RevokeRoleIntent` by the `kind` guard.
    return normalize(inner.revokeRole(cap, op.intent));
  }

  if (op.kind === 'rename_role') {
    // FR-10: archive-by-rename. Idempotent; no world lock.
    // `op.intent` is narrowed to `RenameRoleIntent` by the `kind` guard.
    return normalize(inner.renameRole(cap, op.intent));
  }

  // assign_role — idempotent; no world lock needed. FR-11: the OPTIONAL
  // `role_id` rides on the intent and is threaded verbatim to the inner adapter
  // (the live adapter re-verifies the role_key→role_id binding when present);
  // the substrate gate does not interpret it — it stays an opaque pass-through.
  // `op.intent` is narrowed to `AssignRoleIntent` (the only remaining member).
  return normalize(inner.assignRole(cap, op.intent));
}
