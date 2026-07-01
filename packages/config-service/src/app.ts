/**
 * Config service HTTP app — the read/write seam.
 *
 * The FIRST runtime in freeside-worlds (the repo was schema/registry only).
 * Minimal Bun-native HTTP (no framework — matches the repo's zero-runtime-dep
 * posture; Hyper was considered but freeside-worlds has no Hyper dependency and
 * adding one for two routes is over-engineering for C-1).
 *
 * Routes:
 *   GET  /v1/config/:world/:surface  -> 200 {envelope, version} | 404 | 401
 *   PUT  /v1/config/:world/:surface  -> 200 {envelope, version} | 409 | 403 | 400/422
 *   POST /v1/worlds/manifest         -> 201 | 200 (idempotent) | 409 | 401 | 422
 *   GET  /v1/worlds/lookup           -> 200 | 404 | 401 (kitchen re-probe worker)
 *   GET  /health                     -> 200 (ECS health check)
 *
 * fail-soft read: 404 means "never configured" — the CALLER uses its defaults.
 * fail-closed write: invalid payload -> 422; version conflict -> 409.
 *
 * DEFERRED (follow-ups, noted as TODO):
 *   - GET history (the config_record trail)
 *   - POST restore (re-point head at a prior record; RESTORE action reserved)
 *   - by-guild lookup (resolve world from a Discord guild_id via the manifest)
 *   - real CM auth (C-2) — see auth.ts seam.
 */

import { ConfigService } from '@freeside-worlds/config-engine';
import {
  ConfigValidationError,
  ConfigVersionConflictError,
} from '@freeside-worlds/config-engine';
import type { Surface, SurfaceConfigMap } from '@freeside-worlds/config-protocol';
import { KNOWN_SURFACES } from '@freeside-worlds/config-protocol';
import { checkServiceToken, resolveWriter } from './auth.js';
import { handleManifestRoutes } from './manifest/routes.js';
import type { ManifestService } from './manifest/service.js';

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

export interface AppDeps {
  service: ConfigService;
  manifestService?: ManifestService;
}

/** Build the fetch handler. Pure over deps so tests inject a memory-backed service. */
export function makeHandler(deps: AppDeps): (req: Request) => Promise<Response> {
  const { service, manifestService } = deps;

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true });
    }

    if (manifestService) {
      const manifestResponse = await handleManifestRoutes(req, url, manifestService);
      if (manifestResponse) return manifestResponse;
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

    // ─── READ ──────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (!checkServiceToken(req)) {
        return json({ error: 'unauthorized' }, 401);
      }
      const result = await service.getConfig(worldSlug, surface);
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
      const writer = resolveWriter(req, worldSlug);
      if (!writer) {
        return json({ error: 'forbidden' }, 403);
      }

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

      try {
        const ok = await service.putConfig(
          worldSlug,
          surface,
          body.config as SurfaceConfigMap[typeof surface],
          body.expected_version,
          writer.actor,
          typeof body.reason === 'string' ? body.reason : undefined,
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
