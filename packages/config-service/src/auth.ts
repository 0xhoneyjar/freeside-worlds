/**
 * Auth seam — STUB.
 *
 * C-1 ships placeholder auth so the read/write seam is exercisable end-to-end.
 * The REAL community-manager auth (CM identity, per-world authorization, the
 * freeside-auth verified path) is C-2. This file is the clear seam where C-2
 * plugs in — the HTTP handlers call these two functions and nothing else knows
 * about auth.
 *
 *   - checkServiceToken(req)  — read gate: a shared service token (header
 *     `x-service-token` must equal env CONFIG_SERVICE_TOKEN). When the env var
 *     is unset, reads are OPEN (dev default) — C-2 makes this fail-closed.
 *   - resolveWriter(req, world) — write gate: extracts a Bearer token and
 *     returns a writer identity (actor) or null (-> 403). C-1 accepts ANY
 *     non-empty Bearer and uses it verbatim as the actor string. C-2 replaces
 *     this with real JWT verification (jwks-validator) + per-world CM authz.
 */

export interface Writer {
  /** Actor string written to the append-only audit trail. */
  actor: string;
}

/** Read gate. Returns true if the request may read config. */
export function checkServiceToken(req: Request): boolean {
  const expected = process.env.CONFIG_SERVICE_TOKEN;
  // Dev default: no token configured -> reads open. C-2: fail-closed.
  if (!expected) return true;
  const provided = req.headers.get('x-service-token');
  return provided === expected;
}

/**
 * Write gate. STUB: any non-empty `Authorization: Bearer <x>` is accepted and
 * `<x>` becomes the actor. Returns null -> caller responds 403.
 *
 * SEAM FOR C-2: replace the body with
 *   1. verify the JWT via @freeside-auth/adapters/jwks-validator
 *   2. assert the CM is authorized for `worldSlug` (per-world authz)
 *   3. return { actor: claims.sub } (or a CM display id)
 */
/**
 * Kitchen manifest gate — Bearer token must match WORLDS_API_TOKEN or SERVICE_TOKEN
 * (CONFIG_SERVICE_TOKEN alias). When neither env var is set, requests are OPEN
 * (dev default — mirrors checkServiceToken fail-open posture).
 */
export function checkWorldsApiToken(req: Request): boolean {
  const worldsToken = process.env.WORLDS_API_TOKEN;
  const serviceToken = process.env.SERVICE_TOKEN ?? process.env.CONFIG_SERVICE_TOKEN;

  if (!worldsToken && !serviceToken) return true;

  const authz = req.headers.get('authorization');
  if (!authz) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authz.trim());
  if (!match) return false;
  const token = match[1]!.trim();
  if (token.length === 0) return false;

  if (worldsToken && token === worldsToken) return true;
  if (serviceToken && token === serviceToken) return true;
  return false;
}

export function resolveWriter(req: Request, _worldSlug: string): Writer | null {
  const authz = req.headers.get('authorization');
  if (!authz) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authz.trim());
  if (!match) return null;
  const token = match[1]!.trim();
  if (token.length === 0) return null;
  // C-1 placeholder: token IS the actor. C-2: derive actor from verified claims.
  return { actor: `bearer:${token.slice(0, 32)}` };
}
