/**
 * audit-under-failure.test.ts — §8.4 PROOF 3 (audit-before-write under NATS
 * failure, CLUSTER 4 / SKP-005, task 402.8).
 *
 * Inject an `AcvpEmitter` whose `shadow.role.intent.v1` confirm FAILS (NATS
 * unavailable). Under LIVE, the gate emits + CONFIRMS the intent BEFORE the
 * inner write — so a failed confirm MUST:
 *   (a) invoke the inner writer ZERO times, AND
 *   (b) fail the batch with `WriteError("audit_unavailable")`.
 * There is no un-audited LIVE write.
 */
import { describe, expect, test } from 'bun:test';
import { Effect, Exit, Cause } from 'effect';
import { makeHarness } from './helpers/harness.js';
import { batch, capabilityFor, HASH_A } from './helpers/batch.js';
import { SHADOW_ROLE_INTENT } from '../src/events/shadow-events.js';
import { WriteError } from '../src/errors.js';

describe('§8.4 PROOF 3 — audit-before-write under NATS failure', () => {
  test('intent-emit failure ⇒ ZERO inner writes + WriteError("audit_unavailable")', async () => {
    const b = batch({ report_hash: HASH_A });
    const cap = capabilityFor(b);

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const h = yield* makeHarness({
          initialMode: 'LIVE',
          currentMapHash: HASH_A,
          // FAIL the intent emit (NATS down). Rejections/applied/transitioned ok.
          emitter: { failOn: (e) => e.event_type === SHADOW_ROLE_INTENT },
        });
        const result = yield* h.applyBatch(b, cap).pipe(
          Effect.map((r) => ({ r, writes: h.writerRec.invocationCount() })),
          Effect.mapError((e) => ({ e, writes: h.writerRec.invocationCount() })),
        );
        return result;
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe('Some');
      const payload = (failure as { value: { e: WriteError; writes: number } }).value;
      expect(payload.e).toBeInstanceOf(WriteError);
      expect(payload.e.kind).toBe('audit_unavailable');
      // (a) ZERO inner writes — the write never ran.
      expect(payload.writes).toBe(0);
    }
  });

  test('rejection-emit failure under SHADOW ⇒ ZERO writes + audit_unavailable (the rejection itself must be auditable)', async () => {
    // Symmetry: a SHADOW rejection is CONFIRMED before it returns. If even the
    // rejection cannot be audited, the gate fails loud (audit_unavailable) — it
    // never silently swallows the attempt — and still writes nothing.
    const b = batch({ report_hash: HASH_A, ops: [batch().ops[0]!] });
    const cap = capabilityFor(b);

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const h = yield* makeHarness({
          initialMode: 'SHADOW',
          emitter: { failOn: () => true }, // every confirm fails
        });
        return yield* h.applyBatch(b, cap).pipe(
          Effect.mapError((e) => ({ e, writes: h.writerRec.invocationCount() })),
        );
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const payload = (Cause.failureOption(exit.cause) as {
        value: { e: WriteError; writes: number };
      }).value;
      expect(payload.e).toBeInstanceOf(WriteError);
      expect(payload.e.kind).toBe('audit_unavailable');
      expect(payload.writes).toBe(0);
    }
  });
});
