import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';

import { ConfigService } from '@freeside-worlds/config-engine';
import type { ConfigStore } from '@freeside-worlds/config-engine';

import { makeHandler } from '../src/app.js';
import { checkWorldsApiToken } from '../src/auth.js';
import { createRegistryBridge } from '../src/manifest/registry.js';
import { handleManifestRoutes } from '../src/manifest/routes.js';
import { ManifestService, SlugCollisionError } from '../src/manifest/service.js';
import { normalizeDisplayNameToSlug, suggestAlternateSlug } from '../src/manifest/slug.js';
import { MemoryManifestStore } from '../src/manifest/store.js';
import { toPublicView } from '../src/manifest/types.js';

const ORDER_ID = '541da59c-0a31-4830-9dd3-aa9a16f30317';
const CONTRACT = '0xcccccccccccccccccccccccccccccccccccccccc';
const CHAIN = '80094';

function validInput(overrides: Partial<{
  chainId: string;
  contractAddress: string;
  displayName: string;
  contactEmail: string;
  orderId: string;
  source: string;
}> = {}) {
  return {
    chainId: CHAIN,
    contractAddress: CONTRACT,
    displayName: 'My Collection',
    contactEmail: 'cm@team.example',
    orderId: ORDER_ID,
    source: 'ordering-service',
    ...overrides,
  };
}

function validBody(overrides: Record<string, string> = {}) {
  return {
    chain_id: CHAIN,
    contract_address: CONTRACT,
    display_name: 'My Collection',
    contact_email: 'cm@team.example',
    order_id: ORDER_ID,
    source: 'ordering-service',
    ...overrides,
  };
}

const noopStore: ConfigStore = {
  getCurrent: async () => null,
  applyWrite: async () => null,
};

describe('slug normalization', () => {
  it('lowercases and hyphenates display names', () => {
    expect(normalizeDisplayNameToSlug('My Collection')).toBe('my-collection');
    expect(normalizeDisplayNameToSlug('Pythenians NFT')).toBe('pythenians-nft');
    expect(normalizeDisplayNameToSlug('  HELLO__world  ')).toBe('hello-world');
  });

  it('prefixes slugs starting with a digit', () => {
    expect(normalizeDisplayNameToSlug('123 Club')).toBe('w-123-club');
  });

  it('suggests suffixed alternates when base slug is taken', () => {
    const taken = new Set(['my-collection']);
    expect(suggestAlternateSlug('my-collection', taken)).toBe('my-collection-2');
  });
});

describe('ManifestService', () => {
  let worldsDir: string;
  let store: MemoryManifestStore;
  let service: ManifestService;

  beforeEach(() => {
    worldsDir = mkdtempSync(join(tmpdir(), 'worlds-registry-'));
    store = new MemoryManifestStore();
    service = new ManifestService({
      store,
      registry: createRegistryBridge(worldsDir),
    });
  });

  afterEach(() => {
    rmSync(worldsDir, { recursive: true, force: true });
  });

  it('creates manifest with 201 semantics (created=true)', () => {
    const { record, created } = service.createManifest(validInput());
    expect(created).toBe(true);
    expect(record.worldSlug).toBe('my-collection');
    expect(record.manifestRef).toBe('manifest_541da59c0a31');
  });

  it('returns idempotent 200 for same chain/contract/order triple', () => {
    service.createManifest(validInput());
    const second = service.createManifest(validInput());
    expect(second.created).toBe(false);
    expect(second.record.worldSlug).toBe('my-collection');
  });

  it('returns existing manifest for same contract with different order_id', () => {
    service.createManifest(validInput());
    const second = service.createManifest(validInput({ orderId: '99999999-9999-4999-8999-999999999999' }));
    expect(second.created).toBe(false);
    expect(second.record.worldSlug).toBe('my-collection');
  });

  it('auto-suffixes slug on collision with existing registry slug', () => {
    writeFileSync(
      join(worldsDir, 'my-collection.yaml'),
      'schema_version: "1.0"\nslug: my-collection\nname: X\nrepo: 0xHoneyJar/x\n',
    );
    const { record, created } = service.createManifest(validInput());
    expect(created).toBe(true);
    expect(record.worldSlug).toBe('my-collection-2');
  });

  it('lookup returns record; public view omits PII', () => {
    service.createManifest(validInput());
    const found = service.lookup(CHAIN, CONTRACT);
    expect(found?.worldSlug).toBe('my-collection');
    const pub = toPublicView(found!);
    expect(pub).not.toHaveProperty('contactEmail');
    expect(pub).not.toHaveProperty('contact_email');
  });

  it('lookup returns null for unknown contract', () => {
    expect(service.lookup(CHAIN, '0x0000000000000000000000000000000000000001')).toBeNull();
  });

  it('throws SlugCollisionError when no slug is available', () => {
    const taken = new Set<string>();
    for (let i = 0; i <= 100; i++) {
      taken.add(i === 0 ? 'my-collection' : `my-collection-${i}`);
    }
    const registry = {
      listExistingSlugs: () => taken,
      writeManifestYaml: () => '/dev/null',
    };
    const collisionService = new ManifestService({ store, registry });
    expect(() => collisionService.createManifest(validInput())).toThrow(SlugCollisionError);
  });
});

describe('manifest HTTP routes', () => {
  let worldsDir: string;
  let service: ManifestService;

  beforeEach(() => {
    worldsDir = mkdtempSync(join(tmpdir(), 'worlds-http-'));
    service = new ManifestService({
      store: new MemoryManifestStore(),
      registry: createRegistryBridge(worldsDir),
    });
    process.env.WORLDS_API_TOKEN = 'test-token';
  });

  afterEach(() => {
    rmSync(worldsDir, { recursive: true, force: true });
    delete process.env.WORLDS_API_TOKEN;
    delete process.env.SERVICE_TOKEN;
    delete process.env.CONFIG_SERVICE_TOKEN;
  });

  function authHeaders(token = 'test-token') {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  it('POST /v1/worlds/manifest returns 201 on create', async () => {
    const req = new Request('http://localhost/v1/worlds/manifest', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(validBody()),
    });
    const res = await handleManifestRoutes(req, new URL(req.url), service);
    expect(res?.status).toBe(201);
    const body = await res!.json();
    expect(body.world_slug).toBe('my-collection');
    expect(body.manifest_ref).toMatch(/^manifest_/);
    expect(body.created_at).toBeString();
  });

  it('POST /v1/worlds/manifest returns 200 on idempotent replay', async () => {
    const reqInit = {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(validBody()),
    };
    await handleManifestRoutes(new Request('http://localhost/v1/worlds/manifest', reqInit), new URL('http://localhost/v1/worlds/manifest'), service);
    const res = await handleManifestRoutes(new Request('http://localhost/v1/worlds/manifest', reqInit), new URL('http://localhost/v1/worlds/manifest'), service);
    expect(res?.status).toBe(200);
  });

  it('POST /v1/worlds/manifest returns 401 without token when configured', async () => {
    const req = new Request('http://localhost/v1/worlds/manifest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody()),
    });
    const res = await handleManifestRoutes(req, new URL(req.url), service);
    expect(res?.status).toBe(401);
  });

  it('POST /v1/worlds/manifest returns 409 on slug exhaustion', async () => {
    const taken = new Set<string>();
    for (let i = 0; i <= 100; i++) {
      taken.add(i === 0 ? 'my-collection' : `my-collection-${i}`);
    }
    const collisionService = new ManifestService({
      store: new MemoryManifestStore(),
      registry: { listExistingSlugs: () => taken, writeManifestYaml: () => '/dev/null' },
    });
    const req = new Request('http://localhost/v1/worlds/manifest', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(validBody()),
    });
    const res = await handleManifestRoutes(req, new URL(req.url), collisionService);
    expect(res?.status).toBe(409);
    const body = await res!.json();
    expect(body.error).toBe('slug_collision');
    expect(body.suggested_slug).toBeString();
  });

  it('GET /v1/worlds/lookup returns 200 after manifest create', async () => {
    await handleManifestRoutes(
      new Request('http://localhost/v1/worlds/manifest', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(validBody()),
      }),
      new URL('http://localhost/v1/worlds/manifest'),
      service,
    );
    const req = new Request(`http://localhost/v1/worlds/lookup?chain_id=${CHAIN}&contract_address=${CONTRACT}`, {
      headers: authHeaders(),
    });
    const res = await handleManifestRoutes(req, new URL(req.url), service);
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.world_slug).toBe('my-collection');
    expect(body).not.toHaveProperty('contact_email');
  });

  it('GET /v1/worlds/lookup returns 404 when missing', async () => {
    const req = new Request(`http://localhost/v1/worlds/lookup?chain_id=1&contract_address=0x0000000000000000000000000000000000000001`, {
      headers: authHeaders(),
    });
    const res = await handleManifestRoutes(req, new URL(req.url), service);
    expect(res?.status).toBe(404);
  });
});

describe('checkWorldsApiToken', () => {
  afterEach(() => {
    delete process.env.WORLDS_API_TOKEN;
    delete process.env.SERVICE_TOKEN;
    delete process.env.CONFIG_SERVICE_TOKEN;
  });

  it('accepts WORLDS_API_TOKEN bearer', () => {
    process.env.WORLDS_API_TOKEN = 'kitchen-secret';
    const req = new Request('http://localhost/', { headers: { Authorization: 'Bearer kitchen-secret' } });
    expect(checkWorldsApiToken(req)).toBe(true);
  });

  it('accepts SERVICE_TOKEN bearer alias', () => {
    process.env.SERVICE_TOKEN = 'service-secret';
    const req = new Request('http://localhost/', { headers: { Authorization: 'Bearer service-secret' } });
    expect(checkWorldsApiToken(req)).toBe(true);
  });

  it('rejects wrong bearer when token configured', () => {
    process.env.WORLDS_API_TOKEN = 'kitchen-secret';
    const req = new Request('http://localhost/', { headers: { Authorization: 'Bearer wrong' } });
    expect(checkWorldsApiToken(req)).toBe(false);
  });
});

describe('makeHandler manifest integration', () => {
  it('routes manifest requests before config 404', async () => {
    const worldsDir = mkdtempSync(join(tmpdir(), 'worlds-app-'));
    try {
      process.env.WORLDS_API_TOKEN = 'test-token';
      const handler = makeHandler({
        service: new ConfigService({ store: noopStore }),
        manifestService: new ManifestService({
          store: new MemoryManifestStore(),
          registry: createRegistryBridge(worldsDir),
        }),
      });
      const res = await handler(
        new Request('http://localhost/v1/worlds/lookup?chain_id=1&contract_address=0x1', {
          headers: { Authorization: 'Bearer test-token' },
        }),
      );
      expect(res.status).toBe(404);
    } finally {
      rmSync(worldsDir, { recursive: true, force: true });
      delete process.env.WORLDS_API_TOKEN;
    }
  });
});
