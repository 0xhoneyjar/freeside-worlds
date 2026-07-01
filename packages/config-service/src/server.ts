#!/usr/bin/env bun
/**
 * server.ts — config service entrypoint.
 *
 * Wires PgConfigStore (freeside-worlds' OWN database) -> ConfigService -> the
 * HTTP handler -> Bun.serve. This is the production composition root.
 *
 * Env:
 *   DATABASE_URL          freeside-worlds OWN Postgres (ISOLATION: never a
 *                         world DB / identity spine). Required.
 *   PORT                  listen port (default 3000 — matches the world module).
 *   CONFIG_SERVICE_TOKEN  read-gate shared token (unset -> reads open in dev).
 *   WORLDS_API_TOKEN      kitchen manifest API bearer (POST /v1/worlds/manifest).
 *   SERVICE_TOKEN         alias accepted for manifest routes (falls back to
 *                         CONFIG_SERVICE_TOKEN when unset).
 *   WORLDS_REGISTRY_DIR     override path to packages/registry/worlds (default).
 *   MANIFEST_INDEX_PATH     override kitchen idempotency index JSON path.
 *
 * Run: DATABASE_URL=postgres://... bun packages/config-service/src/server.ts
 */
import { ConfigService } from '@freeside-worlds/config-engine';
import { PgConfigStore, type PgPoolLike } from '@freeside-worlds/config-adapters';
import { makeHandler } from './app.js';
import { createRegistryBridge } from './manifest/registry.js';
import { ManifestService } from './manifest/service.js';
import { createManifestStore } from './manifest/store.js';

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

  const handle = makeHandler({
    service,
    manifestService: new ManifestService({
      store: createManifestStore(),
      registry: createRegistryBridge(),
    }),
  });
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
