/**
 * roster-freshness.test.ts — the B1 roster-freshness fingerprint + re-eval
 * (SDD §3.3/§6.2, task 402.9). The fingerprint + drift count are PURE.
 */
import { describe, expect, test } from 'bun:test';
import { Effect, Exit, Cause } from 'effect';
import {
  rosterFingerprint,
  newlyArrivedCount,
  evalRosterFreshness,
  ROSTER_DRIFT_THRESHOLD_DEFAULT,
} from '../src/effectful/roster-freshness.js';
import { GuardFailed } from '../src/errors.js';

const BASE = { member_ids: ['m1', 'm2', 'm3'], role_ids: ['r1', 'r2'] };

describe('rosterFingerprint (PURE, NON-timestamped)', () => {
  test('default threshold is 0 (any new qualifying member forces re-preview)', () => {
    expect(ROSTER_DRIFT_THRESHOLD_DEFAULT).toBe(0);
  });

  test('order- and duplicate-insensitive (coarse identity)', () => {
    const a = rosterFingerprint({ member_ids: ['m1', 'm2'], role_ids: ['r1'] });
    const b = rosterFingerprint({ member_ids: ['m2', 'm1', 'm1'], role_ids: ['r1'] });
    expect(a).toBe(b);
  });

  test('changes when the member set changes', () => {
    const a = rosterFingerprint(BASE);
    const b = rosterFingerprint({ ...BASE, member_ids: [...BASE.member_ids, 'm4'] });
    expect(a).not.toBe(b);
  });

  test('is a 64-char lowercase hex digest', () => {
    expect(rosterFingerprint(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('newlyArrivedCount (PURE)', () => {
  test('counts members in fresh but not in base', () => {
    const fresh = { member_ids: ['m1', 'm2', 'm3', 'm4', 'm5'], role_ids: ['r1', 'r2'] };
    expect(newlyArrivedCount(BASE, fresh)).toBe(2);
  });
  test('leaving members do not count as drift', () => {
    const fresh = { member_ids: ['m1'], role_ids: ['r1', 'r2'] };
    expect(newlyArrivedCount(BASE, fresh)).toBe(0);
  });
});

describe('evalRosterFreshness (B1 guard)', () => {
  const run = (e: ReturnType<typeof evalRosterFreshness>) => Effect.runSyncExit(e);

  test('unchanged fingerprint ⇒ no drift, succeeds', () => {
    const fp = rosterFingerprint(BASE);
    const exit = run(
      evalRosterFreshness({ baseFingerprint: fp, baseSnapshot: BASE, freshSnapshot: BASE }),
    );
    expect(exit).toEqual(Exit.void);
  });

  test('drift > threshold(0) ⇒ GuardFailed("roster_drift")', () => {
    const fp = rosterFingerprint(BASE);
    const fresh = { ...BASE, member_ids: [...BASE.member_ids, 'm4'] };
    const exit = run(
      evalRosterFreshness({ baseFingerprint: fp, baseSnapshot: BASE, freshSnapshot: fresh }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const e = (Cause.failureOption(exit.cause) as { value: GuardFailed }).value;
      expect(e.reason).toBe('roster_drift');
    }
  });

  test('drift within tunable threshold ⇒ succeeds', () => {
    const fp = rosterFingerprint(BASE);
    const fresh = { ...BASE, member_ids: [...BASE.member_ids, 'm4'] };
    const exit = run(
      evalRosterFreshness({
        baseFingerprint: fp,
        baseSnapshot: BASE,
        freshSnapshot: fresh,
        threshold: 1,
      }),
    );
    expect(exit).toEqual(Exit.void);
  });

  test('roster_drift is DISTINCT from stale_report (never flaps the rules hash)', () => {
    // a roster that drifted but the rules-hash is unchanged: the freshness guard
    // is the ONLY thing that fires — it is a separate check.
    const fp = rosterFingerprint(BASE);
    const fresh = { ...BASE, member_ids: [...BASE.member_ids, 'm4', 'm5'] };
    const exit = run(
      evalRosterFreshness({ baseFingerprint: fp, baseSnapshot: BASE, freshSnapshot: fresh }),
    );
    if (Exit.isFailure(exit)) {
      const e = (Cause.failureOption(exit.cause) as { value: GuardFailed }).value;
      expect(e.reason).not.toBe('stale_report');
      expect(e.reason).toBe('roster_drift');
    } else {
      throw new Error('expected roster_drift failure');
    }
  });
});
