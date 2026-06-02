/**
 * ConfigStore port — the persistence seam.
 *
 * The engine (ConfigService) talks to this interface, never to a concrete DB.
 * packages/config-adapters provides the PostgreSQL implementation. A future
 * SQLite/in-memory adapter (tests) implements the same port. This mirrors the
 * brains-in-vats / cyberdeck split: the engine is the construct (pure logic +
 * optimistic-lock machinery), the adapter is the execution plane (real SQL).
 *
 * Atomicity contract: `applyWrite` MUST run the read-version-check ->
 * append-history -> update-head-pointer sequence in ONE transaction, and the
 * head-pointer update MUST be `UPDATE ... WHERE version = expected` so the
 * adapter can report a 0-row-affected conflict (the optimistic lock). This is
 * the exact machinery ported from Jani's sietch ConfigService.updateThresholds
 * transaction, generalized off the threshold/featureGate/roleMap specifics.
 */

import type { ConfigAction } from './types.js';

/** A head-pointer row. `config` is the opaque (already-validated) JSONB. */
export interface CurrentConfigRow {
  worldSlug: string;
  surface: string;
  /**
   * S2 (shadow-onboarding-substrate, SDD §3.1/§6.1): the per-CM sub-key for the
   * `onboarding-lifecycle` surface. `null` for every other surface (the
   * composite collapses to the existing `(world, surface)` key). For
   * `onboarding-lifecycle` it is the CM's identity-api `user_id` (UUID), so two
   * CMs onboarding the same world get TWO independent head rows + histories,
   * never one shared/overwritten row (B1/SKP-006).
   */
  cmIdentityId: string | null;
  schemaVersion: string;
  config: unknown;
  version: number;
  lastRecordId: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Inputs for a single write (one history append + one head-pointer move). */
export interface WriteInput {
  worldSlug: string;
  surface: string;
  /**
   * S2: per-CM sub-key for `onboarding-lifecycle` (null otherwise). Part of the
   * optimistic-lock key — the version-guarded UPDATE matches on the full
   * composite `(worldSlug, surface, cmIdentityId)`.
   */
  cmIdentityId: string | null;
  /** Expected current version for the optimistic lock. null => CREATE (no row yet). */
  expectedVersion: number | null;
  action: ConfigAction;
  /** Previous head config (null on CREATE). */
  prevConfig: unknown | null;
  /** New config to install at the head. Already schema-validated by the engine. */
  newConfig: unknown;
  actor: string;
  reason?: string;
}

/** Result of a successful write. */
export interface WriteResult {
  recordId: number;
  newVersion: number;
}

/**
 * The persistence seam. Two reads + one transactional write.
 * `applyWrite` returns null to signal an optimistic-lock conflict (0 rows
 * affected on the version-guarded UPDATE) — the engine converts that into a
 * ConfigVersionConflictError so the conflict semantics live in one place.
 */
export interface ConfigStore {
  /**
   * O(1) head-pointer read. Returns null when no config exists yet (caller ->
   * defaults). `cmIdentityId` is the per-CM sub-key for `onboarding-lifecycle`
   * (null for every other surface — SDD §3.1). Adapters that predate S2 may
   * treat a `null` cmIdentityId as the legacy two-key read.
   */
  getCurrent(
    worldSlug: string,
    surface: string,
    cmIdentityId?: string | null,
  ): Promise<CurrentConfigRow | null>;

  /**
   * Transactionally: append a config_record (immutable history) and move the
   * head pointer. For UPDATE/RESTORE the head move is version-guarded; return
   * null when the guard matches 0 rows (conflict). For CREATE, insert the head
   * row; if it already exists (race), return null so the engine retries as an
   * UPDATE-conflict.
   */
  applyWrite(input: WriteInput): Promise<WriteResult | null>;
}
