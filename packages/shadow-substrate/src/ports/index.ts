/**
 * ports/index.ts — the I/O seam (SDD §4.3), declared as `Context.Tag`s.
 *
 * SIGNATURES ONLY. The Layer implementations (MOCK + LIVE) are supplied by the
 * consuming lenses (freeside-characters / freeside-dashboard) in S4 — never
 * here. The substrate has NO HTTP/DB/discord.js dependency; that absence is the
 * invariant that makes "SHADOW ⇒ zero writes" provable.
 *
 * Follows the existing persona-engine `ambient/{ports,mock,live}` idiom exactly
 * (`Context.Tag` with a service-shape; `Layer.succeed` mock / `Layer.effect`
 * live at the call site).
 */
import { Context, Effect } from 'effect';
import type { WorldSlug, RoleId, WriteCapability } from '../types.js';
import type { CreateRoleIntent, AssignRoleIntent } from '../types.js';
import type { CurrentRoster } from '../schemas/render-model.js';
import type { RoleRule } from '../schemas/config-surfaces.js';
import type {
  RosterError,
  WriteError,
  ShadowGateRejected,
  ScoreError,
} from '../errors.js';

/**
 * `RosterSource` — reads the current Discord guild roster (roles + members).
 * MOCK returns fixtures (zero Discord calls); LIVE reads the real guild.
 */
export class RosterSource extends Context.Tag('shadow/RosterSource')<
  RosterSource,
  {
    readonly currentRoster: (
      world: WorldSlug,
    ) => Effect.Effect<CurrentRoster, RosterError>;
  }
>() {}

/**
 * `RoleWriter` — the role-mutation port. The GATE is internal
 * (`GateCheckedRoleWriter`, S1); a concrete LIVE adapter is reachable ONLY
 * through it. Every write REQUIRES a `WriteCapability` (a COMPILE-TIME
 * accident-prevention seam — NOT a runtime secret; SDD §4.4.4): a raw write
 * written by mistake will not type-check. The enforced boundary is the gate +
 * server-side authz + write-after-audit, not the token's runtime forgeability.
 *
 * ── PORT CONTRACT: `createRole` IS check-then-create / idempotent-by-role_key
 *    against LIVE state (SDD §4.4.1, B10) ────────────────────────────────────
 * `createRole` MUST `GET` the guild roleset and create a role ONLY IF a role
 * with the namespaced `role_key` is ABSENT; if a role with that key already
 * exists it MUST return the existing id WITHOUT creating a second one. This is
 * the load-bearing contract for the cross-batch B10 (TOCTOU) guarantee: the
 * gate serializes the GET-then-create span per world via the `WorldLock`, so a
 * second concurrent same-world batch's `createRole` GETs a roleset that ALREADY
 * contains the first batch's role and reuses it — exactly one create per
 * role_key per world, even under concurrency. The cross-batch dedup is a
 * property of (world-lock-serialized span) × (check-then-create against live
 * state) — it does NOT depend on the caller threading a prior ledger or holding
 * an external mutex. (The in-batch / cross-retry `roles_created` ledger inside
 * the gate is an ADDITIONAL fast-path skip; it is not the cross-batch guarantee.)
 */
export class RoleWriter extends Context.Tag('shadow/RoleWriter')<
  RoleWriter,
  {
    /**
     * Check-then-create against live state, serialized by the gate's world-lock.
     * Idempotent by `role_key`: if a role with the namespaced key already exists
     * in the live roleset, return its id (no second create). See the port
     * contract above (B10).
     */
    readonly createRole: (
      cap: WriteCapability,
      intent: CreateRoleIntent,
    ) => Effect.Effect<RoleId, WriteError | ShadowGateRejected>;
    readonly assignRole: (
      cap: WriteCapability,
      intent: AssignRoleIntent,
    ) => Effect.Effect<void, WriteError | ShadowGateRejected>;
  }
>() {}

/**
 * `ScoreSource` — latent-member numbers (qualified-but-not-joined wallets).
 * MOCKED for the MVP (score-api is not ours; #164/#221). Output feeds the pure
 * `diff` as `latentCounts` data.
 */
export class ScoreSource extends Context.Tag('shadow/ScoreSource')<
  ScoreSource,
  {
    readonly latentQualified: (
      world: WorldSlug,
      rule: RoleRule,
    ) => Effect.Effect<number, ScoreError>;
  }
>() {}
