/**
 * ConfigService — the engine.
 *
 * Ported from Jani's sietch ConfigService
 * (themes/sietch/src/services/config/ConfigService.ts). Keeps the MACHINERY:
 *   - head-pointer O(1) read (getConfig)
 *   - optimistic-locked write (putConfig): read version -> validate ->
 *     append immutable history -> version-guarded head move -> 0-rows = 409
 *   - append-only audit trail (every write inserts a config_record)
 *
 * DROPS the sietch specifics: the threshold/featureGate/roleMap delegated
 * payloads and the SQLite prepared-statement bundle. Instead it is generic
 * over (world_slug, surface) -> validated JSON, talks to a ConfigStore port
 * (no DB import), and validates against the sealed surface-config schema.
 *
 * fail-soft READ: getConfig returns null when no config exists; the caller
 * (HTTP layer / consuming world) uses its own defaults. The engine never
 * invents a default — that's a presentation/consumer decision.
 *
 * fail-closed WRITE: putConfig validates the payload against the sealed schema
 * BEFORE touching the store; invalid -> ConfigValidationError (HTTP 422/400).
 */

import {
  validateSurfacePayload,
  PER_CM_SURFACES,
  computeRosterCommitId,
  type Surface,
  type SurfaceConfigMap,
  type SurfaceConfig,
  type RosterCommitContent,
} from '@freeside-worlds/config-protocol';
import type { ConfigStore, CurrentConfigRow, WriteProvenance } from './store.js';
import {
  ConfigKeyError,
  ConfigValidationError,
  ConfigVersionConflictError,
  ConfigTenantIsolationError,
} from './errors.js';
import {
  isRetentionSurface,
  computeCommitHistoryPrune,
  computeLedgerEntryPrune,
  DEFAULT_RETENTION_POLICY,
  type RetentionPolicy,
  type LedgerEntryRef,
} from './retention.js';

/**
 * Is `surface` per-CM (composite-keyed `(world, surface, cm_identity_id)`)? A
 * null/empty/whitespace `cmIdentityId` for such a surface would collapse onto
 * the shared legacy `''` sub-key (defeating B1/SKP-006). The engine fails closed
 * on a missing key for these surfaces — defense-in-depth behind the HTTP guard.
 *
 * FAGAN iter-3 cleanup: this now reads the PROTOCOL-LEVEL `PER_CM_SURFACES` set
 * (config-protocol) — the SAME source the HTTP isolation guard (app.ts) uses —
 * so a future per-CM surface cannot be half-wired (engine-guarded but not
 * HTTP-guarded, or vice-versa). config-engine already depends ONE-WAY on
 * config-protocol (it imports `validateSurfacePayload`/`Surface`), so this adds
 * no new dependency and no circular arrow.
 */
function isPerCmSurface(surface: Surface): boolean {
  return PER_CM_SURFACES.has(surface);
}

/**
 * True when `cmIdentityId` is absent, empty, OR whitespace-only — any of which
 * would let a direct ConfigService caller persist `onboarding-lifecycle` under a
 * blank/garbage composite sub-key, weakening the B1/SKP-006 per-CM isolation
 * invariant. FAGAN iter-3 MAJOR 4: the previous check accepted `'   '` (a
 * whitespace-only key) as PRESENT. We now trim and treat a zero-length trim as
 * missing → fail closed (`ConfigKeyError`).
 *
 * FAGAN iter-4 MAJOR: the previous guard tested `cmIdentityId === null` BEFORE
 * trimming. At runtime an OMITTED optional `cmIdentityId` arrives as `undefined`
 * (not `null`); `undefined === null` is false, so control reached
 * `undefined.trim()` → a TypeError CRASH instead of the intended fail-closed
 * `ConfigKeyError`. The loose `== null` matches BOTH `null` AND `undefined`, so
 * we never call `.trim()` on a nullish value. This is the SINGLE source of the
 * null/undefined/whitespace semantics — both `getConfig` and `putConfig` call it.
 */
function isMissingCmKey(cmIdentityId: string | null | undefined): boolean {
  return cmIdentityId == null || cmIdentityId.trim().length === 0;
}

/**
 * cycle-010 (sprint T1.7 · SDD §6) tenant-isolation: the `roster-commit` +
 * `pending-apply` payloads carry a `world` field (their merge base / apply txn
 * is world-bound). Extract it (string) so the engine can assert it equals the
 * path/authorized world. Returns null when the payload has no `world` field (the
 * 4 existing surfaces + resolution-ledger), so the isolation check is a no-op for
 * them (additive — never fires for the existing surfaces).
 */
function extractPayloadWorld(config: unknown): string | null {
  if (config !== null && typeof config === 'object' && 'world' in config) {
    const w = (config as { world?: unknown }).world;
    return typeof w === 'string' ? w : null;
  }
  return null;
}

/**
 * cycle-010 (sprint T1.6): flatten a resolution-ledger document into the
 * `{ key, ts }` refs the retention policy reasons over. PURE.
 */
function ledgerEntryRefs(
  config: SurfaceConfigMap['resolution-ledger'],
): LedgerEntryRef[] {
  const entries = config.entries ?? {};
  return Object.keys(entries).map((key) => ({ key, ts: entries[key]!.ts }));
}

/**
 * cycle-010 (FR-1 · SDD §2.1 · /fagan R1 CRITICAL) — assert a roster-commit's
 * claimed `commit_id` actually hashes its content. The schema only proves the id
 * is 64-hex; this proves it is the CONTENT HASH (content-addressability is the
 * FR-1 merge-base guarantee). Recompute from the content (the helper strips the
 * claimed id before hashing) and throw a ConfigValidationError on mismatch.
 * Runs BEFORE any store mutation, so a forged commit never persists.
 */
function assertRosterCommitIdIntegrity(
  worldSlug: string,
  commit: SurfaceConfigMap['roster-commit'],
): void {
  // `commit` is already schema-validated (commit_id is 64-hex). Strip it so the
  // hash is over the content only (never over its own output), then recompute.
  const { commit_id: claimed, ...content } = commit;
  const expected = computeRosterCommitId(content as RosterCommitContent);
  if (claimed !== expected) {
    throw new ConfigValidationError(worldSlug, 'roster-commit', [
      {
        instancePath: '/config/commit_id',
        message: `commit_id does not match the content hash (claimed ${claimed.slice(0, 12)}…, expected ${expected.slice(0, 12)}…) — content-addressability (FR-1) violated`,
      },
    ]);
  }
}

export interface ConfigServiceDeps {
  store: ConfigStore;
  /** Optional structured logger ({ info, warn, error }); defaults to no-op. */
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
  /**
   * cycle-010 (sprint T1.6 · SDD §4 · §9 fork 5) retention knobs for
   * `roster-commit` + `resolution-ledger`. Defaults to last-50 + 180d. Tunable
   * per-deployment without redeploy via this dep.
   */
  retentionPolicy?: RetentionPolicy;
  /**
   * cycle-010 (sprint T1.6): a clock seam so the warn-then-prune boundary is
   * testable. Defaults to `() => new Date()`.
   */
  now?: () => Date;
}

const NOOP_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** What getConfig returns: the full envelope + the version (for the next PUT). */
export interface ReadResult<S extends Surface> {
  envelope: SurfaceConfig<S>;
  version: number;
  updatedAt: string;
}

export interface WriteOk<S extends Surface> {
  envelope: SurfaceConfig<S>;
  version: number;
  recordId: number;
}

export class ConfigService {
  private readonly store: ConfigStore;
  private readonly logger: NonNullable<ConfigServiceDeps['logger']>;
  private readonly retentionPolicy: RetentionPolicy;
  private readonly now: () => Date;

  constructor(deps: ConfigServiceDeps) {
    this.store = deps.store;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.retentionPolicy = deps.retentionPolicy ?? DEFAULT_RETENTION_POLICY;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * O(1) head-pointer read. Returns null when the config has never been set
   * (fail-soft: caller uses defaults). Mirrors sietch getCurrentConfiguration,
   * minus the auto-initialize-with-defaults branch (the engine does NOT invent
   * a row on read — that was a sietch convenience that hides "never configured"
   * from the caller; here 404-on-read is a meaningful signal).
   */
  async getConfig<S extends Surface>(
    worldSlug: string,
    surface: S,
    cmIdentityId: string | null | undefined = null,
  ): Promise<ReadResult<S> | null> {
    // FAIL CLOSED at the engine boundary: the per-CM surface REQUIRES a non-null/
    // non-empty cmIdentityId, else the store maps null -> '' and every caller
    // shares one legacy head row (defeats B1/SKP-006 per-CM isolation).
    if (isPerCmSurface(surface) && isMissingCmKey(cmIdentityId)) {
      throw new ConfigKeyError(
        worldSlug,
        surface,
        'onboarding-lifecycle requires a non-empty cmIdentityId (per-CM composite sub-key)',
      );
    }
    // Collapse a nullish key to `null` for the store (a `null` cm = legacy
    // two-key read for non-per-CM surfaces; per-CM surfaces never reach here
    // nullish — the guard above fails them closed).
    const cmKey = cmIdentityId ?? null;
    const row = await this.store.getCurrent(worldSlug, surface, cmKey);
    if (!row) return null;
    return this.rowToReadResult<S>(row, surface);
  }

  /**
   * Optimistic-locked write. The full port of sietch's update* transaction:
   *
   *   1. validate the payload against the sealed schema (fail-closed).
   *   2. read the current head row (for prev_config + the action discriminator).
   *   3. determine action: CREATE if no row, else UPDATE.
   *   4. delegate to store.applyWrite — which, in ONE transaction, appends the
   *      immutable history row and moves the head pointer with a version guard.
   *   5. store returns null on a 0-row-affected guard -> ConfigVersionConflictError
   *      (HTTP 409).
   *
   * `expectedVersion` is the optimistic-lock token the caller read from a prior
   * GET. On CREATE it is ignored (no row exists yet); the engine passes the
   * sietch-equivalent "no current row" path through to the store.
   */
  async putConfig<S extends Surface>(
    worldSlug: string,
    surface: S,
    config: SurfaceConfigMap[S],
    expectedVersion: number,
    actor: string,
    reason?: string,
    cmIdentityId: string | null | undefined = null,
    provenance?: WriteProvenance,
  ): Promise<WriteOk<S>> {
    // 0. FAIL CLOSED at the engine boundary: the per-CM surface REQUIRES a
    // non-null/non-empty cmIdentityId (else the store collapses to the shared
    // '' key — defeats B1/SKP-006). Defense-in-depth behind the HTTP guard.
    if (isPerCmSurface(surface) && isMissingCmKey(cmIdentityId)) {
      throw new ConfigKeyError(
        worldSlug,
        surface,
        'onboarding-lifecycle requires a non-empty cmIdentityId (per-CM composite sub-key)',
      );
    }
    // Collapse a nullish key to `null` for the store's composite key (per-CM
    // surfaces never reach here nullish — the guard above fails them closed).
    const cmKey = cmIdentityId ?? null;

    // 0b. cycle-010 (sprint T1.7 · SDD §6) TENANT ISOLATION: a roster-commit /
    // pending-apply payload carries its OWN `world` field (the merge base + the
    // apply transaction are world-bound). If that payload world disagrees with
    // the path/authorized world, the write is a cross-tenant write — reject
    // (defense-in-depth behind the FR-10 floor, which already validated the
    // actor's authority FOR `worldSlug`). The 4 existing surfaces have no `world`
    // field, so this never fires for them (additive).
    const payloadWorld = extractPayloadWorld(config);
    if (payloadWorld !== null && payloadWorld !== worldSlug) {
      throw new ConfigTenantIsolationError(worldSlug, surface, payloadWorld);
    }

    // 1. fail-closed validation BEFORE any store mutation.
    const validation = validateSurfacePayload<S>(worldSlug, surface, config);
    if (!validation.ok) {
      this.logger.warn(
        { worldSlug, surface, issues: validation.errors },
        'config validation failed',
      );
      throw new ConfigValidationError(
        worldSlug,
        surface,
        validation.errors.map((e) => ({ instancePath: e.instancePath, message: e.message })),
      );
    }

    // 1b. cycle-010 (FR-1 · SDD §2.1 · /fagan R1 CRITICAL) COMMIT-ID INTEGRITY:
    // the schema only proves `commit_id` is 64-hex — NOT that it actually hashes
    // the content. Without this check a caller could persist a FORGED commit
    // (any 64-hex string), defeating the content-addressed merge-base guarantee
    // (FR-1: commit_id IS the content hash). Recompute from the content (strip
    // the claimed id, hash the rest via the canonical events primitive) and
    // reject a mismatch BEFORE any store mutation. Mirrors the L6 handoff
    // content-addressability invariant (id-as-claimed must equal id-as-computed).
    if (surface === 'roster-commit') {
      assertRosterCommitIdIntegrity(worldSlug, config as SurfaceConfigMap['roster-commit']);
    }

    // 2. read current head (prev_config + action) — per-CM for onboarding-lifecycle.
    const current = await this.store.getCurrent(worldSlug, surface, cmKey);
    const isCreate = current === null;

    // On UPDATE, the caller's expectedVersion must match the head before we
    // even try the guarded write — but we still let the store's version-guard
    // be the AUTHORITATIVE check (defends the read->write race). The early
    // check here gives a fast, accurate conflict when versions plainly differ.
    if (!isCreate && current!.version !== expectedVersion) {
      throw new ConfigVersionConflictError(
        worldSlug,
        surface,
        expectedVersion,
        current!.version,
      );
    }

    // 3 + 4. transactional append + version-guarded head move.
    const result = await this.store.applyWrite({
      worldSlug,
      surface,
      cmIdentityId: cmKey,
      expectedVersion: isCreate ? null : expectedVersion,
      action: isCreate ? 'CREATE' : 'UPDATE',
      prevConfig: isCreate ? null : current!.config,
      newConfig: config,
      actor,
      reason,
      provenance,
    });

    // 5. null => optimistic-lock conflict (0 rows affected on the guard, or a
    // CREATE race where the row appeared between our read and insert).
    if (result === null) {
      const latest = await this.store.getCurrent(worldSlug, surface, cmKey);
      throw new ConfigVersionConflictError(
        worldSlug,
        surface,
        expectedVersion,
        latest ? latest.version : null,
      );
    }

    this.logger.info(
      { worldSlug, surface, actor, action: isCreate ? 'CREATE' : 'UPDATE', version: result.newVersion },
      'config written',
    );

    // 6. cycle-010 (sprint T1.6 · SDD §4) warn-then-prune at write time for the
    // retention surfaces. NEVER fails the write — retention is best-effort, run
    // AFTER the durable write so a prune error can never lose a just-written
    // commit. For roster-commit (append-only history) it prunes records; for
    // resolution-ledger (one document) it warns on over-retention entries.
    await this.applyRetention(worldSlug, surface, cmKey, config);

    return {
      envelope: {
        schema_version: '1.0',
        world_slug: worldSlug,
        surface,
        config,
      } as SurfaceConfig<S>,
      version: result.newVersion,
      recordId: result.recordId,
    };
  }

  /**
   * cycle-010 (sprint T1.6 · SDD §4 · §9 fork 5) warn-then-prune. Best-effort,
   * post-write, never throws into the caller (a retention failure must not lose
   * the write that already committed).
   *
   *   • `roster-commit`     — prune append-only history records (last-N + TTL).
   *     Actual delete runs ONLY when the adapter implements both `listHistoryRefs`
   *     + `pruneHistory`; otherwise WARN (loud) — Phase-1 warn-then-prune.
   *   • `resolution-ledger` — the ledger is one document we just wrote; WARN when
   *     its entries exceed retention (the consumer/apply planner owns the actual
   *     entry eviction; the store-side policy bounds growth + warns).
   */
  private async applyRetention<S extends Surface>(
    worldSlug: string,
    surface: S,
    cmKey: string | null,
    config: SurfaceConfigMap[S],
  ): Promise<void> {
    if (!isRetentionSurface(surface)) return;
    const now = this.now();

    try {
      if (surface === 'roster-commit') {
        // Append-only history retention. Needs the adapter's optional hooks.
        if (!this.store.listHistoryRefs || !this.store.pruneHistory) {
          this.logger.warn(
            { worldSlug, surface, policy: this.retentionPolicy },
            'roster-commit retention configured but adapter has no prune hooks — history NOT pruned (warn-then-prune Phase-1)',
          );
          return;
        }
        const refs = await this.store.listHistoryRefs(worldSlug, surface, cmKey);
        const plan = computeCommitHistoryPrune(refs, now, this.retentionPolicy);
        if (plan.pruneIds.length === 0) return;
        this.logger.warn(
          {
            worldSlug,
            surface,
            total: plan.total,
            overCount: plan.overCount,
            overAge: plan.overAge,
            pruning: plan.pruneIds.length,
            policy: this.retentionPolicy,
          },
          'roster-commit history over retention — pruning',
        );
        const pruned = await this.store.pruneHistory(worldSlug, surface, plan.pruneIds, cmKey);
        this.logger.info({ worldSlug, surface, pruned }, 'roster-commit history pruned');
        return;
      }

      if (surface === 'resolution-ledger') {
        const entries = ledgerEntryRefs(config as SurfaceConfigMap['resolution-ledger']);
        const plan = computeLedgerEntryPrune(entries, now, this.retentionPolicy);
        if (plan.pruneKeys.length === 0) return;
        // The ledger is a single versioned document; the entry-eviction is the
        // CONSUMER's write (next PUT). The store-side policy WARNS so unbounded
        // growth is visible — Phase-1 warn-then-prune.
        this.logger.warn(
          {
            worldSlug,
            surface,
            total: plan.total,
            overCount: plan.overCount,
            overAge: plan.overAge,
            overRetention: plan.pruneKeys.length,
            policy: this.retentionPolicy,
          },
          'resolution-ledger over retention — consumer should evict over-retention entries (warn-then-prune Phase-1)',
        );
      }
    } catch (err) {
      // Retention is best-effort — NEVER propagate (the write already committed).
      this.logger.error({ worldSlug, surface, err: String(err) }, 'retention pass failed (non-fatal)');
    }
  }

  private rowToReadResult<S extends Surface>(
    row: CurrentConfigRow,
    surface: S,
  ): ReadResult<S> {
    return {
      envelope: {
        schema_version: '1.0',
        world_slug: row.worldSlug,
        surface,
        config: row.config as SurfaceConfigMap[S],
      } as SurfaceConfig<S>,
      version: row.version,
      updatedAt: row.updatedAt,
    };
  }
}
