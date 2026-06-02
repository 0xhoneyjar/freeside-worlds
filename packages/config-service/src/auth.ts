/**
 * auth.ts — the config-service auth seam.
 *
 * ── FR-10 floor (S2, shadow-onboarding-substrate; closes R-3) ───────────────
 * The C-1 any-bearer write stub is GONE. The write/read gates now delegate to
 * the FR-10 authorization floor (fr10-authz.ts): verify the identity token →
 * `claims.sub` → the substrate's ONE authoritative `resolveAuthz` allowlist
 * decision. NO any-bearer write is ever accepted; every PUT requires
 * `claims.sub ∈ world.admin_principals`, and every GET re-checks the same
 * decision (B4 — a revoked admin loses READ too).
 *
 * The READ-gate service token (`checkServiceToken`) is the EXISTING coarse read
 * gate (a shared service token); the FR-10 `resolveReaderAuthz` is the per-actor
 * authority check layered ON TOP for the lifecycle/config surfaces. They are
 * orthogonal: the service token says "this caller may reach the API"; the FR-10
 * read check says "this verified actor is still an admin for this world".
 */

import {
  resolveWriterAuthz,
  resolveReaderAuthz,
  type Fr10Deps,
  type AuthzResolution,
} from './fr10-authz.js';
import { extractBearer } from './token-verifier.js';

export interface Writer {
  /** Actor string written to the append-only audit trail (the verified claims.sub). */
  actor: string;
  /** The substrate authz decision this write is bound to (FR-10 audit / B3). */
  authzDecisionId: string;
}

/**
 * Read gate (coarse). Returns true if the request may read config. A shared
 * service token (`x-service-token` == env `CONFIG_SERVICE_TOKEN`). When unset,
 * reads are OPEN (dev default). The per-actor FR-10 read authority is the
 * separate `resolveReaderAuthz` check (below).
 */
export function checkServiceToken(req: Request): boolean {
  const expected = process.env.CONFIG_SERVICE_TOKEN;
  if (!expected) return true; // dev default
  const provided = req.headers.get('x-service-token');
  return provided === expected;
}

/**
 * FR-10 WRITE gate. Verifies the Bearer identity token and asserts the verified
 * `claims.sub` is in the world's `admin_principals` (delegated to the substrate
 * `resolveAuthz`). Returns the `Writer` (verified actor + decision id) on grant,
 * or `null` → the caller responds 403. The any-bearer path is removed.
 *
 * `bypassCache` is set on the go_live confirm (apply-mode → LIVE) so the
 * highest-risk write is gated on a fresh allowlist read (B6).
 */
export async function resolveWriter(
  req: Request,
  worldSlug: string,
  deps: Fr10Deps,
  opts: { bypassCache?: boolean } = {},
): Promise<Writer | null> {
  const bearer = extractBearer(req.headers.get('authorization'));
  const resolution = await resolveWriterAuthz(bearer, worldSlug, deps, opts);
  if (!resolution) return null;
  return { actor: resolution.actor, authzDecisionId: resolution.authz_decision_id };
}

/**
 * FR-10 READ authority gate (B4). Verifies the Bearer token and re-checks
 * `admin_principals` via the substrate `resolveReader` (the SAME decision flow
 * as the write path), so a now-revoked admin loses READ access within the ≤10s
 * TTL. Returns the resolution (actor + claims) on grant, else `null` → 403.
 *
 * Per-CM isolation (`cm == claims.sub`) is enforced by the CALLER on top of this
 * — that is isolation, not authority.
 */
export async function resolveReaderAuthority(
  req: Request,
  worldSlug: string,
  deps: Fr10Deps,
): Promise<AuthzResolution | null> {
  const bearer = extractBearer(req.headers.get('authorization'));
  return resolveReaderAuthz(bearer, worldSlug, deps);
}
