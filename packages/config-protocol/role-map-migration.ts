/**
 * role-map-migration.ts — cycle-010 (sprint T1.2 · FR-2/FR-3) role-map
 * additivity helpers.
 *
 * ── THE ADDITIVITY FACTS (verified, honest) ─────────────────────────────────
 * S2 made `RoleRule.owner` PLAIN-OPTIONAL (config-surfaces.ts §FR-3 comment), so
 * a role-map that carries `display_name` but NO `owner` decodes + round-trips
 * UNCHANGED — that is the genuine cycle-010 additivity (the consumer applies
 * `owner ?? 'manual'` via the substrate `roleOwnerOf`). The frozen
 * CANONICAL_VERSION_HASH is preserved because an absent `owner` is dropped by
 * JCS, so an un-`owner`'d map hashes identically.
 *
 * HOWEVER: `RoleRule.display_name` is REQUIRED in S2 (it is the FR-2 mutable
 * Discord name distinct from the stable `role_key`). A TRULY pre-S2 role-map
 * (authored before FR-2, with NO `display_name`) does NOT decode unchanged — the
 * sealed schema rejects the missing required field. That is the ONE field a
 * backfill is needed for. This module provides a PURE backfill that defaults
 * `display_name` from `role_key` (the safe, deterministic default: the role's
 * Discord name initialized to its stable key, which the CM then edits) so a
 * pre-S2 map can be migrated to a decodable shape with zero manual edits.
 *
 * `owner` is deliberately NOT backfilled here: leaving it ABSENT is correct
 * (the consumer's `manual` default applies AND the version hash stays frozen).
 * Writing an explicit `owner: 'manual'` would needlessly re-version the map.
 *
 * PURE: no I/O, no schema import — operates on a plain structural shape so it can
 * run over raw stored JSON before it is decoded.
 */

/** The minimal structural shape a backfill reasons over (pre-decode JSON). */
export interface RawRoleRule {
  role_key?: unknown;
  display_name?: unknown;
  owner?: unknown;
  [k: string]: unknown;
}

export interface RawRoleMap {
  rules?: unknown;
  [k: string]: unknown;
}

/**
 * Backfill `display_name` (default = `role_key`) on any rule missing it. PURE +
 * non-destructive: a rule that ALREADY has a `display_name` is returned
 * unchanged; `owner` is never added (absent-is-correct, hash-preserving). Returns
 * a NEW object (does not mutate the input). Rules without a string `role_key` are
 * passed through untouched (the schema will reject them — the backfill does not
 * invent a key).
 */
export function backfillRoleMapDisplayNames(map: RawRoleMap): RawRoleMap {
  const rules = Array.isArray(map.rules) ? map.rules : undefined;
  if (rules === undefined) return { ...map };
  const backfilled = rules.map((rule) => {
    if (rule === null || typeof rule !== 'object') return rule;
    const r = rule as RawRoleRule;
    const hasDisplayName = typeof r.display_name === 'string' && r.display_name.length > 0;
    if (hasDisplayName) return { ...r };
    if (typeof r.role_key !== 'string' || r.role_key.length === 0) return { ...r };
    return { ...r, display_name: r.role_key };
  });
  return { ...map, rules: backfilled };
}
