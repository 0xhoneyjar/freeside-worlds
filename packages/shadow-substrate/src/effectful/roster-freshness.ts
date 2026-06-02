/**
 * effectful/roster-freshness.ts — the go_live roster-freshness re-eval (SDD
 * §3.3/§6.2/§4.1, task 402.9, B1).
 *
 * ── WHY THIS EXISTS (separate from the rules-hash guard) ─────────────────────
 * `roleMapVersionHash` DELIBERATELY excludes the roster so the FR-7 go_live
 * report-hash guard does not flap (§3.3). But that means the report-hash guard
 * does NOT catch ROSTER DRIFT: members joining/leaving between report-generation
 * and go_live (a CM previews, waits hours, clicks go-live). A blind apply against
 * a severely-drifted roster could execute unintended mass assignments. So go_live
 * performs a SEPARATE roster-freshness re-eval — `GuardFailed("roster_drift")`,
 * distinct from `GuardFailed("stale_report")`, never flapping the rules hash.
 *
 * ── THE FINGERPRINT (pure) ───────────────────────────────────────────────────
 * `rosterFingerprint = sha256(JCS(sorted(member_ids ⊕ role_ids)))` — NON-
 * timestamped, coarse. Computed at report-gen and carried in
 * `AuthzContext.roster_version.fingerprint`. At go_live the fresh roster's
 * fingerprint is recomputed and compared.
 *
 * NOTE (grounding): the §6.4 `CurrentRoster` render-model carries per-role
 * member COUNTS, not the member-id set. The fingerprint therefore operates on a
 * `RosterIdentitySnapshot` (the member-id ⊕ role-id sets) that the LIVE
 * `RosterSource` Layer produces alongside the render-model roster — the live
 * Discord read already has both. This keeps the fingerprint a coarse identity of
 * WHO is in the guild, exactly as B1 intends, without bloating the render-model.
 * The fingerprint + the drift count are PURE over these id sets; only the fresh
 * read at go_live is effectful.
 */
import { jcsCanonicalize, sha256Hex } from '@0xhoneyjar/events';
import { GuardFailed } from '../errors.js';
import type { Hex64 } from '../types.js';
import { Effect } from 'effect';

/**
 * The coarse identity snapshot the fingerprint covers — the member-id set ⊕ the
 * role-id set of the guild at a point in time. Produced by the LIVE
 * `RosterSource` (it already reads both); a MOCK supplies fixtures.
 */
export interface RosterIdentitySnapshot {
  readonly member_ids: ReadonlyArray<string>;
  readonly role_ids: ReadonlyArray<string>;
}

/** Default drift threshold (SDD §6.2): 0 ⇒ ANY new qualifying member forces re-preview. */
export const ROSTER_DRIFT_THRESHOLD_DEFAULT = 0;

/**
 * PURE. `sha256(JCS(sorted(member_ids ⊕ role_ids)))`. The union is sorted +
 * de-duplicated so order/duplication in the source read does not perturb it
 * (coarse, deterministic). Excludes timestamps + counts — it is a stable
 * identity of WHO is present, never a version-hash field.
 */
export function rosterFingerprint(snapshot: RosterIdentitySnapshot): Hex64 {
  const union = Array.from(
    new Set<string>([...snapshot.member_ids, ...snapshot.role_ids]),
  ).sort();
  return sha256Hex(jcsCanonicalize(union)) as Hex64;
}

/**
 * PURE. The count of newly-ARRIVED members (present in `fresh`, absent in
 * `base`). The B1 guard fires on NEWLY-QUALIFYING members; in the MVP the
 * qualification predicate is opaque (score-api owns it, #221), so the substrate
 * computes the conservative upper bound — newly-PRESENT members — which
 * over-approximates newly-qualifying. A consumer that can resolve per-member
 * qualification may pass a pre-filtered `fresh.member_ids` (only newly-
 * qualifying) to tighten it. NOTE: this counts ARRIVALS ONLY; for the drift
 * threshold the net role-relevant change (arrivals AND departures AND role-id
 * changes) is what matters — see `netRosterChangeCount` / `evalRosterFreshness`.
 */
export function newlyArrivedCount(
  base: RosterIdentitySnapshot,
  fresh: RosterIdentitySnapshot,
): number {
  const baseMembers = new Set(base.member_ids);
  let count = 0;
  for (const id of new Set(fresh.member_ids)) {
    if (!baseMembers.has(id)) count += 1;
  }
  return count;
}

/**
 * PURE. The NET role-relevant roster change between `base` and `fresh`: the
 * symmetric-difference of the member-id sets PLUS the symmetric-difference of
 * the role-id sets. This counts ARRIVALS, DEPARTURES, AND role-id changes
 * (replacements) — NOT arrivals alone. It is the threshold>0 drift metric (the
 * threshold=0 path short-circuits on any fingerprint mismatch and never reaches
 * this). Counting departures/role-changes closes the B1 hole where a roster that
 * drifted via departures or role-id churn (zero new arrivals) would have passed
 * the old arrivals-only count.
 */
export function netRosterChangeCount(
  base: RosterIdentitySnapshot,
  fresh: RosterIdentitySnapshot,
): number {
  const symDiff = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): number => {
    const setA = new Set(a);
    const setB = new Set(b);
    let n = 0;
    for (const id of setA) if (!setB.has(id)) n += 1; // departures
    for (const id of setB) if (!setA.has(id)) n += 1; // arrivals
    return n;
  };
  return symDiff(base.member_ids, fresh.member_ids) + symDiff(base.role_ids, fresh.role_ids);
}

export interface RosterFreshnessInput {
  /** the fingerprint frozen in `AuthzContext.roster_version` at report-gen. */
  readonly baseFingerprint: Hex64;
  /** the id snapshot the base fingerprint was computed from (for delta). */
  readonly baseSnapshot: RosterIdentitySnapshot;
  /** the freshly re-loaded roster id snapshot at go_live. */
  readonly freshSnapshot: RosterIdentitySnapshot;
  /** operator-tunable; default 0 (§6.2). */
  readonly threshold?: number;
}

/**
 * PURE roster-freshness re-evaluation (B1). Returns an `Effect` over the typed
 * `GuardFailed("roster_drift")` channel so it composes with `transition` and the
 * gated writer. Semantics, by threshold:
 *
 *   - **threshold = 0 (the conservative MVP default, §6.2):** ANY fingerprint
 *     mismatch between the base and the fresh roster forces a re-preview. The
 *     fingerprint covers `member_ids ⊕ role_ids`, so a roster that changed via
 *     DEPARTURES, role-id changes, or replacements (even with ZERO new arrivals)
 *     produces a mismatched fingerprint and `GuardFailed("roster_drift")`. This
 *     closes the FAGAN iter-2 MAJOR-6 hole: keying drift off newly-arrived
 *     members alone let departures/replacements slip past at threshold 0.
 *   - **threshold > 0 (operator-tunable):** compute the NET role-relevant change
 *     (arrivals AND departures AND role-id changes, `netRosterChangeCount`) and
 *     fail iff it exceeds the threshold; a drift within threshold is allowed.
 *
 * If the fingerprint MATCHES, there is no drift regardless of threshold.
 *
 * This is a go_live-time re-eval, NOT a version-hash field: it never flaps a
 * stored hash and never blocks bind_map/preview.
 */
export function evalRosterFreshness(
  input: RosterFreshnessInput,
): Effect.Effect<void, GuardFailed> {
  const threshold = input.threshold ?? ROSTER_DRIFT_THRESHOLD_DEFAULT;
  const freshFingerprint = rosterFingerprint(input.freshSnapshot);
  if (freshFingerprint === input.baseFingerprint) {
    return Effect.void; // no drift — identical coarse identity (members ⊕ roles)
  }

  const driftFailure = new GuardFailed({
    reason: 'roster_drift',
    message: 'the roster moved since you previewed — re-preview before going live',
  });

  // threshold 0: ANY fingerprint mismatch is drift (arrivals, departures,
  // role-id changes, replacements all change the fingerprint). The conservative
  // B1 posture — any role-relevant roster change forces a re-preview.
  if (threshold <= 0) {
    return Effect.fail(driftFailure);
  }

  // threshold > 0: allow a bounded NET change (arrivals + departures + role-id
  // churn), not arrivals alone.
  const netChange = netRosterChangeCount(input.baseSnapshot, input.freshSnapshot);
  if (netChange > threshold) {
    return Effect.fail(driftFailure);
  }
  return Effect.void; // drift within threshold
}
