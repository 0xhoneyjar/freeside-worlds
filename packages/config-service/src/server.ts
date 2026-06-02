#!/usr/bin/env bun
/**
 * server.ts — config service entrypoint.
 *
 * Wires PgConfigStore (freeside-worlds' OWN database) -> ConfigService + the
 * FR-10 authorization deps -> the HTTP handler -> Bun.serve. The production
 * composition root.
 *
 * Env:
 *   DATABASE_URL          freeside-worlds OWN Postgres (ISOLATION: never a
 *                         world DB / identity spine). Required.
 *   PORT                  listen port (default 3000 — matches the world module).
 *   CONFIG_SERVICE_TOKEN  coarse read-gate shared token (unset -> reads open in dev).
 *   ADMIN_PRINCIPALS_JSON FR-10 allowlist source — a JSON object mapping
 *                         world_slug -> [identity_id,...]. The MVP read path for
 *                         `admin_principals` until the registry-YAML read wires
 *                         (DEPLOY STEP — see WorldManifestReader). Unknown world
 *                         -> [] -> every actor denied (fail-closed).
 *
 * ── FR-10 DEPLOY STEPS (flagged, NOT wired here) ────────────────────────────
 *   1. LIVE token verifier: replace `RejectingTokenVerifier` (fail-closed) with
 *      `makeJwksTokenVerifier({ jwksUrl: IDENTITY_JWKS_URL })` once a JWKS client
 *      (@freeside-auth/adapters or jose) is a config-service dependency. Until
 *      then EVERY write is 403 (the floor never fails open to any-bearer).
 *   2. LIVE allowlist: replace the ADMIN_PRINCIPALS_JSON map reader with a
 *      registry-YAML reader (read `admin_principals` from purupuru.yaml etc.).
 *   3. LIVE audit emitter: replace the recording emitter with the NATS+Ed25519
 *      `@0xhoneyjar/events` emitter (S4) so `shadow.authz.decided.v1` is signed.
 *
 * Run: DATABASE_URL=postgres://... bun packages/config-service/src/server.ts
 */
import { ConfigService } from '@freeside-worlds/config-engine';
import { PgConfigStore, type PgPoolLike } from '@freeside-worlds/config-adapters';
import { makeHandler } from './app.js';
import { RejectingTokenVerifier } from './token-verifier.js';
import {
  MapWorldManifestReader,
  makeAdminAllowlistLayer,
  makeRecordingAuthzEmitterLayer,
  type Fr10Deps,
} from './fr10-authz.js';

/** Parse the ADMIN_PRINCIPALS_JSON env map (MVP read path; deploy step replaces). */
function loadAllowlistMap(): Record<string, ReadonlyArray<string>> {
  const raw = process.env.ADMIN_PRINCIPALS_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, ReadonlyArray<string>>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    console.warn('ADMIN_PRINCIPALS_JSON is not valid JSON — treating as empty (all writes denied).');
    return {};
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL required (freeside-worlds OWN database).');
    process.exit(1);
  }

  // `pg` imported dynamically so app.ts / handler tests don't pull it in.
  // Typed via the ambient shim in config-adapters/src/pg-shim.d.ts (no
  // @types/pg dependency). Real `pg.Pool` satisfies PgPoolLike at runtime.
  const pg = await import('pg');
  const pool = new pg.Pool({ connectionString: url }) as unknown as PgPoolLike;

  const store = new PgConfigStore(pool);
  const service = new ConfigService({
    store,
    logger: {
      info: (o, m) => console.log(JSON.stringify({ level: 'info', msg: m, ...((o as object) ?? {}) })),
      warn: (o, m) => console.warn(JSON.stringify({ level: 'warn', msg: m, ...((o as object) ?? {}) })),
      error: (o, m) => console.error(JSON.stringify({ level: 'error', msg: m, ...((o as object) ?? {}) })),
    },
  });

  // FR-10 deps. PRODUCTION DEFAULT is fail-closed: RejectingTokenVerifier means
  // NO write is authorized until the LIVE JWKS verifier is wired (deploy step 1).
  const fr10: Fr10Deps = {
    verifier: new RejectingTokenVerifier(),
    allowlistLayer: makeAdminAllowlistLayer(new MapWorldManifestReader(loadAllowlistMap())),
    emitterLayer: makeRecordingAuthzEmitterLayer((e) =>
      console.log(JSON.stringify({ level: 'info', msg: 'authz.decided', event_type: e.event_type, payload: e.payload })),
    ),
  };

  const handle = makeHandler({ service, fr10 });
  const port = Number(process.env.PORT ?? 3000);

  // Bun global — typed via @types/bun in the workspace devDeps.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Bun = (globalThis as any).Bun;
  if (!Bun?.serve) {
    console.error('This entrypoint requires the Bun runtime.');
    process.exit(1);
  }

  Bun.serve({ port, fetch: handle });
  console.log(`config-service listening on :${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
