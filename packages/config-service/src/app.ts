/**
 * Config service HTTP app — the read/write seam.
 *
 * Routes:
 *   GET  /v1/config/:world/:surface[?cm=<id>]  -> 200 {envelope, version} | 404 | 401 | 403
 *   PUT  /v1/config/:world/:surface[?cm=<id>]  -> 200 {envelope, version} | 409 | 403 | 400/422
 *   GET  /health                               -> 200 (ECS health check)
 *
 * fail-soft read: 404 means "never configured" — the CALLER uses its defaults.
 * fail-closed write: invalid payload -> 422; version conflict -> 409.
 *
 * ── S2 (shadow-onboarding-substrate) ────────────────────────────────────────
 *   • FR-10 floor (C3, closes R-3): the any-bearer write stub is GONE. PUT
 *     requires a verified identity token whose `claims.sub ∈ admin_principals`
 *     (delegated to the substrate `resolveAuthz`). GET on the authority-bearing
 *     surfaces (role-map/apply-mode/onboarding-lifecycle) re-checks the SAME
 *     decision (B4 — a revoked admin loses READ within the ≤10s TTL).
 *   • Per-CM isolation: the `onboarding-lifecycle` surface is keyed
 *     `(world, surface, cm_identity_id)`; the `cm` query param MUST equal the
 *     authenticated `claims.sub` (else 403 — isolation, not authority), and the
 *     engine read/write threads `cm` as the per-CM sub-key.
 *   • go_live freshness (B6): a PUT to `apply-mode` flipping to LIVE re-checks
 *     authz FRESH (bypassCache) — the highest-risk write is never gated on a
 *     cached grant.
 *
 * DEFERRED (follow-ups): GET history, POST restore, by-guild lookup, LIVE JWKS
 * verifier wiring (see token-verifier.ts deploy-step note).
 */

import { ConfigService } from '@freeside-worlds/config-engine';
import {
  ConfigValidationError,
  ConfigVersionConflictError,
} from '@freeside-worlds/config-engine';
import type { Surface, SurfaceConfigMap } from '@freeside-worlds/config-protocol';
import { KNOWN_SURFACES } from '@freeside-worlds/config-protocol';
import {
  checkServiceToken,
  resolveWriter,
  resolveReaderAuthority,
} from './auth.js';
import type { Fr10Deps } from './fr10-authz.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// /v1/config/:world/:surface
const ROUTE = /^\/v1\/config\/([a-z][a-z0-9-]{1,20})\/([a-z][a-z0-9-]*)$/;

function isKnownSurface(s: string): s is Surface {
  return (KNOWN_SURFACES as readonly string[]).includes(s);
}

/**
 * The surface is PER-CM (composite-keyed) — the `cm` query param is required and
 * must equal the authenticated `claims.sub`.
 */
const PER_CM_SURFACE: Surface = 'onboarding-lifecycle';

/**
 * Surfaces whose READ requires FR-10 authority (B4) — a verified actor still in
 * `admin_principals`. `verify-message` is intentionally EXCLUDED: it is
 * CM-editable display content, not authority-bearing, and its pre-S2
 * service-token-read precedent is preserved (additive, no behavior change).
 */
const READ_AUTHORITY_SURFACES: ReadonlySet<Surface> = new Set<Surface>([
  'role-map',
  'apply-mode',
  'onboarding-lifecycle',
]);

export interface AppDeps {
  service: ConfigService;
  /** FR-10 deps (token verifier + allowlist Layer + audit emitter Layer). */
  fr10: Fr10Deps;
}

/** Build the fetch handler. Pure over deps so tests inject a memory-backed service. */
export function makeHandler(deps: AppDeps): (req: Request) => Promise<Response> {
  const { service, fr10 } = deps;

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true });
    }

    const match = ROUTE.exec(url.pathname);
    if (!match) {
      return json({ error: 'not_found' }, 404);
    }
    const worldSlug = match[1]!;
    const surfaceRaw = match[2]!;

    if (!isKnownSurface(surfaceRaw)) {
      return json({ error: 'unknown_surface', surface: surfaceRaw, known: KNOWN_SURFACES }, 404);
    }
    const surface: Surface = surfaceRaw;
    const cmParam = url.searchParams.get('cm');

    // The per-CM surface REQUIRES the `cm` query param (the composite sub-key).
    if (surface === PER_CM_SURFACE && !cmParam) {
      return json(
        { error: 'bad_request', detail: 'onboarding-lifecycle requires a ?cm=<cm_identity_id> query param' },
        400,
      );
    }
    const cmIdentityId = surface === PER_CM_SURFACE ? cmParam : null;

    // ─── READ ──────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      // Coarse read gate (shared service token).
      if (!checkServiceToken(req)) {
        return json({ error: 'unauthorized' }, 401);
      }

      // FR-10 read AUTHORITY (B4) for the authority-bearing surfaces: a verified
      // actor still in admin_principals. A revoked admin loses READ within the TTL.
      if (READ_AUTHORITY_SURFACES.has(surface)) {
        const reader = await resolveReaderAuthority(req, worldSlug, fr10);
        if (!reader) {
          return json({ error: 'forbidden' }, 403);
        }
        // Per-CM ISOLATION (not authority): a CM may only read their OWN
        // lifecycle record — the `cm` param MUST equal the authenticated actor.
        if (surface === PER_CM_SURFACE && cmIdentityId !== reader.actor) {
          return json({ error: 'forbidden', detail: 'cm does not match authenticated identity' }, 403);
        }
      }

      const result = await service.getConfig(worldSlug, surface, cmIdentityId);
      if (!result) {
        // fail-soft: caller uses defaults.
        return json({ error: 'not_configured', world: worldSlug, surface }, 404);
      }
      return json({
        envelope: result.envelope,
        version: result.version,
        updated_at: result.updatedAt,
      });
    }

    // ─── WRITE ─────────────────────────────────────────────────────────
    if (req.method === 'PUT') {
      let parsed: unknown;
      try {
        parsed = await req.json();
      } catch {
        return json({ error: 'invalid_json' }, 400);
      }

      const body = parsed as {
        config?: unknown;
        expected_version?: unknown;
        reason?: unknown;
      };
      if (body.config === undefined || typeof body.expected_version !== 'number') {
        return json(
          { error: 'bad_request', detail: 'body requires { config, expected_version:number, reason? }' },
          400,
        );
      }

      // go_live freshness (B6): a flip of apply-mode to LIVE is the highest-risk
      // write — re-check authz FRESH (bypassCache), never on a cached grant.
      const isGoLive =
        surface === 'apply-mode' &&
        typeof (body.config as { apply_mode?: unknown }).apply_mode === 'string' &&
        (body.config as { apply_mode?: unknown }).apply_mode === 'LIVE';

      // FR-10 WRITE gate (the floor): verified claims.sub ∈ admin_principals.
      const writer = await resolveWriter(req, worldSlug, fr10, { bypassCache: isGoLive });
      if (!writer) {
        return json({ error: 'forbidden' }, 403);
      }

      // Per-CM ISOLATION: a CM may only write their OWN lifecycle record — the
      // `cm` param MUST equal the authenticated actor (claims.sub). 403 else.
      if (surface === PER_CM_SURFACE && cmIdentityId !== writer.actor) {
        return json({ error: 'forbidden', detail: 'cm does not match authenticated identity' }, 403);
      }

      try {
        const ok = await service.putConfig(
          worldSlug,
          surface,
          body.config as SurfaceConfigMap[typeof surface],
          body.expected_version,
          writer.actor,
          typeof body.reason === 'string' ? body.reason : undefined,
          cmIdentityId,
        );
        return json({ envelope: ok.envelope, version: ok.version, record_id: ok.recordId });
      } catch (err) {
        if (err instanceof ConfigVersionConflictError) {
          return json(
            {
              error: 'version_conflict',
              expected: err.expected,
              actual: err.actual,
            },
            409,
          );
        }
        if (err instanceof ConfigValidationError) {
          return json({ error: 'validation_failed', issues: err.issues }, 422);
        }
        throw err;
      }
    }

    return json({ error: 'method_not_allowed' }, 405);
  };
}
