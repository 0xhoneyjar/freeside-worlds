/**
 * @freeside-worlds/shadow-substrate — the pure, distributed shadow core (the
 * keystone). A universal preview/diff primitive: compute a proposed effect,
 * project a before→after diff, and apply ONLY behind two substrate-enforced
 * gates. ZERO I/O lives here — all I/O is injected as Layers by the consuming
 * lenses. Distributed git-source/SHA-pinned, never npm.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * EXPORTED-SYMBOL TABLE (FR-8 / SDD §4.6) — each symbol marked PURE or EFFECTFUL
 * ────────────────────────────────────────────────────────────────────────────
 * | Export                                    | Kind          | Purity         |
 * |-------------------------------------------|---------------|----------------|
 * | transition                                | fn            | PURE *         |
 * | computeProposed, diff                     | fn            | PURE           |
 * | roleMapVersionHash                        | fn            | PURE           |
 * | rosterFingerprint, newlyArrivedCount      | fn            | PURE (B1)      |
 * | evalRosterFreshness                       | fn            | PURE (Effect/GuardFailed) |
 * | loadCurrentRoster                         | fn            | EFFECTFUL (req. RosterSource) |
 * | loadLatentCounts                          | fn            | EFFECTFUL (req. ScoreSource)  |
 * | resolveAuthz                              | fn            | EFFECTFUL (req. AdminAllowlistSource+AcvpEmitter) |
 * | resolveReader                             | fn            | EFFECTFUL (B4, wraps resolveAuthz) |
 * | goLive                                    | fn            | EFFECTFUL (authorized SHADOW→LIVE; mints cap internally) |
 * | rollback                                  | fn            | EFFECTFUL (lock-aware, B5)    |
 * | makeGateCheckedRoleWriter                 | Layer factory | EFFECTFUL (the gate; audit-before-write inside) |
 * | makeModeControl                           | fn            | EFFECTFUL (Ref + shared lock) |
 * | GateCheckedRoleWriter, AcvpEmitter,       | Context.Tag   | (port)         |
 * |   WorldLock, AdminAllowlistSource         |               |                |
 * | RosterSource, RoleWriter, ScoreSource     | Context.Tag   | (port)         |
 * | WriteCapability                           | branded type  | (cap.)         |
 * | WriteIntentBatch, WriteOp, GoLiveJobState, | type/schema   | (data)        |
 * |   AuthzContext, AuthzDecision, GuardInputs |               |                |
 * | RoleMapConfig, RoleRule, ApplyModeConfig,  | schema        | (data)        |
 * |   OnboardingLifecycle, ScaffoldingConfig  |               |                |
 * | Discrepancy, ProposedRoster, CurrentRoster | type/schema  | (data)        |
 * | ShadowEventType + shadow.* payload schemas | schema        | (data, §6.3)  |
 * | GuardFailed, ShadowGateRejected,          | error ADT     | (data)         |
 * |   WriteError, AuthzError, AuditError,     |               |                |
 * |   RosterError, ScoreError                 |               |                |
 * | Hex64, WorldSlug, RoleId, MemberId,       | branded prim. | (data)         |
 * |   ApplyMode, TransitionEvent              |               |                |
 *
 * * `transition` is PURE: an Effect over ALREADY-RESOLVED guard inputs with NO
 *   requirement channel and NO I/O — its only effect is the typed `GuardFailed`
 *   error channel + a defect on structurally-illegal transitions (§4.2).
 *
 * DELIBERATE ABSENCES (asserted by tests/exports.test.ts — SDD §8.4 proof 1):
 *   - NO raw live-writer constructor (the only RoleWriter write path is the
 *     EFFECTFUL `makeGateCheckedRoleWriter` gate — and it still REQUIRES a
 *     `RoleWriter` Layer + a `WriteCapability` per write).
 *   - NO `WriteCapability` CONSTRUCTOR (`mintWriteCapability` is internal to
 *     go-live.ts; only the authorized SHADOW→LIVE path mints it). The branded
 *     type is exported for the LIVE signature; its constructor is not reachable.
 *   - NO `*.mock.ts` test Layers, NO discord.js/HTTP/DB/NATS symbol.
 */

// ─── PURE functions (the keystone compute core, SDD §4.2) ───────────────────
export {
  roleMapVersionHash,
  computeProposed,
  diff,
  transition,
} from './src/pure/index.js';
export type {
  RoleMapVersionInput,
  WorldConfigHashFields,
  ProposedMembership,
  DiffOptions,
  LatentCounts,
} from './src/pure/index.js';

// ─── Ports — Context.Tags (signatures only; Layers supplied by lenses, S4) ──
export { RosterSource, RoleWriter, ScoreSource } from './src/ports/index.js';

// ─── EFFECTFUL programs + ports (S1 — the gate + preflights, SDD §4.6) ───────
// These REQUIRE Layers. `mintWriteCapability` is NOT among them (internal to the
// authorized go_live path — the reachability test asserts its absence).
export {
  GateCheckedRoleWriter,
  makeGateCheckedRoleWriter,
  makeModeControl,
  goLive,
  rollback,
  resolveAuthz,
  resolveReader,
  AdminAllowlistSource,
  loadCurrentRoster,
  loadLatentCounts,
  rosterFingerprint,
  evalRosterFreshness,
  newlyArrivedCount,
  netRosterChangeCount,
  ROSTER_DRIFT_THRESHOLD_DEFAULT,
  AcvpEmitter,
  WorldLock,
} from './src/effectful/index.js';
export type {
  GateCheckedRoleWriterService,
  ApplyBatchResult,
  ModeControl,
  GoLiveInput,
  GoLiveOutput,
  ResolveAuthzInput,
  RosterIdentitySnapshot,
  RosterFreshnessInput,
} from './src/effectful/index.js';

// ─── In-package `shadow.*` ACVP event types + payload schemas (SDD §6.3) ─────
// The canonical registry registration is task 402.7 (separate, gated); these
// reconcile to it at the events-pin bump (see src/events/shadow-events.ts).
export {
  SHADOW_ROLE_REJECTED,
  SHADOW_ROLE_INTENT,
  SHADOW_ROLE_APPLIED,
  SHADOW_MODE_TRANSITIONED,
  SHADOW_AUTHZ_DECIDED,
  ShadowEventType,
  ShadowRoleRejectedPayload,
  ShadowRoleIntentEventPayload,
  ShadowRoleAppliedPayload,
  ShadowModeTransitionedPayload,
  ShadowAuthzDecidedPayload,
} from './src/events/shadow-events.js';
export type { ShadowEvent } from './src/events/shadow-events.js';

// ─── Branded primitives + capability/batch/authz data types ─────────────────
// NOTE: `WriteCapability` is exported as a TYPE only (`export type`); its
// constructor is NOT exported (SDD §4.4.4 / §8.4 proof 1).
export {
  Hex64,
  WorldSlug,
  RoleId,
  MemberId,
  ApplyMode,
  TransitionEvent,
  CreateRoleIntent,
  AssignRoleIntent,
  WriteOpKind,
  WriteOp,
  RosterVersion,
  AuthzContext,
  WriteIntentBatch,
  GoLiveJobStatus,
  GoLiveJobState,
  AuthzDecision,
} from './src/types.js';
export type { WriteCapability, GuardInputs } from './src/types.js';

// ─── Config-surface payload schemas (authored in-package; S2 re-exports) ────
export {
  RoleRule,
  ScaffoldingConfig,
  RoleMapConfig,
  ApplyModeConfig,
  OnboardingStep,
  LinkState,
  OnboardingLifecycle,
} from './src/schemas/config-surfaces.js';

// ─── Render-model (the lens contract, SDD §6.4) ─────────────────────────────
export {
  BeforeRole,
  AfterRole,
  PreexistingRole,
  LatentQualified,
  RoleCountProjection,
  CurrentRoster,
  ProposedRoster,
  Discrepancy,
} from './src/schemas/render-model.js';

// ─── Typed error ADT (SDD §7.1) ─────────────────────────────────────────────
export {
  GuardFailed,
  ShadowGateRejected,
  WriteError,
  AuthzError,
  AuditError,
  RosterError,
  ScoreError,
} from './src/errors.js';
export type { GuardFailureReason, WriteErrorKind, ShadowError } from './src/errors.js';
