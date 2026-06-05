/**
 * PgConfigStore — PostgreSQL implementation of the ConfigStore port.
 *
 * The execution-plane half of the config service: runs Jani's sietch
 * transactional optimistic-lock machinery against PostgreSQL instead of
 * SQLite. Schema: packages/config-adapters/migrations/0001_surface_config.sql.
 *
 * Pool injection: takes a `pg.Pool`-shaped client. The pool MUST point at
 * freeside-worlds' OWN database. ISOLATION INVARIANT (C-1): this store NEVER
 * connects to mibera-db, identity-api's spine, or any world's DB. The caller
 * wires the pool from the service's own DATABASE_URL.
 *
 * `pg` is an OPTIONAL peer: the engine + protocol packages have zero DB deps;
 * only this adapter needs `pg`. Kept as a thin structural type so the package
 * typechecks without `pg` installed in the worktree.
 */

import type {
  ConfigStore,
  CurrentConfigRow,
  WriteInput,
  WriteResult,
  HistoryRecordRef,
} from '@freeside-worlds/config-engine';

/** Minimal structural shape of a `pg.Pool` / `pg.PoolClient`. */
export interface PgQueryable {
  query<R = unknown>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgClientLike>;
}

export interface PgClientLike extends PgQueryable {
  release(): void;
}

interface CurrentConfigDbRow {
  world_slug: string;
  surface: string;
  cm_identity_id: string;
  schema_version: string;
  config: unknown;
  version: number;
  last_record_id: string | number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export class PgConfigStore implements ConfigStore {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  /**
   * Map the engine's `cmIdentityId: string | null` to the DB column. S2
   * (SDD §3.1): the `onboarding-lifecycle` surface carries the per-CM sub-key;
   * every other surface passes `null`, which the schema stores as '' (the
   * `cm_identity_id NOT NULL DEFAULT ''` column, migration 0002) so the
   * composite primary key stays well-formed (NULL in a PK is disallowed).
   */
  private cmKey(cmIdentityId: string | null | undefined): string {
    return cmIdentityId ?? '';
  }

  async getCurrent(
    worldSlug: string,
    surface: string,
    cmIdentityId: string | null = null,
  ): Promise<CurrentConfigRow | null> {
    const res = await this.pool.query<CurrentConfigDbRow>(
      `SELECT world_slug, surface, cm_identity_id, schema_version, config, version,
              last_record_id, created_at, updated_at
         FROM current_config
        WHERE world_slug = $1 AND surface = $2 AND cm_identity_id = $3`,
      [worldSlug, surface, this.cmKey(cmIdentityId)],
    );
    const row = res.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Transactional write. Ports sietch's `db.transaction(() => { ... })`:
   *   BEGIN
   *     CREATE path: INSERT head (ON CONFLICT DO NOTHING -> 0 rows = race -> null)
   *     UPDATE path: UPDATE head ... WHERE version = expected (0 rows -> null)
   *     append config_record (immutable history)
   *     back-link head.last_record_id -> record.id
   *   COMMIT
   * The version guard is the optimistic lock; 0 rows affected -> ROLLBACK + null.
   */
  async applyWrite(input: WriteInput): Promise<WriteResult | null> {
    const client = await this.pool.connect();
    const cmIdentityId = this.cmKey(input.cmIdentityId);
    try {
      await client.query('BEGIN');

      // 1. append the immutable history row first (it carries prev+new). The
      // cycle-010 (sprint T1.7) `provenance` JSONB column (migration 0003,
      // additive DEFAULT NULL) records the audit subject {service_identity,
      // actor, plan_id|apply_id, fencing_token, ts}. NULL for the 4 existing
      // surfaces' writes (no provenance supplied).
      const recordRes = await client.query<{ id: string | number }>(
        `INSERT INTO config_record
            (world_slug, surface, cm_identity_id, action, prev_config, new_config, actor, reason, provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          input.worldSlug,
          input.surface,
          cmIdentityId,
          input.action,
          input.prevConfig === null ? null : JSON.stringify(input.prevConfig),
          JSON.stringify(input.newConfig),
          input.actor,
          input.reason ?? null,
          input.provenance === undefined ? null : JSON.stringify(input.provenance),
        ],
      );
      const recordId = Number(recordRes.rows[0]!.id);

      let newVersion: number;

      if (input.action === 'CREATE') {
        // CREATE: insert head; ON CONFLICT DO NOTHING so a concurrent CREATE
        // (two writers racing the first config) yields 0 rows -> conflict.
        // The conflict target is the composite PK (world, surface, cm_identity_id).
        const insertRes = await client.query<{ version: number }>(
          `INSERT INTO current_config
              (world_slug, surface, cm_identity_id, schema_version, config, version, last_record_id)
           VALUES ($1, $2, $3, '1.0', $4, 1, $5)
           ON CONFLICT (world_slug, surface, cm_identity_id) DO NOTHING
           RETURNING version`,
          [input.worldSlug, input.surface, cmIdentityId, JSON.stringify(input.newConfig), recordId],
        );
        if (insertRes.rowCount === 0) {
          await client.query('ROLLBACK');
          return null;
        }
        newVersion = insertRes.rows[0]!.version;
      } else {
        // UPDATE / RESTORE: version-guarded head move. This IS the optimistic
        // lock — UPDATE ... WHERE version = expected; 0 rows = conflict. The
        // guard matches on the full composite key (per-CM for onboarding-lifecycle).
        const updateRes = await client.query<{ version: number }>(
          `UPDATE current_config
              SET config = $1,
                  version = version + 1,
                  last_record_id = $2,
                  updated_at = now()
            WHERE world_slug = $3 AND surface = $4 AND cm_identity_id = $5 AND version = $6
          RETURNING version`,
          [
            JSON.stringify(input.newConfig),
            recordId,
            input.worldSlug,
            input.surface,
            cmIdentityId,
            input.expectedVersion,
          ],
        );
        if (updateRes.rowCount === 0) {
          await client.query('ROLLBACK');
          return null;
        }
        newVersion = updateRes.rows[0]!.version;
      }

      await client.query('COMMIT');
      return { recordId, newVersion };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore rollback error */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * cycle-010 (sprint T1.6 · SDD §4) retention hook: list the history record
   * refs ({id, createdAt}) for a key, most-recent-first. Scoped to the composite
   * key (per-CM for onboarding-lifecycle; `cm=''` for the rest).
   */
  async listHistoryRefs(
    worldSlug: string,
    surface: string,
    cmIdentityId: string | null = null,
  ): Promise<HistoryRecordRef[]> {
    const res = await this.pool.query<{ id: string | number; created_at: Date | string }>(
      `SELECT id, created_at
         FROM config_record
        WHERE world_slug = $1 AND surface = $2 AND cm_identity_id = $3
        ORDER BY created_at DESC, id DESC`,
      [worldSlug, surface, this.cmKey(cmIdentityId)],
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      createdAt: typeof r.created_at === 'string' ? r.created_at : r.created_at.toISOString(),
    }));
  }

  /**
   * cycle-010 (sprint T1.6) retention hook: delete the named history records.
   * Scoped to the composite key so a prune can never touch another
   * world/surface/CM's history. Returns the count removed.
   */
  async pruneHistory(
    worldSlug: string,
    surface: string,
    recordIds: ReadonlyArray<number>,
    cmIdentityId: string | null = null,
  ): Promise<number> {
    if (recordIds.length === 0) return 0;
    const res = await this.pool.query(
      `DELETE FROM config_record
        WHERE world_slug = $1 AND surface = $2 AND cm_identity_id = $3
          AND id = ANY($4::bigint[])`,
      [worldSlug, surface, this.cmKey(cmIdentityId), recordIds],
    );
    return res.rowCount ?? 0;
  }

  private mapRow(row: CurrentConfigDbRow): CurrentConfigRow {
    return {
      worldSlug: row.world_slug,
      surface: row.surface,
      // Map the DB's '' sentinel back to null so the engine sees a clean
      // null for every non-onboarding-lifecycle surface (SDD §3.1).
      cmIdentityId: row.cm_identity_id === '' ? null : row.cm_identity_id,
      schemaVersion: row.schema_version,
      // pg returns JSONB as a parsed object already; pass through.
      config: row.config,
      version: row.version,
      lastRecordId: row.last_record_id === null ? null : Number(row.last_record_id),
      createdAt: typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString(),
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : row.updated_at.toISOString(),
    };
  }
}
