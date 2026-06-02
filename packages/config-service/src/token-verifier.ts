/**
 * token-verifier.ts — the identity-token verification SEAM (FR-10, SDD §6.2/C3).
 *
 * ── GROUNDING NOTE (SDD/sprint vs repo reality) ─────────────────────────────
 * The SDD/sprint say to verify the identity-api session/svc token via the
 * "`@freeside-auth/adapters` jwks-validator pattern (LIVE)". In repo reality,
 * `@freeside-auth/adapters` is NOT a dependency of freeside-worlds and there is
 * no `jose`/`jwks`/`jsonwebtoken` library available in the workspace (verified
 * at build time). Per the dispatch's 403.3 instruction ("ELSE implement a
 * `TokenVerifier` port + a working test impl and FLAG the live-jwks wiring as a
 * deploy step, like the events git-pin"), this module defines the port + a
 * deterministic test impl, and the LIVE JWKS Layer is a documented DEPLOY STEP
 * (see `makeJwksTokenVerifier` stub + README/runbook note).
 *
 * ── The FR-10 floor is NON-NEGOTIABLE ───────────────────────────────────────
 * The any-bearer stub is GONE. `resolveWriter`/`resolveReader` (fr10-authz.ts)
 * REQUIRE a verified `claims.sub` AND an `admin_principals` membership check. If
 * NO verifier is configured, the write/read path is FAIL-CLOSED (every write is
 * 403) — never fail-open to any-bearer. A token that does not verify yields
 * `null` claims → 403.
 */

/** The verified token claims the FR-10 authz flow consumes. */
export interface VerifiedClaims {
  /** identity-api user_id (claims.sub) — the actor for authz + audit. */
  readonly sub: string;
  /** key id the token was signed with (for AuthzContext.token_metadata). */
  readonly kid: string;
  /** ISO timestamp the token was verified at. */
  readonly verified_at: string;
  /** ISO timestamp the token expires (for AuthzContext.token_metadata). */
  readonly exp: string;
}

/**
 * The token-verification port. `verify` takes the raw Bearer token value (the
 * part AFTER `Bearer `) and returns the verified claims, or `null` if the token
 * is absent/malformed/unverifiable. NEVER throws — an unverifiable token is a
 * `null` return (mapped to 403 upstream), so a verifier failure can never
 * accidentally fail-open.
 */
export interface TokenVerifier {
  verify(rawToken: string): Promise<VerifiedClaims | null>;
}

/**
 * FAIL-CLOSED default verifier — every token is rejected (returns `null`). This
 * is the production default UNTIL the LIVE JWKS verifier is wired (deploy step).
 * It guarantees the FR-10 floor: with no verifier configured, NO write is ever
 * authorized (the opposite of the old any-bearer stub, which authorized ALL).
 */
export class RejectingTokenVerifier implements TokenVerifier {
  async verify(_rawToken: string): Promise<VerifiedClaims | null> {
    return null;
  }
}

/**
 * Test/dev verifier backed by a fixed token→claims map. Deterministic: a token
 * present in the map verifies to its claims; anything else returns `null`. Used
 * by the integration tests (403.5) to exercise grant/deny/revocation without a
 * live JWKS endpoint. NOT for production (it trusts a static map, not a signed
 * token) — production uses the LIVE JWKS verifier (deploy step).
 */
export class MapTokenVerifier implements TokenVerifier {
  private readonly map: ReadonlyMap<string, VerifiedClaims>;
  constructor(entries: Readonly<Record<string, VerifiedClaims>>) {
    this.map = new Map(Object.entries(entries));
  }
  async verify(rawToken: string): Promise<VerifiedClaims | null> {
    return this.map.get(rawToken) ?? null;
  }
}

/**
 * LIVE JWKS token verifier — the DEPLOY-STEP seam (flagged, not wired here).
 *
 * When `@freeside-auth/adapters` (the jwks-validator) becomes a consumable
 * dependency of freeside-worlds — OR a `jose`-backed JWKS client is added — this
 * factory wires the real verifier: fetch the identity-api JWKS, verify the
 * token's ES256 signature against the `svc-`/session kid, check `exp`, and
 * return `{ sub, kid, verified_at, exp }`. Until then it THROWS at construction
 * so a deploy that forgets to wire it fails loud rather than silently
 * fail-closed-everywhere or (worse) fail-open.
 *
 * Deploy step (documented in the config-service README / cycle runbook):
 *   1. add the JWKS client dependency to config-service.
 *   2. set `IDENTITY_JWKS_URL` (the identity-api JWKS endpoint).
 *   3. replace `RejectingTokenVerifier` with `makeJwksTokenVerifier({ jwksUrl })`
 *      in server.ts's composition root.
 */
export function makeJwksTokenVerifier(_opts: { jwksUrl: string }): TokenVerifier {
  throw new Error(
    'makeJwksTokenVerifier: LIVE JWKS verification is a DEPLOY STEP not yet wired ' +
      '(@freeside-auth/adapters / a jose JWKS client is not a config-service dependency). ' +
      'See token-verifier.ts deploy-step note. Until wired, use RejectingTokenVerifier ' +
      '(fail-closed) in production or MapTokenVerifier in tests.',
  );
}

/** Extract the raw Bearer token value from an `Authorization` header, or null. */
export function extractBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return null;
  const token = match[1]!.trim();
  return token.length === 0 ? null : token;
}
