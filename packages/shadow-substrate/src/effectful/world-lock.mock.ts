/**
 * effectful/world-lock.mock.ts — an IN-MEMORY per-world `WorldLock` Layer for
 * tests + as the substrate's clean default seam (SDD §4.4.1, task 402.4, B10).
 *
 * Uses one Effect `Semaphore(1)` per world slug (lazily created), so concurrent
 * `withWorldLock(world, …)` calls for the SAME world serialize and calls for
 * DIFFERENT worlds run in parallel. This is a faithful in-process model of the
 * Postgres-advisory-lock / Redis-SETNX seam the consumer supplies in S4 — it has
 * the same serialize-per-key contract, just no cross-process reach.
 *
 * `withPermits` releases the permit on success, failure, AND interrupt, so a
 * crashed/interrupted batch never parks the lock.
 */
import { Effect, Layer } from 'effect';
import type { Semaphore } from 'effect/Effect';
import type { WorldSlug } from '../types.js';
import type { WriteError } from '../errors.js';
import { WorldLock } from './world-lock.js';

/**
 * Build an in-memory `WorldLock` Layer. The per-world semaphore map lives in a
 * closure; one semaphore is created per distinct world slug on first use.
 *
 * Effect's semaphores are created in an Effect (`Effect.makeSemaphore`), so we
 * serialize creation through a single registry-guard semaphore to avoid a race
 * where two parallel first-touches for the same world each make their own
 * semaphore (which would defeat the lock). The guard is cheap and held only for
 * the map lookup/insert, never across the critical section.
 */
export function makeInMemoryWorldLock(): Layer.Layer<WorldLock> {
  return Layer.effect(
    WorldLock,
    Effect.gen(function* () {
      const locks = new Map<string, Semaphore>();
      // Guards creation of the per-world semaphores so two parallel
      // first-touches for the same world share ONE semaphore.
      const registryGuard = yield* Effect.makeSemaphore(1);

      const acquireFor = (world: WorldSlug): Effect.Effect<Semaphore> =>
        registryGuard.withPermits(1)(
          Effect.gen(function* () {
            const existing = locks.get(world);
            if (existing !== undefined) return existing;
            const sem = yield* Effect.makeSemaphore(1);
            locks.set(world, sem);
            return sem;
          }),
        );

      return {
        withWorldLock: <A, E>(world: WorldSlug, effect: Effect.Effect<A, E>) =>
          Effect.gen(function* () {
            const sem = yield* acquireFor(world);
            // withPermits releases on success / failure / interrupt.
            return yield* sem.withPermits(1)(effect);
          }) as Effect.Effect<A, E | WriteError>,
      };
    }),
  );
}

/**
 * A NO-OP `WorldLock` Layer — `withWorldLock(world, effect)` just runs `effect`
 * with NO serialization. This is the B10 NEGATIVE CONTROL (§8.4): with the lock
 * disabled, two concurrent same-world create spans interleave inside the
 * widened check-then-create window and BOTH create (2 creates). It proves the
 * positive test's single-create result is a real effect of the world-lock, not a
 * tautology. NEVER use in production — the lock is the cross-batch B10 guard.
 */
export function makeNoopWorldLock(): Layer.Layer<WorldLock> {
  return Layer.succeed(WorldLock, {
    withWorldLock: <A, E>(_world: WorldSlug, effect: Effect.Effect<A, E>) =>
      effect as Effect.Effect<A, E | WriteError>,
  });
}
