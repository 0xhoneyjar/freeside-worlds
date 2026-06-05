/**
 * roles-as-code-seam.test.ts — cycle-010 (Roles-as-Code) S1 HTTP-seam tests.
 * Exercises the three NET-NEW surfaces end-to-end over the config-service app:
 *   - roster-commit / resolution-ledger / pending-apply round-trip PUT→GET under
 *     the FR-10 floor (admin_principals) + the optimistic-lock version;
 *   - tenant isolation: a payload `world` != the path/authorized world → 403;
 *   - write provenance: the bot's provenance block flows into the history row
 *     (server stamps actor + ts).
 *
 * Mirrors fr10-config-seam.test.ts harness (MapTokenVerifier + MutableAllowlist).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { ConfigService } from '@freeside-worlds/config-engine';
import { MemoryConfigStore } from '@freeside-worlds/config-adapters';
import { computeRosterCommitId, type RosterCommitContent } from '@freeside-worlds/config-protocol';
import type { ShadowEvent } from '@freeside-worlds/shadow-substrate';
import { makeHandler } from '../src/app.js';
import { MapTokenVerifier, type VerifiedClaims } from '../src/token-verifier.js';
import {
  makeAdminAllowlistLayer,
  makeRecordingAuthzEmitterLayer,
  type Fr10Deps,
  type WorldManifestReader,
} from '../src/fr10-authz.js';

const ALICE = '11111111-1111-4111-8111-111111111111';

function claimsFor(sub: string): VerifiedClaims {
  return { sub, kid: 'svc-test', verified_at: '2026-06-08T00:00:00.000Z', exp: '2030-01-01T00:00:00.000Z' };
}

class MutableAllowlist implements WorldManifestReader {
  private map = new Map<string, string[]>();
  set(world: string, principals: string[]) {
    this.map.set(world, [...principals]);
  }
  async adminPrincipals(world: string): Promise<ReadonlyArray<string>> {
    return this.map.get(world) ?? [];
  }
}

interface Harness {
  handle: (req: Request) => Promise<Response>;
  store: MemoryConfigStore;
  events: ShadowEvent[];
}

function makeHarness(): Harness {
  const store = new MemoryConfigStore();
  const service = new ConfigService({ store });
  const allowlist = new MutableAllowlist();
  // Alice is admin for BOTH worlds (so a cross-tenant attempt is an isolation
  // failure, not merely an authority failure — the test isolates the right gate).
  allowlist.set('purupuru', [ALICE]);
  allowlist.set('mibera', [ALICE]);
  const events: ShadowEvent[] = [];
  const fr10: Fr10Deps = {
    verifier: new MapTokenVerifier({ 'tok-alice': claimsFor(ALICE) }),
    allowlistLayer: makeAdminAllowlistLayer(allowlist, { ttlMs: 0 }),
    emitterLayer: makeRecordingAuthzEmitterLayer((e) => events.push(e)),
  };
  return { handle: makeHandler({ service, fr10 }), store, events };
}

function putBody(world: string, surface: string, body: unknown, token = 'tok-alice'): Request {
  return new Request(`http://x/v1/config/${world}/${surface}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
function get(world: string, surface: string, token = 'tok-alice'): Request {
  return new Request(`http://x/v1/config/${world}/${surface}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
}

/** A complete provenance block (mandatory for roles-as-code surfaces, /fagan R2). */
function validProvenance(): Record<string, unknown> {
  return { service_identity: 'bot:purupuru', apply_id: 'ap_1', fencing_token: 'lease-7' };
}

function commitFor(world: string): Record<string, unknown> {
  const content: RosterCommitContent = {
    parent_commit_id: null,
    world,
    ts: '2026-06-05T00:00:00.000Z',
    applied_by: ALICE,
    theme_id: 'default',
    ownership_map: { 'pp:sov': 'freeside' },
    role_definitions: [],
    membership: [],
    status: 'complete',
  };
  return { commit_id: computeRosterCommitId(content), ...content };
}

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});

describe('roles-as-code surfaces · HTTP round-trip (FR-10 floor)', () => {
  test('roster-commit PUT (admin) → 200, GET returns it', async () => {
    const created = await h.handle(putBody('purupuru', 'roster-commit', { config: commitFor('purupuru'), expected_version: 0, provenance: validProvenance() }));
    expect(created.status).toBe(200);
    const read = await h.handle(get('purupuru', 'roster-commit'));
    expect(read.status).toBe(200);
    const body = await read.json();
    expect(body.envelope.surface).toBe('roster-commit');
    expect(body.envelope.config.parent_commit_id).toBeNull();
  });

  test('resolution-ledger PUT→GET round-trips the composite-keyed map', async () => {
    const ledger = {
      entries: {
        'pp:sov:definition-drift': {
          resolution: 'keep-mine',
          resolved_against_base: 'a'.repeat(64),
          ts: '2026-06-05T00:00:00.000Z',
          by: ALICE,
        },
      },
    };
    const r = await h.handle(putBody('purupuru', 'resolution-ledger', { config: ledger, expected_version: 0, provenance: validProvenance() }));
    expect(r.status).toBe(200);
    const read = await h.handle(get('purupuru', 'resolution-ledger'));
    expect((await read.json()).envelope.config.entries['pp:sov:definition-drift'].resolution).toBe('keep-mine');
  });

  test('pending-apply PUT→GET round-trips the durable apply-transaction record', async () => {
    const pending = {
      apply_id: 'ap_1',
      world: 'purupuru',
      base_commit_id: null,
      fencing_token: 'lease-1',
      authorized_actor: ALICE,
      expires_at: '2026-06-05T01:00:00.000Z',
      pre_apply_snapshot: { role_definitions: [], membership: [] },
      ops: [],
      op_status: [],
      started_at: '2026-06-05T00:00:00.000Z',
    };
    const r = await h.handle(putBody('purupuru', 'pending-apply', { config: pending, expected_version: 0, provenance: validProvenance() }));
    expect(r.status).toBe(200);
    const read = await h.handle(get('purupuru', 'pending-apply'));
    expect((await read.json()).envelope.config.apply_id).toBe('ap_1');
  });

  test('a non-admin token → 403 (the FR-10 floor applies to the new surfaces too)', async () => {
    const r = await h.handle(putBody('purupuru', 'roster-commit', { config: commitFor('purupuru'), expected_version: 0, provenance: validProvenance() }, 'no-such-token'));
    expect(r.status).toBe(403);
  });
});

describe('roles-as-code surfaces · tenant isolation (sprint T1.7 · SDD §6)', () => {
  test('a roster-commit whose payload world != path world → 403 (cross-tenant)', async () => {
    // Alice is admin for BOTH worlds, so this is an ISOLATION failure (payload
    // world mibera under path purupuru), not an authority failure. Provenance is
    // complete so the 403 is the tenant check, not the provenance gate.
    const r = await h.handle(putBody('purupuru', 'roster-commit', { config: commitFor('mibera'), expected_version: 0, provenance: validProvenance() }));
    expect(r.status).toBe(403);
    expect((await r.json()).detail).toContain('payload world');
  });

  test('a matching-world roster-commit → 200', async () => {
    const r = await h.handle(putBody('purupuru', 'roster-commit', { config: commitFor('purupuru'), expected_version: 0, provenance: validProvenance() }));
    expect(r.status).toBe(200);
  });
});

describe('roles-as-code surfaces · write provenance (sprint T1.7 · SDD §6)', () => {
  test('the bot-supplied provenance flows into the history row; actor + ts are server-stamped', async () => {
    const r = await h.handle(
      putBody('purupuru', 'roster-commit', {
        config: commitFor('purupuru'),
        expected_version: 0,
        provenance: {
          service_identity: 'bot:purupuru',
          apply_id: 'ap_1',
          fencing_token: 'lease-7',
        },
      }),
    );
    expect(r.status).toBe(200);
    const hist = h.store._history('purupuru', 'roster-commit');
    expect(hist).toHaveLength(1);
    const prov = hist[0]!.provenance!;
    expect(prov.service_identity).toBe('bot:purupuru');
    expect(prov.apply_id).toBe('ap_1');
    expect(prov.fencing_token).toBe('lease-7');
    // actor is the AUTHENTICATED CM (server-stamped, not the body):
    expect(prov.actor).toBe(ALICE);
    // ts is server-stamped (a parseable ISO string):
    expect(Number.isNaN(Date.parse(prov.ts))).toBe(false);
  });

  test('a write that supplies plan_id (instead of apply_id) is accepted', async () => {
    const r = await h.handle(
      putBody('purupuru', 'roster-commit', {
        config: commitFor('purupuru'),
        expected_version: 0,
        provenance: { service_identity: 'bot:purupuru', plan_id: 'pl_1', fencing_token: 'lease-7' },
      }),
    );
    expect(r.status).toBe(200);
    expect(h.store._history('purupuru', 'roster-commit')[0]!.provenance!.plan_id).toBe('pl_1');
  });
});

describe('roles-as-code surfaces · MANDATORY provenance enforcement (/fagan R2 MAJOR)', () => {
  test('a roster-commit write with NO provenance block → 400 invalid_provenance', async () => {
    const r = await h.handle(putBody('purupuru', 'roster-commit', { config: commitFor('purupuru'), expected_version: 0 }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_provenance');
    // Nothing persisted — the write is rejected before the store.
    expect(h.store._history('purupuru', 'roster-commit')).toHaveLength(0);
  });

  test('a roster-commit write with service_identity but NO fencing_token → 400', async () => {
    const r = await h.handle(
      putBody('purupuru', 'roster-commit', {
        config: commitFor('purupuru'),
        expected_version: 0,
        provenance: { service_identity: 'bot:purupuru', apply_id: 'ap_1' }, // missing fencing_token
      }),
    );
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toContain('fencing_token');
  });

  test('a roster-commit write with NEITHER plan_id NOR apply_id → 400', async () => {
    const r = await h.handle(
      putBody('purupuru', 'roster-commit', {
        config: commitFor('purupuru'),
        expected_version: 0,
        provenance: { service_identity: 'bot:purupuru', fencing_token: 'lease-7' }, // no plan_id/apply_id
      }),
    );
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toContain('plan_id');
  });

  test('a roster-commit write with COMPLETE provenance → 200', async () => {
    const r = await h.handle(
      putBody('purupuru', 'roster-commit', { config: commitFor('purupuru'), expected_version: 0, provenance: validProvenance() }),
    );
    expect(r.status).toBe(200);
  });

  test('resolution-ledger + pending-apply ALSO require provenance (400 without)', async () => {
    const ledger = { entries: {} };
    const r1 = await h.handle(putBody('purupuru', 'resolution-ledger', { config: ledger, expected_version: 0 }));
    expect(r1.status).toBe(400);

    const pending = {
      apply_id: 'ap_1', world: 'purupuru', base_commit_id: null, fencing_token: 'lease-1',
      authorized_actor: ALICE, expires_at: '2026-06-05T01:00:00.000Z',
      pre_apply_snapshot: { role_definitions: [], membership: [] }, ops: [], op_status: [],
      started_at: '2026-06-05T00:00:00.000Z',
    };
    const r2 = await h.handle(putBody('purupuru', 'pending-apply', { config: pending, expected_version: 0 }));
    expect(r2.status).toBe(400);
  });

  test('a LEGACY surface (role-map) still accepts a write with NO provenance (optional, unchanged)', async () => {
    const roleMap = {
      enabled: true,
      namespace_prefix: 'freeside',
      rules: [{ role_key: 'freeside:holder', display_name: 'Holder', qualifies: { source: 'tier', min_tier: 't1' }, create_if_absent: true }],
    };
    const r = await h.handle(putBody('purupuru', 'role-map', { config: roleMap, expected_version: 0 }));
    expect(r.status).toBe(200);
    // legacy write carries no provenance (additive — pre-S2 behavior preserved).
    expect(h.store._history('purupuru', 'role-map')[0]!.provenance).toBeUndefined();
  });
});
