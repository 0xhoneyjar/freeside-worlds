/**
 * conformance/fixture.ts — the SHARED CROSS-REPO CONFORMANCE FIXTURE (B7,
 * sprint task 401.8 / SDD §1.7.1).
 *
 * The substrate is the security boundary, consumed git-source/SHA-pinned by
 * THREE repos (worlds, characters, dashboard). If they pin DIFFERENT SHAs they
 * could silently disagree on the `roleMapVersionHash` algorithm or a schema
 * shape — a dangerous skew on the "SHADOW ⇒ zero writes" boundary. This fixture
 * is the single artifact all three consumers assert IDENTICAL:
 *
 *   1. CANONICAL_VERSION_HASH_INPUT → CANONICAL_VERSION_HASH (the frozen
 *      `roleMapVersionHash` of a canonical input). A SHA bump that changes the
 *      hash algorithm fails this assertion loud, before deploy.
 *   2. The FROZEN SHAPE of `Discrepancy`, `AuthzContext`, and `WriteCapability`
 *      (the keys + nesting each consumer must agree on).
 *
 * Consumers run `conformance/check.ts` (the worlds-api CI compat check). The
 * dashboard/characters CI checks (404/405) import THIS fixture from the
 * SHA-pinned substrate and run the same assertions. See
 * conformance/ROLLBACK.md for the SHA-bump rollback procedure.
 */
import type { RoleMapVersionInput } from '../src/pure/role-map-version-hash.js';

/**
 * The canonical `roleMapVersionHash` input. Frozen — do NOT mutate without a
 * deliberate SHA bump + the lockstep rollout in conformance/ROLLBACK.md.
 *
 * NOTE: the roster is structurally ABSENT (there is no roster field on
 * `RoleMapVersionInput`) — the hash covers ONLY the deterministic rule fields
 * (SDD §3.3). This input is the cross-producer determinism anchor.
 */
export const CANONICAL_VERSION_HASH_INPUT: RoleMapVersionInput = {
  role_rules: [
    {
      role_key: 'purupuru:holder',
      display_name: 'Purupuru Holder',
      qualifies: { source: 'tier', min_tier: 'tier-1' },
      create_if_absent: true,
    },
    {
      role_key: 'purupuru:whale',
      display_name: 'Purupuru Whale',
      qualifies: { source: 'tier', min_tier: 'tier-3' },
      create_if_absent: true,
    },
  ],
  scaffolding_config: { channels: [{ key: 'lounge', label: 'Holder Lounge' }] },
  world_config: {
    world_slug: 'purupuru',
    guild_id: '111122223333444455',
    namespace_prefix: 'purupuru:',
    // NOTE: an ARBITRARY frozen hash-input value (it happens to be the MST /
    // Mibera-VM address), NOT Purupuru's real on-chain contract. Changing it
    // would force a needless CANONICAL_VERSION_HASH re-freeze — leave it.
    nft_contracts: ['0x048327A187b944ddac61c6e202BfccD20d17c008'],
  },
};

/**
 * The FROZEN canonical hash of `CANONICAL_VERSION_HASH_INPUT`. Computed once via
 * `@0xhoneyjar/events` JCS+sha256 at substrate SHA
 * 68f5a89cb02c6b3ddf5ab14a1d65753bc02bd9fe. All three consumers MUST reproduce
 * this byte-for-byte. If a future substrate change alters the hash, this
 * constant MUST be re-frozen as part of a deliberate, lockstep SHA bump.
 */
export const CANONICAL_VERSION_HASH =
  'eda5e02d3a5a90befbfd3ab156a7e2614a2c1484a0700117a4f7f1108dd77415';

/**
 * The frozen SHAPE of the three boundary types (keys, in declared order, with
 * nested keys). Consumers assert their decoded/constructed objects carry
 * EXACTLY these keys — a schema-shape skew fails loud.
 */
export const FROZEN_SHAPES = {
  /** Discrepancy (SDD §6.4) — the lens read-model. */
  Discrepancy: {
    top_level: [
      'world',
      'role_map_hash',
      'before',
      'after',
      'preexisting',
      'latent_qualified',
      'role_count',
      'generated_at',
    ],
    before_role: ['role_key', 'members', 'managed'],
    after_role: ['role_key', 'members', 'managed', 'created'], // `created` optional
    preexisting_role: ['role_key', 'members', 'managed'],
    latent_qualified: ['role_key', 'count', 'source'],
    role_count: ['existing', 'to_create', 'projected_total', 'limit', 'exceeds'],
  },
  /** AuthzContext (SDD §6.2) — the write-batch authz binding. */
  AuthzContext: {
    top_level: [
      'actor',
      'world',
      'report_hash',
      'token_metadata',
      'transition_version',
      'authz_decision_id',
      'roster_version',
    ],
    token_metadata: ['kid', 'verified_at', 'exp'],
    roster_version: ['fingerprint', 'fetched_at', 'member_count'],
  },
  /** WriteCapability (SDD §4.4.4) — the COMPILE-TIME accident-prevention seam. */
  WriteCapability: {
    // The brand symbol is non-enumerable conceptually; the data keys consumers
    // bind against are these:
    data_keys: ['report_hash', 'transition_version', 'authz_decision_id'],
  },
} as const;
