/**
 * tests/helpers/mock-role-writer.ts — a recording `RoleWriter` Layer for the
 * §8.4 proofs. It is a stand-in for the actor's LIVE writer: it RECORDS every
 * invocation (so a test can assert the inner writer was invoked ZERO times under
 * SHADOW) and returns a deterministic role id per role_key.
 *
 * ── HONEST CHECK-THEN-CREATE against a SHARED roleset (B10 — FAGAN iter-2) ────
 * `createRole` faithfully models the Discord `GET roles → create-if-absent`
 * sequence: it reads a SHARED in-memory roleset (the stand-in for the live
 * guild), and:
 *   - if a role with `role_key` is ALREADY present → returns the existing id,
 *     records NO new create (idempotent reuse — the port contract);
 *   - else → creates: records the create AND adds the role to the shared set.
 * The `createDelayMs` delay sits BETWEEN the GET and the commit-to-shared-set, so
 * the check-then-create window is genuinely non-atomic: two CONCURRENT unlocked
 * creates for the same key both GET "absent" during the window and both commit →
 * TWO creates (the race the world-lock prevents). When the gate's world-lock
 * serializes the two spans, the second create GETs the first's role (already in
 * the shared set) and reuses it → ONE create. THIS is what proves the GATE
 * (world-lock × check-then-create) dedups across concurrent batches — with NO
 * external mutex and NO caller-threaded ledger.
 *
 * The recorder counts CREATE invocations per role_key — the B10 assertion is
 * "exactly one create per key".
 */
import { Context, Effect, Layer } from 'effect';
import { RoleWriter } from '../../src/ports/index.js';
import { WriteError } from '../../src/errors.js';
import type {
  CreateRoleIntent,
  AssignRoleIntent,
  RevokeRoleIntent,
  RenameRoleIntent,
  RoleId,
  WriteCapability,
} from '../../src/types.js';

export interface WriterRecorder {
  /** every ACTUAL createRole that produced a NEW role, in order (reuses excluded). */
  readonly creates: Array<{ role_key: string }>;
  /** every assignRole call, in order. */
  readonly assigns: Array<{ role_key: string; member_id: string }>;
  /** cycle-010 FR-9: every revokeRole call, in order. */
  readonly revokes: Array<{ role_key: string; role_id: string; member_id: string }>;
  /** cycle-010 FR-10: every renameRole call, in order. */
  readonly renames: Array<{ role_key: string; role_id: string; new_display_name: string }>;
  /** total inner-writer invocations that produced an effect (create+assign+revoke+rename). */
  invocationCount(): number;
  /** number of NEW roles created for a key (idempotent reuses do NOT count). */
  createCountFor(role_key: string): number;
  /** cycle-010: number of revoke calls for a (role_key, member_id) pair. */
  revokeCountFor(role_key: string, member_id: string): number;
  /** cycle-010: number of rename calls for a role_key. */
  renameCountFor(role_key: string): number;
}

export interface MockWriterOptions {
  /**
   * Per-create artificial delay (ms) injected BETWEEN the live GET and the
   * commit-to-shared-roleset — used by the concurrency test to widen the
   * check-then-create window so an UNLOCKED concurrent pair both observe the
   * role absent. Default 0.
   */
  readonly createDelayMs?: number;
  /**
   * role_keys whose FIRST create/assign should fail with op_failed (transient
   * model) — used by the partial-failure / reconciliation test. The failure is
   * one-shot per key: a retry succeeds.
   */
  readonly failOnceFor?: ReadonlySet<string>;
  /**
   * role_keys whose create/assign should fail with rate_limited (429) — used to
   * prove 429 is recorded as a per-op failure and never aborts the batch.
   */
  readonly rateLimitFor?: ReadonlySet<string>;
}

export function makeRecordingRoleWriter(opts: MockWriterOptions = {}): {
  readonly layer: Layer.Layer<RoleWriter>;
  readonly recorder: WriterRecorder;
} {
  const creates: Array<{ role_key: string }> = [];
  const assigns: Array<{ role_key: string; member_id: string }> = [];
  const revokes: Array<{ role_key: string; role_id: string; member_id: string }> = [];
  const renames: Array<{ role_key: string; role_id: string; new_display_name: string }> = [];
  // Track one-shot failures consumed.
  const failedOnce = new Set<string>();
  // The SHARED roleset — the stand-in for the live Discord guild roles. The
  // check-then-create reads + writes THIS map. It is shared across every
  // createRole invocation (i.e. across concurrent batches), exactly as the real
  // guild roleset is shared.
  const sharedRoles = new Map<string, RoleId>();

  const recorder: WriterRecorder = {
    creates,
    assigns,
    revokes,
    renames,
    invocationCount: () => creates.length + assigns.length + revokes.length + renames.length,
    createCountFor: (role_key) => creates.filter((c) => c.role_key === role_key).length,
    revokeCountFor: (role_key, member_id) =>
      revokes.filter((r) => r.role_key === role_key && r.member_id === member_id).length,
    renameCountFor: (role_key) => renames.filter((r) => r.role_key === role_key).length,
  };

  const service: Context.Tag.Service<RoleWriter> = {
    createRole: (_cap: WriteCapability, intent: CreateRoleIntent) =>
      Effect.gen(function* () {
        if (opts.rateLimitFor?.has(intent.role_key)) {
          return yield* Effect.fail(
            new WriteError({ kind: 'rate_limited', message: '429 from Discord' }),
          );
        }
        if (opts.failOnceFor?.has(intent.role_key) && !failedOnce.has(intent.role_key)) {
          failedOnce.add(intent.role_key);
          return yield* Effect.fail(
            new WriteError({ kind: 'op_failed', message: 'transient create failure' }),
          );
        }

        // CHECK: GET the live roleset. If the role already exists, REUSE it —
        // idempotent, no new create recorded (the port contract).
        const existing = sharedRoles.get(intent.role_key);
        if (existing !== undefined) {
          return existing;
        }

        // The non-atomic window: the delay sits BETWEEN the GET (above) and the
        // commit (below). Two unlocked concurrent creates both pass the GET as
        // "absent" during this window and both commit → 2 creates. The gate's
        // world-lock closes this window by serializing the whole span.
        if (opts.createDelayMs && opts.createDelayMs > 0) {
          yield* Effect.sleep(`${opts.createDelayMs} millis`);
        }

        // Re-check NOTHING here on purpose: a faithful single-GET-then-create
        // adapter does not re-read after deciding to create. CREATE: record the
        // new create + commit it to the shared roleset.
        const roleId = `role-${intent.role_key}` as RoleId;
        creates.push({ role_key: intent.role_key });
        sharedRoles.set(intent.role_key, roleId);
        return roleId;
      }),
    assignRole: (_cap: WriteCapability, intent: AssignRoleIntent) =>
      Effect.gen(function* () {
        if (opts.rateLimitFor?.has(intent.role_key)) {
          return yield* Effect.fail(
            new WriteError({ kind: 'rate_limited', message: '429 from Discord' }),
          );
        }
        if (opts.failOnceFor?.has(intent.role_key) && !failedOnce.has(intent.role_key)) {
          failedOnce.add(intent.role_key);
          return yield* Effect.fail(
            new WriteError({ kind: 'op_failed', message: 'transient assign failure' }),
          );
        }
        assigns.push({ role_key: intent.role_key, member_id: intent.member_id });
        return undefined;
      }),
    // cycle-010 FR-9: revoke ONE member from a role. Records + honors the same
    // one-shot / rate-limit injection so the partial-failure tests cover it too.
    revokeRole: (_cap: WriteCapability, intent: RevokeRoleIntent) =>
      Effect.gen(function* () {
        if (opts.rateLimitFor?.has(intent.role_key)) {
          return yield* Effect.fail(
            new WriteError({ kind: 'rate_limited', message: '429 from Discord' }),
          );
        }
        if (opts.failOnceFor?.has(intent.role_key) && !failedOnce.has(intent.role_key)) {
          failedOnce.add(intent.role_key);
          return yield* Effect.fail(
            new WriteError({ kind: 'op_failed', message: 'transient revoke failure' }),
          );
        }
        revokes.push({ role_key: intent.role_key, role_id: intent.role_id, member_id: intent.member_id });
        return undefined;
      }),
    // cycle-010 FR-10: archive-by-rename. Records + honors the same injection.
    renameRole: (_cap: WriteCapability, intent: RenameRoleIntent) =>
      Effect.gen(function* () {
        if (opts.rateLimitFor?.has(intent.role_key)) {
          return yield* Effect.fail(
            new WriteError({ kind: 'rate_limited', message: '429 from Discord' }),
          );
        }
        if (opts.failOnceFor?.has(intent.role_key) && !failedOnce.has(intent.role_key)) {
          failedOnce.add(intent.role_key);
          return yield* Effect.fail(
            new WriteError({ kind: 'op_failed', message: 'transient rename failure' }),
          );
        }
        renames.push({
          role_key: intent.role_key,
          role_id: intent.role_id,
          new_display_name: intent.new_display_name,
        });
        return undefined;
      }),
  };

  return { layer: Layer.succeed(RoleWriter, service), recorder };
}
