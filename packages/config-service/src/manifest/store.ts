/**
 * Manifest index store — idempotency + lookup by chain/contract.
 *
 * File-backed JSON index (`.kitchen-manifest-index.json` beside registry worlds/)
 * for persistence across restarts. In-memory implementation for tests.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ManifestRecord } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX_PATH = join(__dirname, '../../../registry/.kitchen-manifest-index.json');

interface PersistedIndex {
  records: ManifestRecord[];
}

export interface ManifestStore {
  findByIdempotencyKey(chainId: string, contractAddress: string, orderId: string): ManifestRecord | null;
  findByContract(chainId: string, contractAddress: string): ManifestRecord | null;
  listSlugs(): Set<string>;
  insert(record: ManifestRecord): void;
}

function idempotencyKey(chainId: string, contractAddress: string, orderId: string): string {
  return `${chainId}:${contractAddress}:${orderId}`;
}

function contractKey(chainId: string, contractAddress: string): string {
  return `${chainId}:${contractAddress}`;
}

export class MemoryManifestStore implements ManifestStore {
  private byIdempotency = new Map<string, ManifestRecord>();
  private byContract = new Map<string, ManifestRecord>();
  private slugs = new Set<string>();

  findByIdempotencyKey(chainId: string, contractAddress: string, orderId: string): ManifestRecord | null {
    return this.byIdempotency.get(idempotencyKey(chainId, contractAddress, orderId)) ?? null;
  }

  findByContract(chainId: string, contractAddress: string): ManifestRecord | null {
    return this.byContract.get(contractKey(chainId, contractAddress)) ?? null;
  }

  listSlugs(): Set<string> {
    return new Set(this.slugs);
  }

  insert(record: ManifestRecord): void {
    this.byIdempotency.set(idempotencyKey(record.chainId, record.contractAddress, record.orderId), record);
    this.byContract.set(contractKey(record.chainId, record.contractAddress), record);
    this.slugs.add(record.worldSlug);
  }
}

export class FileManifestStore extends MemoryManifestStore {
  private readonly records: ManifestRecord[] = [];

  constructor(private indexPath: string) {
    super();
    this.load();
  }

  override insert(record: ManifestRecord): void {
    super.insert(record);
    this.records.push(record);
    this.persist();
  }

  private load(): void {
    if (!existsSync(this.indexPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.indexPath, 'utf-8')) as PersistedIndex;
      for (const rec of raw.records ?? []) {
        super.insert(rec);
        this.records.push(rec);
      }
    } catch {
      // Corrupt index — start fresh; operator can reconcile from registry YAMLs.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.indexPath), { recursive: true });
    writeFileSync(this.indexPath, JSON.stringify({ records: this.records }, null, 2), 'utf-8');
  }
}

export function createManifestStore(indexPath = process.env.MANIFEST_INDEX_PATH ?? DEFAULT_INDEX_PATH): ManifestStore {
  return new FileManifestStore(indexPath);
}

/** Normalize contract address for stable lookup keys. */
export function normalizeContractAddress(address: string): string {
  const trimmed = address.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return trimmed.toLowerCase();
}

/** Build manifest_ref from order_id (stable, no PII). */
export function buildManifestRef(orderId: string): string {
  const frag = orderId.replace(/-/g, '').slice(0, 12);
  return `manifest_${frag}`;
}
