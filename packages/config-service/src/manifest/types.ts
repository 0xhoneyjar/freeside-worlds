/** Kitchen upstream manifest record — persisted index entry (PII stays server-side). */

export interface ManifestCreateInput {
  chainId: string;
  contractAddress: string;
  displayName: string;
  contactEmail: string;
  orderId: string;
  source?: string;
}

export interface ManifestRecord {
  /** Stable handle returned to consumers, e.g. `manifest_541da59c`. */
  manifestRef: string;
  worldSlug: string;
  chainId: string;
  contractAddress: string;
  orderId: string;
  displayName: string;
  /** Stored for operator audit; never returned on public lookup. */
  contactEmail: string;
  source: string;
  createdAt: string;
}

/** Public lookup / idempotent response shape — no PII. */
export interface ManifestPublicView {
  world_slug: string;
  manifest_ref: string;
  created_at: string;
}

export function toPublicView(record: ManifestRecord): ManifestPublicView {
  return {
    world_slug: record.worldSlug,
    manifest_ref: record.manifestRef,
    created_at: record.createdAt,
  };
}
