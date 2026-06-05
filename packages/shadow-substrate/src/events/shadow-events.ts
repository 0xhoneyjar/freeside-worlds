/**
 * events/shadow-events.ts — the `shadow.*` ACVP event-type identifiers + payload
 * `@effect/schema` shapes, authored IN-PACKAGE (SDD §6.3, sprint task 402.2).
 *
 * ── WHY THESE LIVE IN-PACKAGE (NOT imported from @0xhoneyjar/events) ──────────
 * The canonical ACVP registry registration of these families — adding
 * `shadow.role.{rejected,intent,applied}.v1`, `shadow.mode.transitioned.v1`,
 * `shadow.authz.decided.v1` to `packages/events`' `REGISTRY_ENTRIES` — is sprint
 * task **402.7**, a SEPARATE loa-freeside task gated behind operator approval
 * (the events package is in the platform monolith; the substrate consumes it
 * SHA-pinned). Until that lands, the substrate cannot import a `SchemaId` for a
 * `shadow.*` family that the pinned events registry does not yet contain.
 *
 * So S1 defines the payload shapes here, in the substrate's own bounded context,
 * and the `AcvpEmitter` port (see ../effectful/acvp-emitter.ts) is typed against
 * THESE local shapes. The concrete emitter Layer (which a consumer supplies,
 * wrapping the real events `makeEmitter`) reconciles the local payloads to the
 * canonical registry entries at the events-pin bump that lands 402.7.
 *
 * ── RECONCILIATION CONTRACT (events-pin bump / task 402.7) ───────────────────
 * When 402.7 registers these families in `@0xhoneyjar/events`:
 *   1. The `ShadowEventType` literals here MUST equal the registered
 *      `event_type` strings byte-for-byte (3-segment `{aggregate}.{noun}.{verb}.vN`).
 *   2. Each payload schema here MUST be SET-EQUAL (key-wise) to the registered
 *      payload schema — verified by extending the conformance fixture (B7) with
 *      these shapes so a divergence fails the build before deploy.
 *   3. The concrete emitter Layer maps `(ShadowEventType, payload)` → the events
 *      `Emitter.emit(SchemaId, payload)` call; the substrate-internal `AcvpEmitter`
 *      contract (confirm-before-write) is preserved.
 *
 * The substrate stays I/O-free: no NATS, no signer, no transport here — only the
 * type identifiers + payload shapes + the port (../effectful/acvp-emitter.ts).
 */
import { Schema as S } from '@effect/schema';
import { Hex64, WorldSlug } from '../types.js';

// ─── Event-type identifiers (3-segment ACVP topic stems, SDD §6.3) ───────────

export const SHADOW_ROLE_REJECTED = 'shadow.role.rejected.v1' as const;
export const SHADOW_ROLE_INTENT = 'shadow.role.intent.v1' as const;
export const SHADOW_ROLE_APPLIED = 'shadow.role.applied.v1' as const;
export const SHADOW_MODE_TRANSITIONED = 'shadow.mode.transitioned.v1' as const;
export const SHADOW_AUTHZ_DECIDED = 'shadow.authz.decided.v1' as const;

/** The closed set of `shadow.*` event-type identifiers this substrate emits. */
export const ShadowEventType = S.Literal(
  SHADOW_ROLE_REJECTED,
  SHADOW_ROLE_INTENT,
  SHADOW_ROLE_APPLIED,
  SHADOW_MODE_TRANSITIONED,
  SHADOW_AUTHZ_DECIDED,
);
export type ShadowEventType = S.Schema.Type<typeof ShadowEventType>;

// ─── Payload shapes ──────────────────────────────────────────────────────────

/**
 * The SHARED role-op fields every `shadow.role.*` payload carries — the SINGLE
 * SOURCE OF TRUTH for `{world, op_id, kind, role_key, member_id}` (CLEANUP 2 /
 * FAGAN iter-2). Each concrete event SPREADS these fields into its own `S.Struct`
 * and adds only its discriminating field(s) (`apply_mode`, `report_hash`,
 * `role_id` + `actor`). A plain field-record spread (NOT `S.extend`) is used
 * deliberately so every concrete payload stays a flat `S.Struct` whose `.fields`
 * the conformance check (`structKeys`) reads directly — `S.extend` wraps the AST
 * and hides `.fields`, which would silently break the B7 shape-skew guard.
 * Kept narrow: the op kind + role_key + (for assigns) member id. Mirrors
 * `WriteOp` semantics without re-exporting the full batch shape into the payload.
 */
export const shadowRoleBaseFields = {
  world: WorldSlug,
  op_id: S.String,
  // cycle-010 FR-9/FR-10: ADDITIVELY widen the op-kind literal to carry the
  // revoke/rename ops through the same audited write path. This is a literal-
  // UNION WIDENING — `create_role`/`assign_role` are unchanged, so existing
  // payloads still decode. The payload KEY SET is unchanged (`kind` is still one
  // key), so the B7 conformance shape-skew guard (which compares key SETS, not
  // literal members) stays green; the 402.7 events-registry reconciliation must
  // register the same widened literal set.
  kind: S.Literal('create_role', 'assign_role', 'revoke_role', 'rename_role'),
  role_key: S.String,
  member_id: S.optional(S.String),
} as const;

/**
 * The role-write intent carried in the role.* events (the base shape, exported
 * for back-compat / consumer reference). Equal to the shared base fields.
 */
export const ShadowRoleIntentPayload = S.Struct({ ...shadowRoleBaseFields });
export type ShadowRoleIntentPayload = S.Schema.Type<typeof ShadowRoleIntentPayload>;

/**
 * `shadow.role.rejected.v1` — a write was attempted under SHADOW (FR-3). The
 * existence of this CONFIRMED, signed record per attempted write is what makes
 * "SHADOW ⇒ zero writes" provable from the trace (SDD §4.4.5/§8.4).
 */
export const ShadowRoleRejectedPayload = S.Struct({
  ...shadowRoleBaseFields,
  apply_mode: S.Literal('SHADOW'),
});
export type ShadowRoleRejectedPayload = S.Schema.Type<typeof ShadowRoleRejectedPayload>;

/**
 * `shadow.role.intent.v1` — emitted + CONFIRMED BEFORE the side-effecting write
 * (write-after-audit, SDD §4.4.2). `report_hash` binds it to the authorized
 * go_live report.
 */
export const ShadowRoleIntentEventPayload = S.Struct({
  ...shadowRoleBaseFields,
  report_hash: Hex64,
});
export type ShadowRoleIntentEventPayload = S.Schema.Type<typeof ShadowRoleIntentEventPayload>;

/** `shadow.role.applied.v1` — the LIVE write succeeded. */
export const ShadowRoleAppliedPayload = S.Struct({
  ...shadowRoleBaseFields,
  /** the created role id (for create_role ops) / the assigned role id. */
  role_id: S.optional(S.String),
  actor: S.String,
});
export type ShadowRoleAppliedPayload = S.Schema.Type<typeof ShadowRoleAppliedPayload>;

/** `shadow.mode.transitioned.v1` — apply_mode changed. */
export const ShadowModeTransitionedPayload = S.Struct({
  world: WorldSlug,
  from: S.Literal('SHADOW', 'LIVE'),
  to: S.Literal('SHADOW', 'LIVE'),
  actor: S.String,
  report_hash: S.optional(Hex64),
});
export type ShadowModeTransitionedPayload = S.Schema.Type<typeof ShadowModeTransitionedPayload>;

/** `shadow.authz.decided.v1` — an FR-10 authz decision (grant OR deny). */
export const ShadowAuthzDecidedPayload = S.Struct({
  world: WorldSlug,
  actor: S.String,
  decision: S.Literal('grant', 'deny'),
  authz_decision_id: S.String,
  reason: S.String,
});
export type ShadowAuthzDecidedPayload = S.Schema.Type<typeof ShadowAuthzDecidedPayload>;

/**
 * The discriminated union of `(event_type, payload)` pairs the `AcvpEmitter`
 * accepts. The emitter's `emitConfirmed` is typed against this so a payload that
 * does not match its event-type is a COMPILE error.
 */
export type ShadowEvent =
  | { readonly event_type: typeof SHADOW_ROLE_REJECTED; readonly payload: ShadowRoleRejectedPayload }
  | { readonly event_type: typeof SHADOW_ROLE_INTENT; readonly payload: ShadowRoleIntentEventPayload }
  | { readonly event_type: typeof SHADOW_ROLE_APPLIED; readonly payload: ShadowRoleAppliedPayload }
  | { readonly event_type: typeof SHADOW_MODE_TRANSITIONED; readonly payload: ShadowModeTransitionedPayload }
  | { readonly event_type: typeof SHADOW_AUTHZ_DECIDED; readonly payload: ShadowAuthzDecidedPayload };
