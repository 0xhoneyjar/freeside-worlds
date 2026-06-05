/**
 * test-memory-store.ts — a self-contained in-memory ConfigStore for the engine
 * tests. Deliberately NOT imported from config-adapters: the engine package must
 * not depend on the adapters package (layering inversion — engine is the
 * construct plane, adapters the execution plane; see config-service.test.ts's
 * inline copy). This shared copy adds the cycle-010 retention prune hooks +
 * provenance capture so the surfaces + retention tests can use one store.
 *
 * Semantics match config-adapters/MemoryConfigStore: version-guarded head move,
 * 0-match → null (optimistic-lock conflict), NUL-separated composite key.
 */
import type {
  ConfigStore,
  CurrentConfigRow,
  WriteInput,
  WriteResult,
  WriteProvenance,
  HistoryRecordRef,
} from '../src/index.js';

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
  provenance?: WriteProvenance;
  createdAt: string;
}

export class TestMemoryStore implements ConfigStore {
  private heads = new Map<string, HeadRow>();
  private history: HistoryRow[] = [];
  private nextId = 1;
  /** Optional injected clock so retention-boundary tests can control createdAt. */
  now: () => string = () => new Date().toISOString();

  private key(w: string, s: string, cm: string | null): string {
    return `${w}\0${s}\0${cm ?? ''}`;
  }

  async getCurrent(
    w: string,
    s: string,
    cm: string | null = null,
  ): Promise<CurrentConfigRow | null> {
    const r = this.heads.get(this.key(w, s, cm));
    return r ? { ...r } : null;
  }

  async applyWrite(input: WriteInput): Promise<WriteResult | null> {
    const cm = input.cmIdentityId ?? null;
    const k = this.key(input.worldSlug, input.surface, cm);
    const existing = this.heads.get(k);
    const now = this.now();

    if (input.action === 'CREATE') {
      if (existing) return null;
    } else if (!existing || existing.version !== input.expectedVersion) {
      return null;
    }

    const recordId = this.nextId++;
    this.history.push({
      id: recordId,
      worldSlug: input.worldSlug,
      surface: input.surface,
      cmIdentityId: cm,
      action: input.action,
      prevConfig: input.prevConfig,
      newConfig: input.newConfig,
      actor: input.actor,
      reason: input.reason,
      provenance: input.provenance,
      createdAt: now,
    });

    if (input.action === 'CREATE') {
      this.heads.set(k, {
        worldSlug: input.worldSlug,
        surface: input.surface,
        cmIdentityId: cm,
        schemaVersion: '1.0',
        config: input.newConfig,
        version: 1,
        lastRecordId: recordId,
        createdAt: now,
        updatedAt: now,
      });
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

  async listHistoryRefs(
    w: string,
    s: string,
    cm: string | null = null,
  ): Promise<HistoryRecordRef[]> {
    return this.history
      .filter((h) => h.worldSlug === w && h.surface === s && (h.cmIdentityId ?? null) === cm)
      .map((h) => ({ id: h.id, createdAt: h.createdAt }));
  }

  async pruneHistory(
    w: string,
    s: string,
    recordIds: ReadonlyArray<number>,
    cm: string | null = null,
  ): Promise<number> {
    const ids = new Set(recordIds);
    const before = this.history.length;
    this.history = this.history.filter((h) => {
      const inScope = h.worldSlug === w && h.surface === s && (h.cmIdentityId ?? null) === cm;
      return !(inScope && ids.has(h.id));
    });
    return before - this.history.length;
  }

  _history(w: string, s: string, cm: string | null = null): HistoryRow[] {
    return this.history.filter(
      (h) => h.worldSlug === w && h.surface === s && (h.cmIdentityId ?? null) === cm,
    );
  }

  /** Test helper: directly seed a history record with a controlled createdAt. */
  _seedHistory(row: { worldSlug: string; surface: string; cmIdentityId?: string | null; createdAt: string; newConfig?: unknown }): number {
    const id = this.nextId++;
    this.history.push({
      id,
      worldSlug: row.worldSlug,
      surface: row.surface,
      cmIdentityId: row.cmIdentityId ?? null,
      action: 'CREATE',
      prevConfig: null,
      newConfig: row.newConfig ?? {},
      actor: 'seed',
      createdAt: row.createdAt,
    });
    return id;
  }
}
