/**
 * roles-as-code-surfaces.ts — the three NET-NEW cycle-010 ("Roles-as-Code")
 * config-service surface payload schemas (freeside-characters SDD §2.1/§2.5/§5.3):
 *
 *   • `roster-commit`     — the append-only merge-base commit log (FR-1, §2.1)
 *   • `resolution-ledger` — the durable conflict-resolution map (FR-6, §2.5)
 *   • `pending-apply`     — the durable apply-transaction record (§5.3)
 *
 * ── WHY AUTHORED HERE (not in shadow-substrate) ─────────────────────────────
 * The three S2 surfaces (role-map/apply-mode/onboarding-lifecycle) are SUBSTRATE
 * concerns — they describe desired state + the safety state machine, so the
 * substrate authored them and config-protocol re-imports them. These three are
 * STATE-PLANE concerns: they are the config-service's own durable ledgers (the
 * commit log IS the store's native append-only history; the resolution ledger +
 * pending-apply are versioned documents). Per SDD §4 + §9 fork 4, RosterCommit
 * lives in the config-service `roster-commit` surface, NOT in the substrate's
 * job-scoped `GoLiveJobState`. So config-protocol authors them directly and
 * registers them in surface-config.ts alongside the substrate-imported surfaces.
 *
 * ── DEPENDENCY DIRECTION (unchanged) ────────────────────────────────────────
 * `pending-apply.ops` imports `WriteOp` from `@freeside-worlds/shadow-substrate`
 * (the S2 discriminated-union op), so the one-way arrow `config-protocol →
 * shadow-substrate` is preserved (config-protocol already imports
 * RoleMapConfig/etc from the substrate). Nothing here is imported BACK by the
 * substrate.
 *
 * ── HASHING (commit_id) ─────────────────────────────────────────────────────
 * `commit_id` = `sha256Hex(jcsCanonicalize(payload))` over the canonical commit
 * payload — the SAME `@0xhoneyjar/events` primitive `roleMapVersionHash`
 * (substrate src/pure/role-map-version-hash.ts) and `rosterFingerprint` use, so
 * the digest is byte-deterministic across producers/consumers (SDD §2.1: "reuse
 * the existing rosterFingerprint primitive"). Do NOT reimplement JCS or sha256.
 *
 * ── BLOCKER-1 hardening ─────────────────────────────────────────────────────
 * Every CM-supplied / stored string is built from the SAME `BoundedString` /
 * `NonEmptyBounded` primitives surface-config.ts uses (length cap + control-byte
 * / zero-width reject), and every Struct is CLOSED by default (unknown keys are
 * rejected at decode, with `onExcessProperty: 'error'` in validate.ts). Length
 * caps mirror the existing field-specific bounds.
 */

import { Schema as S } from '@effect/schema';
import { jcsCanonicalize, sha256Hex } from '@0xhoneyjar/events';
// The S2 op union (FR-9/FR-10/FR-11): pending-apply persists an ORDERED WriteOp[]
// so a crash mid-apply is recoverable from the durable record (SDD §5.3 step 4).
import { WriteOp } from '@freeside-worlds/shadow-substrate';
import type { WriteOp as WriteOpType } from '@freeside-worlds/shadow-substrate';

// ─── BLOCKER-1 primitives (byte-identical to surface-config.ts) ─────────────
// Re-declared here so this module owns its own write-side defense without
// reaching into surface-config.ts module-private consts. Same ranges, same
// filter message, same composition — mirrors the shadow-substrate primitives.ts
// byte-identity rationale (S2 grounding note). A future surface-config.ts
// refactor that EXPORTS BoundedString can collapse these to one definition.
const CONTROL_OR_ZEROWIDTH = new RegExp(
  '[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]',
);

const BoundedString = (max: number) =>
  S.String.pipe(
    S.maxLength(max),
    S.filter((s): true | string =>
      CONTROL_OR_ZEROWIDTH.test(s)
        ? 'string contains a control byte or zero-width character (rejected)'
        : true,
    ),
  );

const NonEmptyBounded = (max: number) => BoundedString(max).pipe(S.minLength(1));

// Field caps (mirror surface-config.ts BLOCKER-1 bounds).
const NAME_MAX = 200;
const ID_MAX = 200;
const ISO_MAX = 64; // ISO-8601 timestamps + short ids.

/**
 * 64-char lowercase-hex sha256 digest — the same shape as the substrate's
 * `Hex64` brand (`roleMapVersionHash` output + roster fingerprint). Declared
 * locally (un-branded) so a JSONB-stored commit_id round-trips through
 * decode/encode without the substrate's nominal brand leaking into the wire
 * envelope; the PATTERN is identical, so an invalid digest is still rejected.
 */
const Hex64String = S.String.pipe(S.pattern(/^[0-9a-f]{64}$/));

/**
 * A Discord snowflake / opaque id string (role_id, member_id) — bounded,
 * control-byte-free, non-empty.
 */
const IdString = NonEmptyBounded(ID_MAX);

/**
 * An ISO-8601 timestamp (/fagan R2 MAJOR). Keeps the BLOCKER-1 length +
 * control-byte protection (NonEmptyBounded), and ADDS actual date validation at
 * the sealed-schema boundary: `Date.parse` must succeed. Without this, `ts` /
 * `expires_at` / `started_at` accepted ANY bounded string — and `expires_at` is
 * SECURITY-LOAD-BEARING (the single-use/expiry check on PendingApply, SDD §5.3
 * step 1). A garbage `expires_at` would persist and then never compare sanely.
 * Rejecting at decode means the apply-control invariant can trust the field.
 */
const IsoTimestamp = NonEmptyBounded(ISO_MAX).pipe(
  S.filter((s): true | string =>
    Number.isNaN(Date.parse(s)) ? 'timestamp must be a valid ISO-8601 date-time' : true,
  ),
);

// ─── Surface `roster-commit` (FR-1 · SDD §2.1) — the merge-base commit log ───

/**
 * Ownership of a role at commit time: `manual` = CM-owned (Freeside never
 * touches it); `freeside` = Freeside-managed (eligible for create/grant/revoke/
 * rename). Same vocabulary as the substrate `RoleOwner`; re-declared so the
 * commit payload does not depend on the substrate's `RoleRule` shape.
 */
export const CommitRoleOwner = S.Literal('manual', 'freeside');
export type CommitRoleOwner = S.Schema.Type<typeof CommitRoleOwner>;

/**
 * A role definition FROZEN into the commit (SDD §2.1). `role_key` is the stable
 * merge identity; `role_id` is the observed Discord id frozen at apply time;
 * `display_name` is the mutable Discord name; `color`/`position` are integers;
 * `permissions` is the exact bitfield string (compared byte-for-byte in
 * state_hash, §2.6 — so it is a string, never a number).
 */
export const CommitRoleDefinition = S.Struct({
  role_key: NonEmptyBounded(NAME_MAX),
  role_id: IdString,
  display_name: NonEmptyBounded(NAME_MAX),
  color: S.Number.pipe(S.int()),
  /** exact Discord permission bitfield string (e.g. "1071698660928"). */
  permissions: NonEmptyBounded(NAME_MAX),
  position: S.Number.pipe(S.int()),
});
export type CommitRoleDefinition = S.Schema.Type<typeof CommitRoleDefinition>;

/** Per-role membership snapshot (freeside-owned roles only, SDD §2.1). */
export const CommitMembership = S.Struct({
  role_key: NonEmptyBounded(NAME_MAX),
  member_ids: S.Array(IdString),
});
export type CommitMembership = S.Schema.Type<typeof CommitMembership>;

/**
 * RosterCommit (FR-1 · SDD §2.1) — the restorable merge base. World-keyed
 * (`cmIdentityId=null`), APPEND-ONLY: the store's native config_record history
 * IS the commit log (SDD §4, §9 fork 4). `parent_commit_id` references the prior
 * commit_id; genesis = null. `commit_id` = `sha256(jcs(payload))` over the
 * canonical content (see `computeRosterCommitId` below).
 *
 * `status`: `complete` (full successful apply) or `partial` (apply failed
 * mid-batch). A `partial` commit is NEVER a valid `parent_commit_id` / revert
 * target (FR-8, §2.1) — enforced by the consumer (the schema records the state;
 * the apply planner refuses to chain off a partial).
 *
 * `ownership_map` is a Record<role_key, owner>; modeled as a closed Struct of
 * `{ role_key, owner }` entries is NOT used here because role_keys are
 * CM-authored arbitrary strings (an open key set) — so an `S.Record` keyed by a
 * bounded string with a bounded `manual|freeside` value is the faithful shape.
 */
export const RosterCommit = S.Struct({
  commit_id: Hex64String,
  /** null = genesis (adoption). */
  parent_commit_id: S.Union(Hex64String, S.Null),
  world: NonEmptyBounded(NAME_MAX),
  /** iso-8601 (validated as a real date — /fagan R2). */
  ts: IsoTimestamp,
  /** identity-api user_id of the CM who applied. */
  applied_by: NonEmptyBounded(NAME_MAX),
  /** active desired-state name. */
  theme_id: NonEmptyBounded(NAME_MAX),
  ownership_map: S.Record({ key: BoundedString(NAME_MAX), value: CommitRoleOwner }),
  role_definitions: S.Array(CommitRoleDefinition),
  /** freeside-owned roles only. */
  membership: S.Array(CommitMembership),
  status: S.Literal('complete', 'partial'),
});
export type RosterCommit = S.Schema.Type<typeof RosterCommit>;

/**
 * The canonical content over which `commit_id` is computed (SDD §2.1) — EVERY
 * field of the commit EXCEPT `commit_id` itself (a content hash cannot include
 * its own output). JCS (RFC 8785) sorts keys recursively, so caller field ORDER
 * does not matter; we pass the explicit content object and hash its canonical
 * string with the cluster's `@0xhoneyjar/events` primitive (byte-identical to
 * `roleMapVersionHash` / `rosterFingerprint`).
 */
export type RosterCommitContent = Omit<RosterCommit, 'commit_id'>;

/**
 * Compute the content-addressed `commit_id` for a RosterCommit. PURE — same
 * content ⇒ same 64-char lowercase-hex digest, byte-for-byte matching the
 * canonical events JCS+sha256. The caller supplies the commit WITHOUT a
 * commit_id (or with any commit_id — it is stripped before hashing).
 */
export function computeRosterCommitId(content: RosterCommitContent): string {
  // Strip a possibly-present commit_id so a hash is never over its own output.
  const { ...rest } = content as RosterCommitContent & { commit_id?: unknown };
  delete (rest as { commit_id?: unknown }).commit_id;
  return sha256Hex(jcsCanonicalize(rest));
}

// ─── Surface `resolution-ledger` (FR-6 · SDD §2.5) — durable conflict map ────

/**
 * A single resolution entry (SDD §2.5). `resolved_against_base` is the PER-SLICE
 * base hash (flatline SKP-002): a definition-drift resolution keys on the role's
 * definition/ownership base hash; a membership-drift resolution on its
 * membership base hash — NOT the whole-roster commit_id. This is the
 * churn-eviction fix: routine membership churn (which moves the whole-roster
 * fingerprint) MUST NOT evict definition resolutions. A resolution is evicted
 * only when ITS slice's base moves, or the CM clears it.
 */
export const ResolutionEntry = S.Struct({
  /** the chosen resolution (one of the §2.7 closed taxonomy, opaque here). */
  resolution: NonEmptyBounded(NAME_MAX),
  /** the PER-SLICE base hash the resolution was made against (SKP-002). */
  resolved_against_base: Hex64String,
  /** iso-8601 (validated as a real date — /fagan R2; the TTL prune relies on it). */
  ts: IsoTimestamp,
  /** identity-api user_id of the CM who resolved. */
  by: NonEmptyBounded(NAME_MAX),
});
export type ResolutionEntry = S.Schema.Type<typeof ResolutionEntry>;

/**
 * ResolutionLedger (FR-6 · SDD §2.5) — world-keyed, DURABLE. The whole ledger is
 * ONE versioned document (SDD §9 fork 2: avoids generalizing the store's single
 * cmIdentityId sub-key). The body is a JSONB MAP keyed by the composite string
 * `"<role_key>:<conflict_type>"` → ResolutionEntry. We model the wrapper as a
 * closed Struct `{ entries: Record<composite_key, ResolutionEntry> }` so the
 * envelope has a stable named field (rather than a bare top-level open record,
 * which would collide with the envelope's own keys in the discriminated union).
 *
 * The composite key is a bounded control-byte-free string; its `role_key:conflict_type`
 * SHAPE is the consumer's contract (the substrate's conflict taxonomy is the
 * conflict_type vocabulary — opaque to the store, which just persists the map).
 */
export const ResolutionLedger = S.Struct({
  entries: S.Record({ key: BoundedString(NAME_MAX), value: ResolutionEntry }),
});
export type ResolutionLedger = S.Schema.Type<typeof ResolutionLedger>;

// ─── Surface `pending-apply` (SDD §5.3) — durable apply-transaction record ───

/**
 * Per-op progress status (SDD §5.3 step 6). `op_id` keys back to the op in
 * `ops[]`; `status` is the live progress. Mirrors the substrate
 * `GoLiveJobState.op_status` shape so the two ledgers stay legible together.
 */
export const PendingApplyOpStatus = S.Struct({
  op_id: NonEmptyBounded(ID_MAX),
  status: S.Literal('pending', 'ok', 'failed'),
  error: S.optional(BoundedString(NAME_MAX)),
});
export type PendingApplyOpStatus = S.Schema.Type<typeof PendingApplyOpStatus>;

/**
 * The pre-apply snapshot (SDD §5.3 step 4/5) — the LATEST pre-corruption point,
 * captured after the state_hash re-verify and BEFORE the first applyBatch write.
 * Full defs + membership so a partial apply is always restorable. Reuses the
 * commit role-def/membership shapes (a snapshot IS a restorable roster slice).
 */
export const PreApplySnapshot = S.Struct({
  role_definitions: S.Array(CommitRoleDefinition),
  membership: S.Array(CommitMembership),
});
export type PreApplySnapshot = S.Schema.Type<typeof PreApplySnapshot>;

/**
 * PendingApply (SDD §5.3) — the durable apply-transaction record. World-keyed.
 * Written BEFORE any Discord write (version-guarded CAS via the store's
 * `expectedVersion` + the lease `fencing_token`), so a crash after a partial
 * mutation is always recoverable (the snapshot + ordered op list are durable
 * before the guild is mutated). `ops` is the S2 `WriteOp[]` (FR-9/10/11), ordered.
 *
 * Apply-control authz (flatline SKP-004): `authorized_actor` + `expires_at` make
 * the record single-use + expiring — the apply path verifies the clicking CM IS
 * the authorized actor and the record is unexpired before consuming it.
 */
export const PendingApply = S.Struct({
  /** short id keyed into the custom_id (SDD §2.6 plan_id indirection). */
  apply_id: NonEmptyBounded(ID_MAX),
  world: NonEmptyBounded(NAME_MAX),
  /** the commit this apply is based on (null = genesis adoption). */
  base_commit_id: S.Union(Hex64String, S.Null),
  /** the world-lease fencing token carried into every config-service write (CAS). */
  fencing_token: NonEmptyBounded(ID_MAX),
  /** identity-api user_id authorized to consume this apply (single-use). */
  authorized_actor: NonEmptyBounded(NAME_MAX),
  /**
   * iso-8601 expiry; a stale apply is rejected. SECURITY-LOAD-BEARING (single-
   * use/expiry, SDD §5.3 step 1) — validated as a REAL date at decode (/fagan
   * R2) so a garbage expiry can never persist and silently never-expire.
   */
  expires_at: IsoTimestamp,
  pre_apply_snapshot: PreApplySnapshot,
  /** the ordered op list (S2 discriminated-union WriteOp). */
  ops: S.Array(WriteOp),
  /** per-op progress (key (apply_id, op_id)). */
  op_status: S.Array(PendingApplyOpStatus),
  /** iso-8601 (validated as a real date — /fagan R2). */
  started_at: IsoTimestamp,
});
export type PendingApply = S.Schema.Type<typeof PendingApply>;

// Re-export the substrate WriteOp type for callers that type ops[] directly.
export type { WriteOpType };
