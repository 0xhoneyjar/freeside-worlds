/**
 * tests/helpers/batch.ts — builders for `WriteOp` / `WriteIntentBatch` /
 * `AuthzContext` and the (internal) `WriteCapability` mint, for the §8.4 proofs.
 *
 * `op_id` is STABLE (deterministic from {kind, role_key, member_id}) and
 * `idempotency_key = sha256(JCS({world, op_id, report_hash}))` — exactly the
 * §4.4.1 contract, computed via the events JCS+sha256 (the same primitives the
 * substrate uses) so the keys are real, not stubbed.
 *
 * `mintWriteCapability` is imported from its INTERNAL module path (tests live
 * in-package); the package barrel deliberately does not export it. That import
 * is the test's stand-in for the authorized go_live mint.
 */
import { jcsCanonicalize, sha256Hex } from '@0xhoneyjar/events';
import { mintWriteCapability } from '../../src/effectful/write-capability.js';
import type {
  AuthzContext,
  Hex64,
  RosterVersion,
  WorldSlug,
  WriteCapability,
  WriteIntentBatch,
  WriteOp,
} from '../../src/types.js';

export const TEST_WORLD = 'purupuru' as WorldSlug;
export const HASH_A = 'a'.repeat(64) as Hex64;
export const HASH_B = 'b'.repeat(64) as Hex64;

/** Deterministic op_id from {kind, role_key, member_id}. */
export function opId(kind: WriteOp['kind'], role_key: string, member_id?: string): string {
  return `${kind}:${role_key}${member_id ? `:${member_id}` : ''}`;
}

/** idempotency_key = sha256(JCS({world, op_id, report_hash})). */
export function idemKey(world: WorldSlug, op_id: string, report_hash: Hex64): Hex64 {
  return sha256Hex(jcsCanonicalize({ world, op_id, report_hash })) as Hex64;
}

export function createOp(role_key: string, report_hash: Hex64 = HASH_A): WriteOp {
  const op_id = opId('create_role', role_key);
  return {
    op_id,
    idempotency_key: idemKey(TEST_WORLD, op_id, report_hash),
    kind: 'create_role',
    intent: { role_key, display_name: role_key },
  };
}

export function assignOp(role_key: string, member_id: string, report_hash: Hex64 = HASH_A): WriteOp {
  const op_id = opId('assign_role', role_key, member_id);
  return {
    op_id,
    idempotency_key: idemKey(TEST_WORLD, op_id, report_hash),
    kind: 'assign_role',
    intent: { role_key, member_id: member_id as never },
  };
}

/** cycle-010 FR-11: an assign op carrying the OPTIONAL frozen role_id. */
export function assignOpWithRoleId(
  role_key: string,
  member_id: string,
  role_id: string,
  report_hash: Hex64 = HASH_A,
): WriteOp {
  const op_id = opId('assign_role', role_key, member_id);
  return {
    op_id,
    idempotency_key: idemKey(TEST_WORLD, op_id, report_hash),
    kind: 'assign_role',
    intent: { role_key, member_id: member_id as never, role_id: role_id as never },
  };
}

/** cycle-010 FR-9: a revoke op (role_key, role_id, member_id). */
export function revokeOp(
  role_key: string,
  role_id: string,
  member_id: string,
  report_hash: Hex64 = HASH_A,
): WriteOp {
  const op_id = opId('revoke_role', role_key, member_id);
  return {
    op_id,
    idempotency_key: idemKey(TEST_WORLD, op_id, report_hash),
    kind: 'revoke_role',
    intent: { role_key, role_id: role_id as never, member_id: member_id as never },
  };
}

/** cycle-010 FR-10: a rename op (role_key, role_id, new_display_name). */
export function renameOp(
  role_key: string,
  role_id: string,
  new_display_name: string,
  report_hash: Hex64 = HASH_A,
): WriteOp {
  const op_id = opId('rename_role', role_key);
  return {
    op_id,
    idempotency_key: idemKey(TEST_WORLD, op_id, report_hash),
    kind: 'rename_role',
    intent: { role_key, role_id: role_id as never, new_display_name },
  };
}

const ROSTER_VERSION: RosterVersion = {
  fingerprint: 'f'.repeat(64) as Hex64,
  fetched_at: '2026-06-05T00:00:00.000Z',
  member_count: 10,
};

export function authzContext(over: Partial<AuthzContext> = {}): AuthzContext {
  return {
    actor: 'cm-actor-1',
    world: TEST_WORLD,
    report_hash: HASH_A,
    token_metadata: { kid: 'svc-1', verified_at: '2026-06-05T00:00:00.000Z', exp: '2026-06-05T01:00:00.000Z' },
    transition_version: 1,
    authz_decision_id: 'authz-decision-test-1',
    roster_version: ROSTER_VERSION,
    ...over,
  };
}

export function batch(over: Partial<WriteIntentBatch> = {}): WriteIntentBatch {
  const report_hash = over.report_hash ?? HASH_A;
  return {
    world: TEST_WORLD,
    report_hash,
    authz: authzContext({ report_hash }),
    ops: [createOp('purupuru:holder', report_hash), assignOp('purupuru:holder', 'member-1', report_hash)],
    max_concurrent: 4,
    ...over,
  };
}

/** Mint a capability bound to a batch's report_hash + authz_decision_id (the authorized go_live mint stand-in). */
export function capabilityFor(b: WriteIntentBatch): WriteCapability {
  return mintWriteCapability({
    report_hash: b.report_hash,
    transition_version: b.authz.transition_version,
    authz_decision_id: b.authz.authz_decision_id,
  });
}

/** Mint a capability with explicit fields (for forging mismatches in counterexamples). */
export function mintCap(report_hash: Hex64, transition_version: number, authz_decision_id: string): WriteCapability {
  return mintWriteCapability({ report_hash, transition_version, authz_decision_id });
}
