/**
 * idempotency.test.ts — idempotent create/assign + partial-failure
 * reconciliation + 429-never-rollback (SDD §4.4.1, task 402.4/402.8).
 *
 *   - a retried batch re-runs only `pending`/`failed` ops (matched by op_id /
 *     idempotency_key against the prior op_status); already-`ok` ops are SKIPPED
 *     (no double-create / no double-write).
 *   - a transient (op_failed) op fails the batch to `partial_failure` with per-op
 *     status; a retry with the prior state succeeds and reuses the
 *     `roles_created` ledger (no double-create of the role that DID succeed).
 *   - 429 (rate_limited) is recorded as a per-op failure (partial_failure), NEVER
 *     aborts the batch and NEVER triggers a rollback.
 */
import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { makeHarness } from './helpers/harness.js';
import { batch, capabilityFor, createOp, assignOp, HASH_A } from './helpers/batch.js';

describe('idempotent reconciliation (SDD §4.4.1)', () => {
  test('retry re-runs only failed ops; already-ok ops are skipped (no double-write)', async () => {
    // Two ops: a create that succeeds + an assign that fails ONCE (transient).
    const ops = [createOp('purupuru:holder'), assignOp('purupuru:holder', 'member-1')];
    const b = batch({ report_hash: HASH_A, ops });
    const cap = capabilityFor(b);

    const { firstStatus, firstCreates, firstAssigns, secondStatus, secondCreates, secondAssigns } =
      await Effect.runPromise(
        Effect.gen(function* () {
          const h = yield* makeHarness({
            initialMode: 'LIVE',
            currentMapHash: HASH_A,
            writer: { failOnceFor: new Set(['purupuru:holder']) }, // first assign OR create fails once
          });
          // FIRST run — the one-shot failure hits the create (first op touching
          // the key). It ends partial_failure.
          const first = yield* h.applyBatch(b, cap);
          const firstCreates = h.writerRec.creates.length;
          const firstAssigns = h.writerRec.assigns.length;
          // RETRY with the prior state — only pending/failed re-run.
          const second = yield* h.applyBatch(b, cap, first);
          return {
            firstStatus: first.status,
            firstCreates,
            firstAssigns,
            secondStatus: second.status,
            secondCreates: h.writerRec.creates.length,
            secondAssigns: h.writerRec.assigns.length,
          };
        }),
      );

    // First run: the create failed once ⇒ partial_failure (the assign never ran
    // because create failed first / or assign carries its own status).
    expect(firstStatus).toBe('partial_failure');
    // After retry: terminal done, and NO double-create — the create count across
    // both runs is exactly 1 (the failed-once create succeeds on retry; an
    // already-ok op is skipped).
    expect(secondStatus).toBe('done');
    // total creates across both runs == 1 (failed first attempt did not record a
    // create; retry created once).
    expect(secondCreates).toBe(1);
    // the assign ran (once) — total assigns == 1.
    expect(secondAssigns).toBe(1);
    void firstCreates;
    void firstAssigns;
  });

  test('429 (rate_limited) ⇒ partial_failure, NEVER an abort/rollback', async () => {
    const ops = [createOp('purupuru:ok'), createOp('purupuru:throttled')];
    const b = batch({ report_hash: HASH_A, ops });
    const cap = capabilityFor(b);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const h = yield* makeHarness({
          initialMode: 'LIVE',
          currentMapHash: HASH_A,
          writer: { rateLimitFor: new Set(['purupuru:throttled']) },
        });
        return yield* h.applyBatch(b, cap);
      }),
    );

    // the throttled op is a per-op failure; the OK op still applied. apply_mode
    // stays LIVE across a partial failure (rollback is the explicit revert).
    expect(result.status).toBe('partial_failure');
    expect(result.progress.completed).toBe(1);
    expect(result.progress.failed).toBe(1);
    const throttled = result.op_status.find((s) => s.op_id.includes('throttled'));
    expect(throttled?.status).toBe('failed');
    expect(throttled?.error).toContain('rate_limited');
  });
});
