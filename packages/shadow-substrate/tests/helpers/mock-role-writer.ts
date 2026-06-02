/**
 * tests/helpers/mock-role-writer.ts — a recording `RoleWriter` Layer for the
 * §8.4 proofs. It is a stand-in for the actor's LIVE writer: it RECORDS every
 * invocation (so a test can assert the inner writer was invoked ZERO times under
 * SHADOW) and returns a deterministic role id per role_key (so check-then-create
 * + idempotency can be exercised).
 *
 * It also models the per-WORLD create race: a configurable per-role pre-create
 * delay lets the concurrency test (B10) interleave two batches so that WITHOUT
 * the world lock both would create the same role. The recorder counts CREATE
 * invocations per role_key — the B10 assertion is "exactly one create per key".
 */
import { Context, Effect, Layer } from 'effect';
import { RoleWriter } from '../../src/ports/index.js';
import { WriteError } from '../../src/errors.js';
import type { CreateRoleIntent, AssignRoleIntent, RoleId, WriteCapability } from '../../src/types.js';

export interface WriterRecorder {
  /** every createRole call, in order. */
  readonly creates: Array<{ role_key: string }>;
  /** every assignRole call, in order. */
  readonly assigns: Array<{ role_key: string; member_id: string }>;
  /** total inner-writer invocations (creates + assigns). */
  invocationCount(): number;
  createCountFor(role_key: string): number;
}

export interface MockWriterOptions {
  /**
   * Per-create artificial delay (ms) BEFORE the role id is returned — used by
   * the concurrency test to widen the check-then-create window. Default 0.
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
  // Track one-shot failures consumed.
  const failedOnce = new Set<string>();

  const recorder: WriterRecorder = {
    creates,
    assigns,
    invocationCount: () => creates.length + assigns.length,
    createCountFor: (role_key) => creates.filter((c) => c.role_key === role_key).length,
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
        if (opts.createDelayMs && opts.createDelayMs > 0) {
          yield* Effect.sleep(`${opts.createDelayMs} millis`);
        }
        // Record AFTER the delay so two interleaved creates both pass the
        // (un-locked) check window in the concurrency test if the lock were
        // absent. The recorder counts every actual create call.
        creates.push({ role_key: intent.role_key });
        return `role-${intent.role_key}` as RoleId;
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
  };

  return { layer: Layer.succeed(RoleWriter, service), recorder };
}
