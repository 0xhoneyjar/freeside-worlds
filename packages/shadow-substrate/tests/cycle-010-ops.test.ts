/**
 * cycle-010-ops.test.ts — the cycle-010 "Roles-as-Code" ADDITIVE substrate ops
 * (SDD §3 substrate sub-track). Each test pins ONE of the six additive changes;
 * all assert that the addition does NOT break the sealed write-path invariants
 * (the gate is still the only write path; SHADOW ⇒ zero writes still holds for
 * the new ops too).
 *
 *   FR-9  RevokeRoleIntent  — WriteOp union + gate revoke dispatch + revokeRole port
 *   FR-10 RenameRoleIntent  — WriteOp union + gate rename dispatch + renameRole port
 *   FR-11 role_id? on AssignRoleIntent — optional, threaded through the gate
 *   FR-2  display_name on CreateRoleIntent / RoleRule (distinct from role_key)
 *   FR-3  owner on RoleRule (defaulted at the consumer so existing maps validate)
 *   FR-12 RosterSource.currentRosterIdentity — the {member_ids, role_ids} snapshot
 *
 * Style mirrors gate-checked-writer.test.ts + schemas.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { Schema as S } from '@effect/schema';
import { Effect, Exit, Layer, Cause } from 'effect';
import {
  AssignRoleIntent,
  RevokeRoleIntent,
  RenameRoleIntent,
  CreateRoleIntent,
  WriteOp,
  WriteOpKind,
} from '../src/types.js';
import { RoleRule, RoleOwner, roleOwnerOf } from '../src/schemas/config-surfaces.js';
import { RosterSource, RoleWriter } from '../src/ports/index.js';
import {
  makeGateCheckedRoleWriter,
  GateCheckedRoleWriter,
} from '../src/effectful/gate-checked-role-writer.js';
import { makeModeControl } from '../src/effectful/mode-control.js';
import { makeRecordingEmitter } from '../src/effectful/acvp-emitter.mock.js';
import { makeInMemoryWorldLock } from '../src/effectful/world-lock.mock.js';
import { makeInMemoryAllowlist } from '../src/effectful/resolve-authz.mock.js';
import { makeRecordingRoleWriter } from './helpers/mock-role-writer.js';
import {
  batch,
  capabilityFor,
  revokeOp,
  renameOp,
  assignOpWithRoleId,
  HASH_A,
  TEST_WORLD,
} from './helpers/batch.js';
import { ShadowGateRejected } from '../src/errors.js';
import { SHADOW_ROLE_REJECTED, SHADOW_ROLE_APPLIED } from '../src/events/shadow-events.js';

const BATCH_ACTOR = 'cm-actor-1';

/** Build the full gate environment (mirrors gate-checked-writer.test.ts harness). */
function harness(initialMode: 'SHADOW' | 'LIVE') {
  const { layer: writerLayer, recorder: writerRec } = makeRecordingRoleWriter();
  const { layer: emitterLayer, recorder: emitterRec } = makeRecordingEmitter();
  const lockLayer = makeInMemoryWorldLock();
  const { layer: allowlistLayer } = makeInMemoryAllowlist({ [TEST_WORLD]: [BATCH_ACTOR] });

  const program = Effect.gen(function* () {
    const mode = yield* makeModeControl(initialMode);
    const base = Layer.mergeAll(writerLayer, emitterLayer, lockLayer, allowlistLayer);
    const gateLayer = makeGateCheckedRoleWriter(mode, () => HASH_A);
    const env = Layer.provideMerge(gateLayer, base);
    return { env };
  });

  return { program, writerRec, emitterRec };
}

// ─── FR-9/10/11: the new intent SHAPES decode (additive union members) ───────

describe('cycle-010 intent schemas (FR-9/FR-10/FR-11)', () => {
  test('FR-9 RevokeRoleIntent decodes {role_key, role_id, member_id}', () => {
    expect(() =>
      S.decodeUnknownSync(RevokeRoleIntent)({
        role_key: 'purupuru:holder',
        role_id: 'role-123',
        member_id: 'member-9',
      }),
    ).not.toThrow();
  });

  test('FR-10 RenameRoleIntent decodes {role_key, role_id, new_display_name}', () => {
    expect(() =>
      S.decodeUnknownSync(RenameRoleIntent)({
        role_key: 'purupuru:holder',
        role_id: 'role-123',
        new_display_name: '_archived_2026_holder',
      }),
    ).not.toThrow();
  });

  test('FR-11 AssignRoleIntent decodes WITHOUT role_id (existing callers unbroken)', () => {
    // additivity: the pre-cycle-010 shape (no role_id) must still decode.
    expect(() =>
      S.decodeUnknownSync(AssignRoleIntent)({ role_key: 'purupuru:holder', member_id: 'm1' }),
    ).not.toThrow();
  });

  test('FR-11 AssignRoleIntent ALSO decodes WITH the optional role_id', () => {
    const decoded = S.decodeUnknownSync(AssignRoleIntent)({
      role_key: 'purupuru:holder',
      member_id: 'm1',
      role_id: 'role-123',
    });
    expect(decoded.role_id).toBe('role-123' as never);
  });

  test('WriteOpKind is the WIDENED literal set (create/assign/revoke/rename)', () => {
    for (const k of ['create_role', 'assign_role', 'revoke_role', 'rename_role']) {
      expect(() => S.decodeUnknownSync(WriteOpKind)(k)).not.toThrow();
    }
    expect(() => S.decodeUnknownSync(WriteOpKind)('teleport_role')).toThrow();
  });

  test('WriteOp union accepts a revoke op and a rename op', () => {
    expect(() => S.decodeUnknownSync(WriteOp)(revokeOp('purupuru:holder', 'role-1', 'm1'))).not.toThrow();
    expect(() => S.decodeUnknownSync(WriteOp)(renameOp('purupuru:holder', 'role-1', 'Archived'))).not.toThrow();
  });

  test('WriteOp REJECTS a kind/intent mismatch at decode (discriminated union — /fagan fix)', () => {
    // The bug the discriminated union closes: `kind:'rename_role'` carrying an
    // AssignRoleIntent-shaped intent (missing role_id + new_display_name) used to
    // decode independently, then runOp dispatched it as a malformed rename. The
    // discriminated union pins each kind to ONLY its intent, so this is rejected
    // at the schema boundary, BEFORE the gate ever sees it.
    const mismatched = {
      op_id: 'rename_role:purupuru:holder',
      idempotency_key: 'a'.repeat(64),
      kind: 'rename_role',
      intent: { role_key: 'purupuru:holder', member_id: 'm1' }, // AssignRoleIntent shape
    };
    expect(() => S.decodeUnknownSync(WriteOp)(mismatched)).toThrow();

    // Symmetric: `kind:'assign_role'` carrying a RenameRoleIntent-shaped intent
    // (no member_id; has new_display_name) is ALSO rejected.
    const mismatched2 = {
      op_id: 'assign_role:purupuru:holder',
      idempotency_key: 'b'.repeat(64),
      kind: 'assign_role',
      intent: { role_key: 'purupuru:holder', role_id: 'role-1', new_display_name: 'X' }, // RenameRoleIntent shape
    };
    expect(() => S.decodeUnknownSync(WriteOp)(mismatched2)).toThrow();
  });

  test('WriteOp STILL decodes valid create + assign ops (additivity preserved)', () => {
    const createOp = {
      op_id: 'create_role:purupuru:holder',
      idempotency_key: 'c'.repeat(64),
      kind: 'create_role',
      intent: { role_key: 'purupuru:holder', display_name: 'Holder' },
    };
    const assignOp = {
      op_id: 'assign_role:purupuru:holder:m1',
      idempotency_key: 'd'.repeat(64),
      kind: 'assign_role',
      intent: { role_key: 'purupuru:holder', member_id: 'm1' }, // no role_id — pre-cycle-010 shape
    };
    expect(() => S.decodeUnknownSync(WriteOp)(createOp)).not.toThrow();
    expect(() => S.decodeUnknownSync(WriteOp)(assignOp)).not.toThrow();
  });

  test('CreateRoleIntent carries display_name distinct from role_key (FR-2)', () => {
    const decoded = S.decodeUnknownSync(CreateRoleIntent)({
      role_key: 'purupuru:sovereign',
      display_name: 'Sovereign',
    });
    expect(decoded.role_key).not.toBe(decoded.display_name);
  });
});

// ─── FR-2/FR-3: RoleRule display_name + owner (additive, defaulted) ──────────

describe('cycle-010 RoleRule.owner + display_name (FR-2/FR-3)', () => {
  const baseRule = {
    role_key: 'purupuru:holder',
    display_name: 'Holder',
    qualifies: { source: 'tier', min_tier: 'tier-1' },
    create_if_absent: true,
  };

  test('FR-3 a role-map authored WITHOUT owner still decodes (additivity)', () => {
    expect(() => S.decodeUnknownSync(RoleRule)(baseRule)).not.toThrow();
  });

  test('FR-3 owner accepts manual and freeside, rejects anything else', () => {
    expect(() => S.decodeUnknownSync(RoleRule)({ ...baseRule, owner: 'manual' })).not.toThrow();
    expect(() => S.decodeUnknownSync(RoleRule)({ ...baseRule, owner: 'freeside' })).not.toThrow();
    expect(() => S.decodeUnknownSync(RoleRule)({ ...baseRule, owner: 'yolo' })).toThrow();
    expect(() => S.decodeUnknownSync(RoleOwner)('manual')).not.toThrow();
  });

  test('FR-3 roleOwnerOf defaults absent owner to manual; honors explicit', () => {
    expect(roleOwnerOf({})).toBe('manual');
    expect(roleOwnerOf({ owner: 'manual' })).toBe('manual');
    expect(roleOwnerOf({ owner: 'freeside' })).toBe('freeside');
  });

  test('FR-2 display_name is distinct from role_key on the rule', () => {
    const decoded = S.decodeUnknownSync(RoleRule)({ ...baseRule, role_key: 'k', display_name: 'Pretty Name' });
    expect(decoded.role_key).not.toBe(decoded.display_name);
  });
});

// ─── FR-9/FR-10: the gate DISPATCHES revoke/rename through the only write path ─

describe('cycle-010 gate dispatch — revoke (FR-9) + rename (FR-10)', () => {
  test('LIVE ⇒ a revoke op calls inner.revokeRole exactly once + emits applied', async () => {
    const { program, writerRec, emitterRec } = harness('LIVE');
    const b = batch({ ops: [revokeOp('purupuru:holder', 'role-1', 'member-9')] });
    const cap = capabilityFor(b);

    const result = await Effect.runPromise(
      program.pipe(
        Effect.flatMap(({ env }) =>
          Effect.gen(function* () {
            const gate = yield* GateCheckedRoleWriter;
            return yield* gate.applyBatch(b, cap);
          }).pipe(Effect.provide(env)),
        ),
      ),
    );

    expect(result.status).toBe('done');
    expect(writerRec.revokeCountFor('purupuru:holder', 'member-9')).toBe(1);
    // no spurious create/assign/rename.
    expect(writerRec.creates.length).toBe(0);
    expect(writerRec.assigns.length).toBe(0);
    expect(writerRec.renames.length).toBe(0);
    expect(emitterRec.countOf(SHADOW_ROLE_APPLIED)).toBe(1);
  });

  test('LIVE ⇒ a rename op calls inner.renameRole exactly once', async () => {
    const { program, writerRec } = harness('LIVE');
    const b = batch({ ops: [renameOp('purupuru:holder', 'role-1', '_archived_holder')] });
    const cap = capabilityFor(b);

    const result = await Effect.runPromise(
      program.pipe(
        Effect.flatMap(({ env }) =>
          Effect.gen(function* () {
            const gate = yield* GateCheckedRoleWriter;
            return yield* gate.applyBatch(b, cap);
          }).pipe(Effect.provide(env)),
        ),
      ),
    );

    expect(result.status).toBe('done');
    expect(writerRec.renameCountFor('purupuru:holder')).toBe(1);
    expect(writerRec.renames[0]!.new_display_name).toBe('_archived_holder');
  });

  test('SHADOW ⇒ revoke + rename ops are REJECTED with ZERO inner writes (sealed gate)', async () => {
    // The sealed invariant generalizes to the new ops: under SHADOW the gate
    // confirms a rejection per attempted op and the inner writer is never called.
    const { program, writerRec, emitterRec } = harness('SHADOW');
    const b = batch({
      ops: [revokeOp('purupuru:holder', 'role-1', 'm1'), renameOp('purupuru:holder', 'role-1', 'X')],
    });
    const cap = capabilityFor(b);

    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.flatMap(({ env }) =>
          Effect.gen(function* () {
            const gate = yield* GateCheckedRoleWriter;
            return yield* gate.applyBatch(b, cap);
          }).pipe(Effect.provide(env)),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect((err as { value: unknown }).value).toBeInstanceOf(ShadowGateRejected);
    }
    expect(writerRec.invocationCount()).toBe(0);
    expect(emitterRec.countOf(SHADOW_ROLE_REJECTED)).toBe(2);
  });
});

// ─── FR-11: the optional role_id is threaded verbatim to the inner assign ────

describe('cycle-010 gate dispatch — role_id threaded through assign (FR-11)', () => {
  test('LIVE ⇒ an assign op carrying role_id reaches the inner adapter unchanged', async () => {
    // The substrate gate does NOT interpret role_id — it passes the WHOLE intent
    // to inner.assignRole. We assert the inner adapter SAW the optional role_id
    // (the cross-batch re-verify hook the live adapter consumes downstream).
    let seenRoleId: string | undefined = 'UNSET';
    const innerLayer = Layer.succeed(RoleWriter, {
      createRole: () => Effect.die('create unused in this test'),
      assignRole: (_cap, intent) =>
        Effect.sync(() => {
          seenRoleId = (intent as { role_id?: string }).role_id;
        }),
      revokeRole: () => Effect.void,
      renameRole: () => Effect.void,
    });
    const { layer: emitterLayer } = makeRecordingEmitter();
    const lockLayer = makeInMemoryWorldLock();
    const { layer: allowlistLayer } = makeInMemoryAllowlist({ [TEST_WORLD]: [BATCH_ACTOR] });

    const b = batch({ ops: [assignOpWithRoleId('purupuru:holder', 'm1', 'role-frozen-42')] });
    const cap = capabilityFor(b);

    const program = Effect.gen(function* () {
      const mode = yield* makeModeControl('LIVE');
      const base = Layer.mergeAll(innerLayer, emitterLayer, lockLayer, allowlistLayer);
      const gateLayer = makeGateCheckedRoleWriter(mode, () => HASH_A);
      return Layer.provideMerge(gateLayer, base);
    });

    const result = await Effect.runPromise(
      program.pipe(
        Effect.flatMap((env) =>
          Effect.gen(function* () {
            const gate = yield* GateCheckedRoleWriter;
            return yield* gate.applyBatch(b, cap);
          }).pipe(Effect.provide(env)),
        ),
      ),
    );

    expect(result.status).toBe('done');
    expect(seenRoleId).toBe('role-frozen-42');
  });
});

// ─── FR-12: RosterSource.currentRosterIdentity port method ──────────────────

describe('cycle-010 RosterSource.currentRosterIdentity (FR-12, bd-glb)', () => {
  test('the port exposes currentRosterIdentity returning {member_ids, role_ids}', async () => {
    const snapshot = { member_ids: ['m1', 'm2'], role_ids: ['r1'] };
    const rosterLayer = Layer.succeed(RosterSource, {
      currentRoster: () => Effect.die('unused'),
      currentRosterIdentity: () => Effect.succeed(snapshot),
    });

    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const src = yield* RosterSource;
        return yield* src.currentRosterIdentity(TEST_WORLD);
      }).pipe(Effect.provide(rosterLayer)),
    );

    expect(out).toEqual(snapshot);
    expect(out.member_ids).toEqual(['m1', 'm2']);
    expect(out.role_ids).toEqual(['r1']);
  });
});
