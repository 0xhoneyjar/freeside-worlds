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
  ConfigKeyError,
  ConfigValidationError,
  ConfigVersionConflictError,
  ConfigTenantIsolationError,
} from '@freeside-worlds/config-engine';
import type { WriteProvenance } from '@freeside-worlds/config-engine';
import type { Surface, SurfaceConfigMap } from '@freeside-worlds/config-protocol';
import { KNOWN_SURFACES, PER_CM_SURFACES } from '@freeside-worlds/config-protocol';
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
 * must equal the authenticated `claims.sub`. Driven by the PROTOCOL-LEVEL
 * `PER_CM_SURFACES` set (config-protocol) so the HTTP guard and the engine key
 * guard share ONE source (FAGAN iter-3 cleanup — a new per-CM surface can't be
 * half-wired).
 */
function isPerCmSurface(surface: Surface): boolean {
  return PER_CM_SURFACES.has(surface);
}

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

/**
 * cycle-010 (sprint T1.7 · SDD §6 · /fagan R2 MAJOR) — the three roles-as-code
 * world-keyed surfaces. A write to ANY of these MUST carry complete write
 * provenance (audit subject), else it is rejected 400. The 4 legacy surfaces
 * (verify-message/role-map/apply-mode/onboarding-lifecycle) keep their pre-S2
 * behavior (no provenance required). This is the enforcement boundary: provenance
 * was buildable-but-optional before, so a provenance-less roster-commit could
 * land with NO audit subject — defeating T1.7.
 */
const ROLES_AS_CODE_SURFACES: ReadonlySet<Surface> = new Set<Surface>([
  'roster-commit',
  'resolution-ledger',
  'pending-apply',
]);

/**
 * Per-CM ISOLATION check (NOT authority) — shared by the read AND write paths
 * (DRY: one place keeps them aligned). For the per-CM surface a CM may only
 * touch their OWN record: the `cm` query param MUST equal the authenticated
 * actor (`claims.sub`). Returns true when isolation is satisfied (or the surface
 * is not per-CM); false → the caller responds 403.
 */
function cmIsolationOk(surface: Surface, cmIdentityId: string | null, actor: string): boolean {
  if (!isPerCmSurface(surface)) return true;
  return cmIdentityId === actor;
}

/** Result of building provenance: ok-with-value (or undefined for legacy), or a 400-bearing reject. */
type ProvenanceResult =
  | { ok: true; provenance: WriteProvenance | undefined }
  | { ok: false; detail: string };

/**
 * cycle-010 (sprint T1.7 · SDD §6 · /fagan R2 MAJOR) provenance builder +
 * ENFORCER. The `actor` is the SERVER's authenticated CM (never the body) and
 * `ts` is server time, so the audit subject's who/when cannot be forged by the
 * request body. The service-bound fields (service_identity, plan_id|apply_id,
 * fencing_token) are caller-supplied (they describe the bot + the apply
 * transaction); they are length-bounded defensively before stamping.
 *
 * ENFORCEMENT (the /fagan R2 fix): for a ROLES-AS-CODE surface, complete
 * provenance is MANDATORY — a write missing it is REJECTED (`ok:false`, the
 * caller returns HTTP 400 `invalid_provenance`). A roles-as-code write is
 * rejected when: the block is missing/not-an-object, OR `service_identity` is
 * missing, OR BOTH `plan_id` and `apply_id` are missing (every roles-as-code
 * write belongs to a plan OR an apply), OR `fencing_token` is missing (the
 * lease-CAS token). For a LEGACY surface, provenance stays OPTIONAL — absent ⇒
 * `ok:true` with `provenance: undefined` (pre-S2 behavior, unchanged).
 */
function buildProvenance(
  raw:
    | {
        service_identity?: unknown;
        plan_id?: unknown;
        apply_id?: unknown;
        fencing_token?: unknown;
      }
    | undefined,
  actor: string,
  surface: Surface,
): ProvenanceResult {
  const required = ROLES_AS_CODE_SURFACES.has(surface);

  if (raw === undefined || raw === null || typeof raw !== 'object') {
    if (required) {
      return { ok: false, detail: `surface '${surface}' requires a provenance block { service_identity, plan_id|apply_id, fencing_token }` };
    }
    return { ok: true, provenance: undefined }; // legacy: absent is fine.
  }

  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : undefined;
  const service_identity = str(raw.service_identity);
  const plan_id = str(raw.plan_id);
  const apply_id = str(raw.apply_id);
  const fencing_token = str(raw.fencing_token);

  if (required) {
    if (service_identity === undefined) {
      return { ok: false, detail: 'provenance.service_identity is required (non-empty string)' };
    }
    if (plan_id === undefined && apply_id === undefined) {
      return { ok: false, detail: 'provenance requires at least one of plan_id / apply_id' };
    }
    if (fencing_token === undefined) {
      return { ok: false, detail: 'provenance.fencing_token is required (the world-lease CAS token)' };
    }
  } else if (service_identity === undefined) {
    // legacy surface with a partial/empty provenance block → treat as none
    // (additive — never invents one, never rejects a legacy write on this).
    return { ok: true, provenance: undefined };
  }

  return {
    ok: true,
    provenance: {
      service_identity: service_identity!,
      actor,
      ...(plan_id !== undefined ? { plan_id } : {}),
      ...(apply_id !== undefined ? { apply_id } : {}),
      ...(fencing_token !== undefined ? { fencing_token } : {}),
      ts: new Date().toISOString(),
    },
  };
}

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
    const cmParamRaw = url.searchParams.get('cm');
    // Normalize at the HTTP boundary so the presence check matches the engine's
    // `isMissingCmKey` semantics (null/empty/WHITESPACE-only all count as
    // missing). A whitespace-only `?cm=%20%20` must NOT pass through as a
    // "present" key — it would otherwise either fail the isolation check oddly
    // or be threaded as a garbage composite sub-key. We trim, and the trimmed
    // value is what we thread to the engine + compare for isolation.
    const cmParam = cmParamRaw === null ? null : cmParamRaw.trim();
    const cmParamMissing = cmParam === null || cmParam.length === 0;

    // The per-CM surface REQUIRES a non-blank `cm` query param (the composite
    // sub-key). Missing OR whitespace-only → 400 (mirrors isMissingCmKey).
    if (isPerCmSurface(surface) && cmParamMissing) {
      return json(
        { error: 'bad_request', detail: 'onboarding-lifecycle requires a non-empty ?cm=<cm_identity_id> query param' },
        400,
      );
    }
    const cmIdentityId = isPerCmSurface(surface) ? cmParam : null;

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
        if (!cmIsolationOk(surface, cmIdentityId, reader.actor)) {
          return json({ error: 'forbidden', detail: 'cm does not match authenticated identity' }, 403);
        }
      }

      let result;
      try {
        result = await service.getConfig(worldSlug, surface, cmIdentityId);
      } catch (err) {
        if (err instanceof ConfigKeyError) {
          // engine fail-closed on a missing per-CM key (defense-in-depth; the
          // HTTP ?cm= guard above normally catches this first).
          return json({ error: 'bad_request', detail: err.message }, 400);
        }
        throw err;
      }
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
      // PHASE 1 — FLOOR AUTH BEFORE THE BODY READ (FAGAN iter-2 fix). The
      // earlier code parsed `req.json()` + ran 400/422 schema validation BEFORE
      // resolveWriter — an unauthenticated PUT got parsed/probed before the auth
      // gate. We now verify the token + the admin_principals grant FIRST: an
      // anonymous/unauthorized PUT is rejected before any body parse or schema
      // work. (DELIBERATE TIGHTENING — verify-message WRITE: pre-S2 a
      // verify-message PUT was accepted on any-bearer; S2 routes ALL writes,
      // including verify-message, through the FR-10 floor [resolveWriter →
      // admin_principals]. Relaxing verify-message to a verified-CM-for-world
      // model, distinct from admin_principals, is a future PRODUCT decision,
      // deliberately deferred. verify-message READ stays on the service-token path.)
      const floorWriter = await resolveWriter(req, worldSlug, fr10);
      if (!floorWriter) {
        return json({ error: 'forbidden' }, 403);
      }
      // Per-CM ISOLATION (floor): a CM may only write their OWN lifecycle record
      // — the `cm` param MUST equal the authenticated actor. Enforced before the
      // body read too (isolation is independent of payload content).
      if (!cmIsolationOk(surface, cmIdentityId, floorWriter.actor)) {
        return json({ error: 'forbidden', detail: 'cm does not match authenticated identity' }, 403);
      }

      // Body read + schema-shape validation happen ONLY after the floor gate.
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
        /**
         * cycle-010 (sprint T1.7 · SDD §6): caller-supplied write provenance for
         * roles-as-code world-keyed writes. The bot sends {service_identity,
         * plan_id|apply_id, fencing_token}; the SERVER stamps `actor` (the
         * authenticated CM) + `ts` so neither can be forged by the body.
         */
        provenance?: {
          service_identity?: unknown;
          plan_id?: unknown;
          apply_id?: unknown;
          fencing_token?: unknown;
        };
      };
      if (body.config === undefined || typeof body.expected_version !== 'number') {
        return json(
          { error: 'bad_request', detail: 'body requires { config, expected_version:number, reason? }' },
          400,
        );
      }

      // PHASE 2 — go_live freshness (B6). A flip of apply-mode to LIVE is the
      // highest-risk write — the floor grant above may be cached, so re-check
      // authz FRESH (bypassCache), never on a cached grant. The go-live decision
      // needs `apply_mode` from the body, hence the second phase after the parse.
      const isGoLive =
        surface === 'apply-mode' &&
        typeof (body.config as { apply_mode?: unknown }).apply_mode === 'string' &&
        (body.config as { apply_mode?: unknown }).apply_mode === 'LIVE';

      let writer = floorWriter;
      if (isGoLive) {
        const freshWriter = await resolveWriter(req, worldSlug, fr10, { bypassCache: true });
        if (!freshWriter) {
          return json({ error: 'forbidden' }, 403);
        }
        // (No per-CM isolation re-check: apply-mode is not a per-CM surface.)
        writer = freshWriter;
      }

      // cycle-010 (sprint T1.7 · SDD §6 · /fagan R2): build + ENFORCE write
      // provenance. The actor is the authenticated CM (never the body) and `ts`
      // is server time — so a body cannot forge who/when. For a ROLES-AS-CODE
      // surface complete provenance is MANDATORY (reject 400 invalid_provenance);
      // legacy surfaces keep optional provenance (absent ⇒ undefined).
      const provResult = buildProvenance(body.provenance, writer.actor, surface);
      if (!provResult.ok) {
        return json({ error: 'invalid_provenance', detail: provResult.detail }, 400);
      }
      const provenance = provResult.provenance;

      try {
        const ok = await service.putConfig(
          worldSlug,
          surface,
          body.config as SurfaceConfigMap[typeof surface],
          body.expected_version,
          writer.actor,
          typeof body.reason === 'string' ? body.reason : undefined,
          cmIdentityId,
          provenance,
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
        if (err instanceof ConfigTenantIsolationError) {
          // cross-world write (payload world != path/authorized world) — 403.
          return json({ error: 'forbidden', detail: 'payload world does not match the authorized world' }, 403);
        }
        if (err instanceof ConfigValidationError) {
          return json({ error: 'validation_failed', issues: err.issues }, 422);
        }
        if (err instanceof ConfigKeyError) {
          // engine fail-closed on a missing per-CM key (defense-in-depth).
          return json({ error: 'bad_request', detail: err.message }, 400);
        }
        throw err;
      }
    }

    return json({ error: 'method_not_allowed' }, 405);
  };
}
