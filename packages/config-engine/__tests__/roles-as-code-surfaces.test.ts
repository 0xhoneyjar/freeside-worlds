/**
 * roles-as-code-surfaces.test.ts — cycle-010 (Roles-as-Code) NET-NEW surfaces
 * (SDD §2.1/§2.5/§5.3 · sprint T1.3/T1.4/T1.5/T1.7). Proves each surface
 * round-trips PUT→GET through the engine + the closed-schema validation + the
 * commit_id content-hash determinism + tenant-isolation reject + write
 * provenance threading. Mirrors the existing config-service.test.ts style
 * (MemoryConfigStore, fail-closed validation assertions).
 */
import { describe, expect, test } from 'bun:test';
import {
  ConfigService,
  ConfigValidationError,
  ConfigTenantIsolationError,
} from '../src/index.js';
import {
  computeRosterCommitId,
  type RosterCommitContent,
  type SurfaceConfigMap,
} from '@freeside-worlds/config-protocol';
import { TestMemoryStore } from './test-memory-store.js';

function newService() {
  const store = new TestMemoryStore();
  const service = new ConfigService({ store });
  return { store, service };
}

// ─── roster-commit (FR-1 · SDD §2.1) ────────────────────────────────────────

function genesisCommitContent(world = 'purupuru'): RosterCommitContent {
  return {
    parent_commit_id: null, // genesis
    world,
    ts: '2026-06-05T00:00:00.000Z',
    applied_by: '11111111-1111-4111-8111-111111111111',
    theme_id: 'default',
    ownership_map: { 'purupuru:sovereign': 'freeside', 'manual:mod': 'manual' },
    role_definitions: [
      {
        role_key: 'purupuru:sovereign',
        role_id: '900000000000000001',
        display_name: 'Sovereign',
        color: 0xe8a,
        permissions: '1071698660928',
        position: 5,
      },
    ],
    membership: [{ role_key: 'purupuru:sovereign', member_ids: ['800000000000000001'] }],
    status: 'complete',
  };
}

function genesisCommit(world = 'purupuru'): SurfaceConfigMap['roster-commit'] {
  const content = genesisCommitContent(world);
  return { commit_id: computeRosterCommitId(content), ...content };
}

describe('roster-commit surface (FR-1 · SDD §2.1)', () => {
  test('commit_id is content-addressed + deterministic (same content → same id)', () => {
    const a = computeRosterCommitId(genesisCommitContent());
    const b = computeRosterCommitId(genesisCommitContent());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('commit_id changes when content changes', () => {
    const base = genesisCommitContent();
    const mutated: RosterCommitContent = { ...base, theme_id: 'other-theme' };
    expect(computeRosterCommitId(mutated)).not.toBe(computeRosterCommitId(base));
  });

  test('commit_id is independent of a (stale) commit_id already on the payload', () => {
    // Passing a content object that ALSO carries a commit_id must hash the same
    // as the bare content (the helper strips commit_id before hashing).
    const content = genesisCommitContent();
    const withStaleId = { ...content, commit_id: 'deadbeef'.repeat(8) } as RosterCommitContent;
    expect(computeRosterCommitId(withStaleId)).toBe(computeRosterCommitId(content));
  });

  test('PUT→GET round-trips a genesis commit (parent_commit_id=null)', async () => {
    const { service } = newService();
    const commit = genesisCommit();
    const ok = await service.putConfig('purupuru', 'roster-commit', commit, 0, 'cm:alice');
    expect(ok.version).toBe(1);

    const read = await service.getConfig('purupuru', 'roster-commit');
    expect(read).not.toBeNull();
    const got = read!.envelope.config as SurfaceConfigMap['roster-commit'];
    expect(got.commit_id).toBe(commit.commit_id);
    expect(got.parent_commit_id).toBeNull();
    expect(got.status).toBe('complete');
    expect(got.role_definitions[0]!.role_id).toBe('900000000000000001');
  });

  test('a non-genesis commit chains a parent_commit_id (the commit log)', async () => {
    const { service, store } = newService();
    const genesis = genesisCommit();
    await service.putConfig('purupuru', 'roster-commit', genesis, 0, 'cm:alice'); // v1

    const childContent: RosterCommitContent = {
      ...genesisCommitContent(),
      parent_commit_id: genesis.commit_id, // chain off the genesis
      ts: '2026-06-05T01:00:00.000Z',
      theme_id: 'v2',
    };
    const child: SurfaceConfigMap['roster-commit'] = {
      commit_id: computeRosterCommitId(childContent),
      ...childContent,
    };
    const ok = await service.putConfig('purupuru', 'roster-commit', child, 1, 'cm:bob'); // v2
    expect(ok.version).toBe(2);

    // The store's append-only history IS the commit log (SDD §4 §9 fork 4).
    const hist = store._history('purupuru', 'roster-commit');
    expect(hist).toHaveLength(2);
    expect((hist[1]!.newConfig as SurfaceConfigMap['roster-commit']).parent_commit_id).toBe(
      genesis.commit_id,
    );
  });

  test('rejects a malformed commit_id (not 64-hex) via closed-schema validation', async () => {
    const { service } = newService();
    const bad = { ...genesisCommit(), commit_id: 'too-short' } as SurfaceConfigMap['roster-commit'];
    await expect(
      service.putConfig('purupuru', 'roster-commit', bad, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test('REJECTS a forged commit_id (64-hex but NOT the content hash) — /fagan R1 CRITICAL', async () => {
    const { service, store } = newService();
    // A well-formed 64-hex id that does NOT hash the content (the integrity hole:
    // the schema alone would accept this; the integrity check must reject it).
    const forged = { ...genesisCommit(), commit_id: 'f'.repeat(64) } as SurfaceConfigMap['roster-commit'];
    expect(forged.commit_id).toMatch(/^[0-9a-f]{64}$/); // passes the schema's shape check
    expect(forged.commit_id).not.toBe(computeRosterCommitId(genesisCommitContent())); // but is forged
    await expect(
      service.putConfig('purupuru', 'roster-commit', forged, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
    // Nothing persisted — the forgery never reaches the store (check runs pre-write).
    expect(await store.getCurrent('purupuru', 'roster-commit')).toBeNull();
  });

  test('REJECTS a commit whose content was tampered after the id was computed', async () => {
    const { service } = newService();
    // Compute the id over the genesis content, then mutate a field WITHOUT
    // recomputing — the claimed id no longer matches the (tampered) content.
    const tampered: SurfaceConfigMap['roster-commit'] = {
      ...genesisCommit(),
      theme_id: 'tampered-after-hash', // content changed; commit_id stale
    };
    await expect(
      service.putConfig('purupuru', 'roster-commit', tampered, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test('ACCEPTS a correctly-hashed commit (integrity check passes the honest path)', async () => {
    const { service } = newService();
    const honest = genesisCommit(); // commit_id = computeRosterCommitId(content)
    const ok = await service.putConfig('purupuru', 'roster-commit', honest, 0, 'cm:alice');
    expect(ok.version).toBe(1);
    const read = await service.getConfig('purupuru', 'roster-commit');
    expect((read!.envelope.config as SurfaceConfigMap['roster-commit']).commit_id).toBe(honest.commit_id);
  });

  test('rejects an unknown key in the commit (Struct is closed)', async () => {
    const { service } = newService();
    const rogue = { ...genesisCommit(), rogue_field: 'x' } as unknown as SurfaceConfigMap['roster-commit'];
    await expect(
      service.putConfig('purupuru', 'roster-commit', rogue, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test('REJECTS a commit with a garbage `ts` (IsoTimestamp date validation — /fagan R2)', async () => {
    const { service } = newService();
    // Build content with an invalid ts and a correctly-recomputed commit_id, so
    // the rejection is unambiguously the timestamp validation (not the hash).
    const content: RosterCommitContent = { ...genesisCommitContent(), ts: 'not-a-real-date' };
    const bad: SurfaceConfigMap['roster-commit'] = { commit_id: computeRosterCommitId(content), ...content };
    await expect(
      service.putConfig('purupuru', 'roster-commit', bad, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });
});

// ─── resolution-ledger (FR-6 · SDD §2.5) ────────────────────────────────────

describe('resolution-ledger surface (FR-6 · SDD §2.5)', () => {
  const ledger: SurfaceConfigMap['resolution-ledger'] = {
    entries: {
      'purupuru:sovereign:definition-drift': {
        resolution: 'keep-mine',
        // PER-SLICE base hash (SKP-002) — the role's definition base, NOT the
        // whole-roster commit_id.
        resolved_against_base: 'a'.repeat(64),
        ts: '2026-06-05T00:00:00.000Z',
        by: 'cm:alice',
      },
      'purupuru:sovereign:membership-drift': {
        resolution: 'take-theirs',
        resolved_against_base: 'b'.repeat(64),
        ts: '2026-06-05T00:30:00.000Z',
        by: 'cm:alice',
      },
    },
  };

  test('PUT→GET round-trips the composite-keyed ledger map', async () => {
    const { service } = newService();
    const ok = await service.putConfig('purupuru', 'resolution-ledger', ledger, 0, 'cm:alice');
    expect(ok.version).toBe(1);

    const read = await service.getConfig('purupuru', 'resolution-ledger');
    const got = read!.envelope.config as SurfaceConfigMap['resolution-ledger'];
    expect(Object.keys(got.entries)).toHaveLength(2);
    // The per-slice base hashes are preserved distinct (SKP-002).
    expect(got.entries['purupuru:sovereign:definition-drift']!.resolved_against_base).toBe(
      'a'.repeat(64),
    );
    expect(got.entries['purupuru:sovereign:membership-drift']!.resolved_against_base).toBe(
      'b'.repeat(64),
    );
  });

  test('the whole ledger versions as ONE document (durable updates bump version)', async () => {
    const { service } = newService();
    await service.putConfig('purupuru', 'resolution-ledger', ledger, 0, 'cm:alice'); // v1
    const updated: SurfaceConfigMap['resolution-ledger'] = {
      entries: {
        ...ledger.entries,
        'purupuru:other:definition-drift': {
          resolution: 'adopt',
          resolved_against_base: 'c'.repeat(64),
          ts: '2026-06-05T01:00:00.000Z',
          by: 'cm:bob',
        },
      },
    };
    const ok = await service.putConfig('purupuru', 'resolution-ledger', updated, 1, 'cm:bob');
    expect(ok.version).toBe(2);
    const read = await service.getConfig('purupuru', 'resolution-ledger');
    expect(Object.keys((read!.envelope.config as SurfaceConfigMap['resolution-ledger']).entries)).toHaveLength(3);
  });

  test('rejects a non-64-hex resolved_against_base (per-slice hash must be Hex64)', async () => {
    const { service } = newService();
    const bad: SurfaceConfigMap['resolution-ledger'] = {
      entries: {
        'k:definition-drift': {
          resolution: 'keep-mine',
          resolved_against_base: 'not-a-hash',
          ts: '2026-06-05T00:00:00.000Z',
          by: 'cm:alice',
        },
      },
    };
    await expect(
      service.putConfig('purupuru', 'resolution-ledger', bad, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });
});

// ─── pending-apply (SDD §5.3) ───────────────────────────────────────────────

describe('pending-apply surface (SDD §5.3)', () => {
  // Cast at construction: the WriteOp `idempotency_key` (Hex64) + `member_id`
  // (MemberId) are branded in the S2 decoded Type, but test fixtures supply
  // plain strings (runtime-valid; the brand is a compile-time nominal type). The
  // cast lets the fixture compile while the engine's schema validation is the
  // real runtime gate.
  const pending = {
    apply_id: 'ap_01HZ',
    world: 'purupuru',
    base_commit_id: null,
    fencing_token: 'lease-7',
    authorized_actor: '11111111-1111-4111-8111-111111111111',
    expires_at: '2026-06-05T01:00:00.000Z',
    pre_apply_snapshot: {
      role_definitions: [
        {
          role_key: 'purupuru:sovereign',
          role_id: '900000000000000001',
          display_name: 'Sovereign',
          color: 0xe8a,
          permissions: '1071698660928',
          position: 5,
        },
      ],
      membership: [{ role_key: 'purupuru:sovereign', member_ids: ['800000000000000001'] }],
    },
    ops: [
      {
        op_id: 'op-1',
        idempotency_key: 'd'.repeat(64),
        kind: 'create_role',
        intent: { role_key: 'purupuru:sovereign', display_name: 'Sovereign' },
      },
      {
        op_id: 'op-2',
        idempotency_key: 'e'.repeat(64),
        kind: 'assign_role',
        intent: { role_key: 'purupuru:sovereign', member_id: '800000000000000001' },
      },
    ],
    op_status: [
      { op_id: 'op-1', status: 'pending' },
      { op_id: 'op-2', status: 'pending' },
    ],
    started_at: '2026-06-05T00:00:00.000Z',
  } as unknown as SurfaceConfigMap['pending-apply'];

  test('PUT→GET round-trips a durable apply-transaction record (ops + snapshot + op_status)', async () => {
    const { service } = newService();
    const ok = await service.putConfig('purupuru', 'pending-apply', pending, 0, 'cm:alice');
    expect(ok.version).toBe(1);
    const read = await service.getConfig('purupuru', 'pending-apply');
    const got = read!.envelope.config as SurfaceConfigMap['pending-apply'];
    expect(got.apply_id).toBe('ap_01HZ');
    expect(got.ops).toHaveLength(2);
    expect(got.ops[0]!.kind).toBe('create_role');
    expect(got.op_status[0]!.status).toBe('pending');
    expect(got.pre_apply_snapshot.role_definitions[0]!.role_id).toBe('900000000000000001');
  });

  test('version-guarded CAS update of op_status survives restart shape (SDD §5.3 step 6)', async () => {
    const { service } = newService();
    await service.putConfig('purupuru', 'pending-apply', pending, 0, 'cm:alice'); // v1
    const progressed: SurfaceConfigMap['pending-apply'] = {
      ...pending,
      op_status: [
        { op_id: 'op-1', status: 'ok' },
        { op_id: 'op-2', status: 'pending' },
      ],
    };
    const ok = await service.putConfig('purupuru', 'pending-apply', progressed, 1, 'cm:alice');
    expect(ok.version).toBe(2);
    const read = await service.getConfig('purupuru', 'pending-apply');
    expect((read!.envelope.config as SurfaceConfigMap['pending-apply']).op_status[0]!.status).toBe('ok');
  });

  test('rejects a malformed WriteOp (kind/intent mismatch caught by the S2 discriminated union)', async () => {
    const { service } = newService();
    const bad = {
      ...pending,
      ops: [
        {
          op_id: 'op-x',
          idempotency_key: 'f'.repeat(64),
          // kind says rename but the intent is a create intent — the S2
          // discriminated union rejects this at decode (the whole point of the
          // /fagan discriminated-union fix).
          kind: 'rename_role',
          intent: { role_key: 'k', display_name: 'X' },
        },
      ],
    } as unknown as SurfaceConfigMap['pending-apply'];
    await expect(
      service.putConfig('purupuru', 'pending-apply', bad, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test('REJECTS a pending-apply with a garbage `expires_at` (security-load-bearing — /fagan R2)', async () => {
    const { service } = newService();
    // expires_at is the single-use/expiry gate (SDD §5.3 step 1); a garbage value
    // must NOT persist (it would otherwise compare nonsensically against `now`).
    const bad = { ...pending, expires_at: 'whenever' } as unknown as SurfaceConfigMap['pending-apply'];
    await expect(
      service.putConfig('purupuru', 'pending-apply', bad, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test('REJECTS a pending-apply with a garbage `started_at`', async () => {
    const { service } = newService();
    const bad = { ...pending, started_at: '2026-13-99' } as unknown as SurfaceConfigMap['pending-apply'];
    await expect(
      service.putConfig('purupuru', 'pending-apply', bad, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });
});

// ─── tenant isolation + write provenance (sprint T1.7 · SDD §6) ──────────────

describe('tenant isolation + write provenance (sprint T1.7 · SDD §6)', () => {
  test('a roster-commit whose payload world != path world is REJECTED (cross-tenant)', async () => {
    const { service, store } = newService();
    // Authorized for purupuru, but the payload claims world=mibera.
    const crossTenant = genesisCommit('mibera');
    await expect(
      service.putConfig('purupuru', 'roster-commit', crossTenant, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigTenantIsolationError);
    // Nothing persisted under purupuru.
    expect(await store.getCurrent('purupuru', 'roster-commit')).toBeNull();
  });

  test('a pending-apply whose payload world != path world is REJECTED', async () => {
    const { service } = newService();
    const crossTenant: SurfaceConfigMap['pending-apply'] = {
      apply_id: 'ap_x',
      world: 'mibera', // mismatched
      base_commit_id: null,
      fencing_token: 'lease-1',
      authorized_actor: 'cm:alice',
      expires_at: '2026-06-05T01:00:00.000Z',
      pre_apply_snapshot: { role_definitions: [], membership: [] },
      ops: [],
      op_status: [],
      started_at: '2026-06-05T00:00:00.000Z',
    };
    await expect(
      service.putConfig('purupuru', 'pending-apply', crossTenant, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigTenantIsolationError);
  });

  test('a matching-world roster-commit is accepted (isolation passes)', async () => {
    const { service } = newService();
    const ok = await service.putConfig('purupuru', 'roster-commit', genesisCommit('purupuru'), 0, 'cm:alice');
    expect(ok.version).toBe(1);
  });

  test('write provenance is stamped into the append-only history row', async () => {
    const { service, store } = newService();
    const provenance = {
      service_identity: 'bot:purupuru',
      actor: 'cm:alice',
      apply_id: 'ap_01HZ',
      fencing_token: 'lease-7',
      ts: '2026-06-05T00:00:00.000Z',
    };
    await service.putConfig(
      'purupuru',
      'roster-commit',
      genesisCommit('purupuru'),
      0,
      'cm:alice',
      'apply',
      null,
      provenance,
    );
    const hist = store._history('purupuru', 'roster-commit');
    expect(hist).toHaveLength(1);
    expect(hist[0]!.provenance).toEqual(provenance);
  });

  test('the 4 existing surfaces have no payload world → isolation never fires (additive)', async () => {
    const { service } = newService();
    // verify-message has no `world` field — the isolation check is a no-op.
    const ok = await service.putConfig(
      'purupuru',
      'verify-message',
      { enabled: true, copy: { title: 'Verify', body: 'Connect.', buttonLabel: 'Go' } },
      0,
      'cm:alice',
    );
    expect(ok.version).toBe(1);
  });
});
