/**
 * roster-freshness.test.ts — the B1 roster-freshness fingerprint + re-eval
 * (SDD §3.3/§6.2, task 402.9). The fingerprint + drift count are PURE.
 */
import { describe, expect, test } from 'bun:test';
import { Effect, Exit, Cause } from 'effect';
import {
  rosterFingerprint,
  newlyArrivedCount,
  netRosterChangeCount,
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
  test('leaving members do not count as ARRIVALS (newlyArrivedCount is arrivals-only)', () => {
    const fresh = { member_ids: ['m1'], role_ids: ['r1', 'r2'] };
    expect(newlyArrivedCount(BASE, fresh)).toBe(0);
  });
});

describe('netRosterChangeCount (PURE — arrivals + departures + role-id churn, MAJOR-6)', () => {
  test('counts arrivals AND departures', () => {
    // base m1,m2,m3 ; fresh m1,m4 ⇒ departures {m2,m3} + arrivals {m4} = 3
    const fresh = { member_ids: ['m1', 'm4'], role_ids: ['r1', 'r2'] };
    expect(netRosterChangeCount(BASE, fresh)).toBe(3);
  });
  test('counts role-id changes (replacements)', () => {
    // base roles r1,r2 ; fresh roles r1,r3 ⇒ depart r2 + arrive r3 = 2
    const fresh = { member_ids: ['m1', 'm2', 'm3'], role_ids: ['r1', 'r3'] };
    expect(netRosterChangeCount(BASE, fresh)).toBe(2);
  });
  test('identical snapshot ⇒ 0', () => {
    expect(netRosterChangeCount(BASE, BASE)).toBe(0);
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

  test('MAJOR-6: DEPARTURES (zero new arrivals) at threshold 0 ⇒ GuardFailed("roster_drift")', () => {
    // base m1,m2,m3 ; fresh m1,m2 (m3 LEFT, NO new arrival). The old arrivals-
    // only count would be 0 and PASS — the fingerprint-mismatch path now catches
    // it at threshold 0 (any role-relevant change forces a re-preview).
    const fp = rosterFingerprint(BASE);
    const fresh = { ...BASE, member_ids: ['m1', 'm2'] };
    expect(newlyArrivedCount(BASE, fresh)).toBe(0); // arrivals-only would miss it
    const exit = run(
      evalRosterFreshness({ baseFingerprint: fp, baseSnapshot: BASE, freshSnapshot: fresh }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const e = (Cause.failureOption(exit.cause) as { value: GuardFailed }).value;
      expect(e.reason).toBe('roster_drift');
    }
  });

  test('MAJOR-6: ROLE-ID change / replacement (zero member arrivals) at threshold 0 ⇒ roster_drift', () => {
    // members unchanged; a role id was replaced (r2 → r3). Arrivals-only = 0.
    const fp = rosterFingerprint(BASE);
    const fresh = { member_ids: BASE.member_ids, role_ids: ['r1', 'r3'] };
    expect(newlyArrivedCount(BASE, fresh)).toBe(0);
    const exit = run(
      evalRosterFreshness({ baseFingerprint: fp, baseSnapshot: BASE, freshSnapshot: fresh }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const e = (Cause.failureOption(exit.cause) as { value: GuardFailed }).value;
      expect(e.reason).toBe('roster_drift');
    }
  });

  test('MAJOR-6: threshold > 0 counts NET change (a departure + an arrival = 2 > 1 ⇒ drift)', () => {
    // base m1,m2,m3 ; fresh m1,m2,m4 (m3 left, m4 joined) = net 2 changes.
    // threshold 1 allows ≤1 net change, so net 2 must fail.
    const fp = rosterFingerprint(BASE);
    const fresh = { ...BASE, member_ids: ['m1', 'm2', 'm4'] };
    const exit = run(
      evalRosterFreshness({
        baseFingerprint: fp,
        baseSnapshot: BASE,
        freshSnapshot: fresh,
        threshold: 1,
      }),
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
