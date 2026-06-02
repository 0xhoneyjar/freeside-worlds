/**
 * effectful/index.ts — barrel for the EFFECTFUL programs + ports (SDD §4.6, S1).
 *
 * These REQUIRE Layers (the I/O seam). They are exported from the package barrel
 * (index.ts) as the EFFECTFUL half of the §4.6 table. DELIBERATELY ABSENT:
 *   - `mintWriteCapability` (the capability constructor — internal to go-live.ts;
 *     the reachability test asserts it is not reachable through the barrel).
 *   - the `*.mock.ts` test Layers (test-only; importable directly by tests via
 *     their file paths, never re-exported to consumers).
 */

// The gate — the ONLY write path.
export {
  GateCheckedRoleWriter,
  makeGateCheckedRoleWriter,
  type GateCheckedRoleWriterService,
  type ApplyBatchResult,
} from './gate-checked-role-writer.js';

// The mode control (Ref + shared batch-duration lock, B5/R-10).
export { makeModeControl, type ModeControl } from './mode-control.js';

// The authorized SHADOW→LIVE orchestration (mints the capability internally) +
// the lock-aware rollback (B5 inverse-race fix).
export {
  goLive,
  rollback,
  type GoLiveInput,
  type GoLiveOutput,
} from './go-live.js';

// FR-10 authz preflight (B3/B4) — the ONE authoritative decision flow + the
// read-path wrapper + the manifest-read seam port.
export {
  resolveAuthz,
  AdminAllowlistSource,
  type ResolveAuthzInput,
} from './resolve-authz.js';
export { resolveReader } from './resolve-reader.js';

// The roster/score loaders (require RosterSource/ScoreSource).
export { loadCurrentRoster, loadLatentCounts } from './loaders.js';

// Roster-freshness re-eval (B1) + the fingerprint.
export {
  rosterFingerprint,
  evalRosterFreshness,
  newlyArrivedCount,
  netRosterChangeCount,
  ROSTER_DRIFT_THRESHOLD_DEFAULT,
  type RosterIdentitySnapshot,
  type RosterFreshnessInput,
} from './roster-freshness.js';

// The audit + world-lock ports (the actor supplies the concrete Layers, S4).
export { AcvpEmitter } from './acvp-emitter.js';
export { WorldLock } from './world-lock.js';
