/**
 * MemoryConfigStore - in-process ConfigStore for tests + a usable service
 * before the pg pool is wired. Same optimistic-lock semantics as PgConfigStore
 * (version-guarded head move; 0-match -> null), single-threaded so the
 * transaction is just a synchronous critical section.
 *
 * NOT for production — no durability, no cross-process coordination.
 */

import type {
  ConfigStore,
  CurrentConfigRow,
  WriteInput,
  WriteResult,
  WriteProvenance,
  HistoryRecordRef,
} from '@freeside-worlds/config-engine';

interface HeadRow {
  worldSlug: string;
  surface: string;
  cmIdentityId: string | null;
  schemaVersion: string;
  config: unknown;
  version: number;
  lastRecordId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface HistoryRow {
  id: number;
  worldSlug: string;
  surface: string;
  cmIdentityId: string | null;
  action: string;
  prevConfig: unknown | null;
  newConfig: unknown;
  actor: string;
  reason?: string;
  /** cycle-010 (sprint T1.7): write provenance (audit subject). */
  provenance?: WriteProvenance;
  createdAt: string;
}

export class MemoryConfigStore implements ConfigStore {
  private heads = new Map<string, HeadRow>();
  private history: HistoryRow[] = [];
  private nextId = 1;

  /**
   * The head/history key. The `\0` (NUL) separator can never appear in a
   * slug/surface/UUID, so distinct composites never collide.
   *
   * S2 (shadow-onboarding-substrate, SDD §3.1): the per-CM `cmIdentityId`
   * sub-key is part of the key for `onboarding-lifecycle` — two CMs onboarding
   * the same world get TWO independent heads + histories. For every other
   * surface it is `null` and the key collapses to the legacy `(world, surface)`.
   */
  private key(worldSlug: string, surface: string, cmIdentityId: string | null): string {
    return `${worldSlug}\0${surface}\0${cmIdentityId ?? ''}`;
  }

  async getCurrent(
    worldSlug: string,
    surface: string,
    cmIdentityId: string | null = null,
  ): Promise<CurrentConfigRow | null> {
    const row = this.heads.get(this.key(worldSlug, surface, cmIdentityId));
    if (!row) return null;
    return { ...row };
  }

  async applyWrite(input: WriteInput): Promise<WriteResult | null> {
    const cmIdentityId = input.cmIdentityId ?? null;
    const k = this.key(input.worldSlug, input.surface, cmIdentityId);
    const existing = this.heads.get(k);
    const now = new Date().toISOString();

    if (input.action === 'CREATE') {
      if (existing) return null; // race: someone created it first.
    } else {
      // version-guarded: 0-match -> conflict.
      if (!existing || existing.version !== input.expectedVersion) return null;
    }

    const recordId = this.nextId++;
    this.history.push({
      id: recordId,
      worldSlug: input.worldSlug,
      surface: input.surface,
      cmIdentityId,
      action: input.action,
      prevConfig: input.prevConfig,
      newConfig: input.newConfig,
      actor: input.actor,
      reason: input.reason,
      provenance: input.provenance,
      createdAt: now,
    });

    if (input.action === 'CREATE') {
      const head: HeadRow = {
        worldSlug: input.worldSlug,
        surface: input.surface,
        cmIdentityId,
        schemaVersion: '1.0',
        config: input.newConfig,
        version: 1,
        lastRecordId: recordId,
        createdAt: now,
        updatedAt: now,
      };
      this.heads.set(k, head);
      return { recordId, newVersion: 1 };
    }

    const newVersion = existing!.version + 1;
    this.heads.set(k, {
      ...existing!,
      config: input.newConfig,
      version: newVersion,
      lastRecordId: recordId,
      updatedAt: now,
    });
    return { recordId, newVersion };
  }

  /**
   * cycle-010 (sprint T1.6 · SDD §4) retention hook: list the history record refs
   * ({id, createdAt}) for a key. Used by the engine's warn-then-prune pass.
   */
  async listHistoryRefs(
    worldSlug: string,
    surface: string,
    cmIdentityId: string | null = null,
  ): Promise<HistoryRecordRef[]> {
    return this.history
      .filter(
        (h) =>
          h.worldSlug === worldSlug &&
          h.surface === surface &&
          (h.cmIdentityId ?? null) === cmIdentityId,
      )
      .map((h) => ({ id: h.id, createdAt: h.createdAt }));
  }

  /**
   * cycle-010 (sprint T1.6) retention hook: delete the named history records.
   * Returns the count removed. Scoped to the key so a prune can never touch
   * another world/surface/CM's history.
   */
  async pruneHistory(
    worldSlug: string,
    surface: string,
    recordIds: ReadonlyArray<number>,
    cmIdentityId: string | null = null,
  ): Promise<number> {
    const ids = new Set(recordIds);
    const before = this.history.length;
    this.history = this.history.filter((h) => {
      const inScope =
        h.worldSlug === worldSlug &&
        h.surface === surface &&
        (h.cmIdentityId ?? null) === cmIdentityId;
      return !(inScope && ids.has(h.id));
    });
    return before - this.history.length;
  }

  /**
   * Test helper: read the append-only history for a key (most-recent-last).
   * `cmIdentityId` filters to a single per-CM record for `onboarding-lifecycle`
   * (omit / null = the legacy two-key history).
   */
  _history(
    worldSlug: string,
    surface: string,
    cmIdentityId: string | null = null,
  ): HistoryRow[] {
    return this.history.filter(
      (h) =>
        h.worldSlug === worldSlug &&
        h.surface === surface &&
        (h.cmIdentityId ?? null) === cmIdentityId,
    );
  }
}
