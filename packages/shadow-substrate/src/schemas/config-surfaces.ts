/**
 * config-surfaces.ts — the three NEW config-surface payload schemas (SDD §3.2),
 * authored IN-PACKAGE this sprint. S2 re-exports these INTO config-protocol
 * (extending `SurfaceSchema`/`SurfaceConfigMap`/`KNOWN_SURFACES`) — the
 * dependency arrow stays one-way `shadow-substrate → config-protocol` (SDD §1.4).
 *
 * Every CM-editable / stored string is built from `BoundedString` so the
 * BLOCKER-1 write-side hardening (length cap + control-byte/zero-width reject)
 * is inherited at the contract layer. `@effect/schema` `Struct` is CLOSED by
 * default — unknown keys are rejected at decode.
 */
import { Schema as S } from '@effect/schema';
import { Hex64 } from '../types.js';
import { GoLiveJobState } from '../types.js';
import { BoundedString, NonEmptyBounded, NAME_MAX, DESCRIPTION_MAX } from './primitives.js';

// ─── Surface `role-map` — role rules + scaffolding (the proposed effect) ─────

/**
 * Ownership of a role (cycle-010 FR-3, SDD §2.3): `manual` = the CM owns it,
 * Freeside never touches it in a plan; `freeside` = a Freeside-managed role,
 * eligible for create/grant/revoke/rename. Ownership IS desired state, so it
 * folds into the `roleMapVersionHash` (an ownership change correctly re-versions
 * the map + triggers the staleness guard + the TAKEOVER ceremony, §2.3).
 */
export const RoleOwner = S.Literal('manual', 'freeside');
export type RoleOwner = S.Schema.Type<typeof RoleOwner>;

/**
 * A single role rule (SDD §3.2). `role_key` is the stable join key,
 * Freeside-namespaced for FR-9 coexistence. `display_name` (cycle-010 FR-2) is
 * the MUTABLE Discord role name, DISTINCT from the stable `role_key` (§2.2) —
 * the writer creates with `display_name`, resolves existing roles by frozen
 * `role_id`, and a display_name vs recorded-name mismatch becomes a rename
 * conflict (never a break). `qualifies` is the (MVP: tier) qualification
 * predicate — opaque to the substrate, evaluated by the ScoreSource read-model.
 * `create_if_absent` is role CREATION (FR-4).
 */
export const RoleRule = S.Struct({
  role_key: NonEmptyBounded(NAME_MAX),
  display_name: NonEmptyBounded(NAME_MAX),
  /**
   * FR-3 (cycle-010): ownership. PLAIN-OPTIONAL so an existing role-map authored
   * WITHOUT `owner` still decodes AND existing typed `RoleRule` literals across
   * the cluster still compile unbroken (additivity is the invariant — a
   * `default`-bearing `optionalWith` would make the DECODED Type require `owner`
   * and break every existing literal). The DEFAULT is applied by the CONSUMER:
   * `owner ?? 'manual'` — `manual` is the safe default (Freeside touches nothing
   * unless explicitly marked `freeside`). Helper `roleOwnerOf(rule)` (below)
   * centralizes that resolution. NOTE (§2.3 hash interaction): because absent
   * `owner` stays `undefined` (dropped by JCS), an un-decoded map hashes
   * IDENTICALLY to today (the frozen CANONICAL_VERSION_HASH is preserved); only
   * a map that EXPLICITLY carries `owner` re-versions, which is the desired §2.3
   * behavior (an ownership change is a desired-state change).
   */
  owner: S.optional(RoleOwner),
  qualifies: S.Struct({
    source: S.Literal('tier'),
    /** opaque tier id (score-api owns the values — #221). */
    min_tier: NonEmptyBounded(NAME_MAX),
  }),
  create_if_absent: S.Boolean,
});
export type RoleRule = S.Schema.Type<typeof RoleRule>;

/**
 * FR-3 (cycle-010) consumer-side default resolver: a rule with no explicit
 * `owner` is `manual` (Freeside touches nothing unless explicitly marked
 * `freeside`). Centralizing the `?? 'manual'` here keeps the default in ONE
 * place so the 4 managed-predicate call sites (SDD §2.3) cannot drift. PURE.
 */
export function roleOwnerOf(rule: { readonly owner?: RoleOwner }): RoleOwner {
  return rule.owner ?? 'manual';
}

/**
 * Bounded scaffolding structure (SDD §3.2 "scaffolding: structure to scaffold;
 * bounded"). MVP shape: an optional list of named, bounded scaffold entries.
 * Kept deliberately small + closed; deterministic so it folds cleanly into the
 * `roleMapVersionHash` (§3.3).
 */
export const ScaffoldingConfig = S.Struct({
  channels: S.optional(
    S.Array(
      S.Struct({
        key: NonEmptyBounded(NAME_MAX),
        label: NonEmptyBounded(NAME_MAX),
      }),
    ),
  ),
});
export type ScaffoldingConfig = S.Schema.Type<typeof ScaffoldingConfig>;

export const RoleMapConfig = S.Struct({
  enabled: S.Boolean,
  /** FR-9: the Freeside-managed role set boundary. */
  namespace_prefix: NonEmptyBounded(NAME_MAX),
  rules: S.Array(RoleRule),
  scaffolding: S.optional(ScaffoldingConfig),
});
export type RoleMapConfig = S.Schema.Type<typeof RoleMapConfig>;

// ─── Surface `apply-mode` — the single safety-bearing state field (FR-3) ─────

export const ApplyModeConfig = S.Struct({
  /** DEFAULT SHADOW (caller default on 404). */
  apply_mode: S.Literal('SHADOW', 'LIVE'),
  /** FR-7: the report hash the last go_live was authorized against (forensic). */
  last_go_live_report_hash: S.optional(Hex64),
});
export type ApplyModeConfig = S.Schema.Type<typeof ApplyModeConfig>;

// ─── Surface `onboarding-lifecycle` — per-CM resumable record (FR-2, B1) ─────

export const OnboardingStep = S.Literal(
  'install',
  'servers',
  'role_map',
  'shadow_preview',
  'go_live',
  'done',
);
export type OnboardingStep = S.Schema.Type<typeof OnboardingStep>;

export const LinkState = S.Literal('linked', 'unlinked', 'degraded');
export type LinkState = S.Schema.Type<typeof LinkState>;

/**
 * The resumable cross-medium state record (FR-2). STORED as a per-CM
 * composite-keyed record `(world_slug, "onboarding-lifecycle", cm_identity_id)`
 * (B1/SKP-006): two CMs onboarding the same world get TWO records, never one
 * shared/overwritten row. `cm_identity_id` is BOTH a key component AND carried
 * in the payload. The composite-key plumbing lands in S2's config-engine.
 */
export const OnboardingLifecycle = S.Struct({
  /** identity-api user_id (UUID); the stable cross-medium key. */
  cm_identity_id: S.UUID,
  /** the LENS's view of setup progress, NOT the apply_mode state machine. */
  step: OnboardingStep,
  /** FR-2 failure/recovery states (FL-HC6); never silently fork. */
  link_state: LinkState,
  last_medium: S.Literal('web', 'discord'),
  /** the idempotent roles-created ledger + async go-live job progress (§4.4). */
  go_live_job: S.optional(GoLiveJobState),
});
export type OnboardingLifecycle = S.Schema.Type<typeof OnboardingLifecycle>;

/** Re-export the description cap used by lens copy fields (avoids a dead import). */
export { DESCRIPTION_MAX, BoundedString };
