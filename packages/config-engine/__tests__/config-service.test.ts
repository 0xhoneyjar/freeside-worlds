/**
 * Engine machinery tests — proves the ported sietch optimistic-lock + append-only
 * pattern works over the MemoryConfigStore (no pg required).
 *
 * Run: bun test (from packages/config-engine or repo root).
 */
import { describe, expect, test } from 'bun:test';
import {
  ConfigService,
  ConfigVersionConflictError,
  ConfigValidationError,
  type ConfigStore,
  type CurrentConfigRow,
  type WriteInput,
  type WriteResult,
} from '../src/index.js';
import type { VerifyMessageConfig, RoleMapConfig } from '@freeside-worlds/config-protocol';
import { KNOWN_SURFACES } from '@freeside-worlds/config-protocol';

/**
 * Test-local in-memory ConfigStore. Deliberately NOT imported from
 * config-adapters: the engine package must not depend on the adapters package
 * (that's a layering inversion — engine is the construct plane, adapters the
 * execution plane). The production MemoryConfigStore in config-adapters has the
 * same semantics; this copy keeps the engine's test self-contained.
 */
class TestMemoryStore implements ConfigStore {
  private heads = new Map<string, CurrentConfigRow & { config: unknown }>();
  history: WriteInput[] = [];
  private nextId = 1;
  private k(w: string, s: string) {
    return `${w} ${s}`;
  }
  async getCurrent(w: string, s: string): Promise<CurrentConfigRow | null> {
    const r = this.heads.get(this.k(w, s));
    return r ? { ...r } : null;
  }
  async applyWrite(input: WriteInput): Promise<WriteResult | null> {
    const key = this.k(input.worldSlug, input.surface);
    const existing = this.heads.get(key);
    if (input.action === 'CREATE') {
      if (existing) return null;
    } else if (!existing || existing.version !== input.expectedVersion) {
      return null;
    }
    const recordId = this.nextId++;
    this.history.push({ ...input });
    const now = new Date().toISOString();
    const newVersion = existing ? existing.version + 1 : 1;
    this.heads.set(key, {
      worldSlug: input.worldSlug,
      surface: input.surface,
      schemaVersion: '1.0',
      config: input.newConfig,
      version: newVersion,
      lastRecordId: recordId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return { recordId, newVersion };
  }
  _history(w: string, s: string): WriteInput[] {
    return this.history.filter((h) => h.worldSlug === w && h.surface === s);
  }
}
const MemoryConfigStore = TestMemoryStore;

const validConfig: VerifyMessageConfig = {
  enabled: true,
  copy: { title: 'Verify', body: 'Connect your wallet to verify.', buttonLabel: 'Verify' },
};

function newService() {
  const store = new MemoryConfigStore();
  const service = new ConfigService({ store });
  return { store, service };
}

describe('ConfigService — CREATE', () => {
  test('GET on never-configured returns null (fail-soft)', async () => {
    const { service } = newService();
    const r = await service.getConfig('mibera', 'verify-message');
    expect(r).toBeNull();
  });

  test('first PUT creates at version 1 + appends a CREATE record', async () => {
    const { service, store } = newService();
    const ok = await service.putConfig('mibera', 'verify-message', validConfig, 0, 'cm:alice');
    expect(ok.version).toBe(1);
    expect(ok.envelope.world_slug).toBe('mibera');
    expect(ok.envelope.surface).toBe('verify-message');

    const hist = store._history('mibera', 'verify-message');
    expect(hist).toHaveLength(1);
    expect(hist[0]!.action).toBe('CREATE');
    expect(hist[0]!.prevConfig).toBeNull();
    expect(hist[0]!.actor).toBe('cm:alice');
  });
});

describe('ConfigService — optimistic lock (the ported sietch machinery)', () => {
  test('UPDATE with correct expected_version bumps version + appends UPDATE record with prev', async () => {
    const { service, store } = newService();
    await service.putConfig('mibera', 'verify-message', validConfig, 0, 'cm:alice');

    const updated: VerifyMessageConfig = {
      ...validConfig,
      copy: { ...validConfig.copy, title: 'Verify (updated)' },
    };
    const ok = await service.putConfig('mibera', 'verify-message', updated, 1, 'cm:bob');
    expect(ok.version).toBe(2);

    const hist = store._history('mibera', 'verify-message');
    expect(hist).toHaveLength(2);
    expect(hist[1]!.action).toBe('UPDATE');
    expect((hist[1]!.prevConfig as VerifyMessageConfig).copy.title).toBe('Verify');
    expect((hist[1]!.newConfig as VerifyMessageConfig).copy.title).toBe('Verify (updated)');
  });

  test('UPDATE with stale expected_version throws ConfigVersionConflictError', async () => {
    const { service } = newService();
    await service.putConfig('mibera', 'verify-message', validConfig, 0, 'cm:alice');
    await service.putConfig('mibera', 'verify-message', validConfig, 1, 'cm:bob'); // -> v2

    // Caller still holds v1 -> conflict.
    await expect(
      service.putConfig('mibera', 'verify-message', validConfig, 1, 'cm:carol'),
    ).rejects.toBeInstanceOf(ConfigVersionConflictError);
  });

  test('conflict does NOT append a phantom head move beyond the failed record', async () => {
    const { service, store } = newService();
    await service.putConfig('mibera', 'verify-message', validConfig, 0, 'cm:alice'); // v1
    try {
      await service.putConfig('mibera', 'verify-message', validConfig, 99, 'cm:bad'); // wrong version
    } catch {
      /* expected */
    }
    const head = await store.getCurrent('mibera', 'verify-message');
    expect(head!.version).toBe(1); // head unmoved
  });
});

describe('ConfigService — fail-closed validation', () => {
  test('invalid payload throws ConfigValidationError before any write', async () => {
    const { service, store } = newService();
    const bad = { enabled: true, copy: { title: '', body: 'x', buttonLabel: 'y' } } as unknown as VerifyMessageConfig;
    await expect(
      service.putConfig('mibera', 'verify-message', bad, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
    // nothing persisted
    expect(await store.getCurrent('mibera', 'verify-message')).toBeNull();
  });

  test('accepts a config carrying a full Jani Theme override', async () => {
    const { service } = newService();
    const withTheme: VerifyMessageConfig = {
      ...validConfig,
      theme: {
        id: 't1',
        name: 'Sietch Dark',
        branding: {
          colors: {
            primary: '#e8a',
            secondary: '#222',
            accent: '#f0c',
            background: '#000',
            surface: '#111',
            text: '#fff',
          },
          fonts: {
            heading: { family: 'Inter', weight: 700 },
            body: { family: 'Inter', weight: 400 },
          },
          borderRadius: 'md',
          spacing: 'comfortable',
        },
        pages: [
          {
            id: 'p1',
            name: 'Verify',
            slug: 'verify',
            components: [{ id: 'c1', type: 'hero', props: { heading: 'gm' } }],
          },
        ],
        createdAt: '2026-05-30T00:00:00.000Z',
        updatedAt: '2026-05-30T00:00:00.000Z',
      },
    };
    const ok = await service.putConfig('mibera', 'verify-message', withTheme, 0, 'cm:alice');
    expect(ok.version).toBe(1);
  });
});

describe('ConfigService — BLOCKER-1 hardening (store-raw-but-bounded write-side validation)', () => {
  test('rejects a copy.title longer than the 200-char cap', async () => {
    const { service, store } = newService();
    const overlong: VerifyMessageConfig = {
      ...validConfig,
      copy: { ...validConfig.copy, title: 'x'.repeat(201) },
    };
    await expect(
      service.putConfig('mibera', 'verify-message', overlong, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
    expect(await store.getCurrent('mibera', 'verify-message')).toBeNull();
  });

  test('rejects a copy.body longer than the 4000-char cap', async () => {
    const { service } = newService();
    const overlong: VerifyMessageConfig = {
      ...validConfig,
      copy: { ...validConfig.copy, body: 'y'.repeat(4001) },
    };
    await expect(
      service.putConfig('mibera', 'verify-message', overlong, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test('rejects a C0 control byte (NUL) embedded in copy.title', async () => {
    const { service, store } = newService();
    const sneaky: VerifyMessageConfig = {
      ...validConfig,
      copy: { ...validConfig.copy, title: 'Ver ify' },
    };
    await expect(
      service.putConfig('mibera', 'verify-message', sneaky, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
    expect(await store.getCurrent('mibera', 'verify-message')).toBeNull();
  });

  test('rejects an ANSI escape (C1/ESC) in copy.body', async () => {
    const { service } = newService();
    const sneaky: VerifyMessageConfig = {
      ...validConfig,
      copy: { ...validConfig.copy, body: 'Connect [31mred[0m wallet' },
    };
    await expect(
      service.putConfig('mibera', 'verify-message', sneaky, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test('rejects a zero-width character (U+200B) in copy.buttonLabel', async () => {
    const { service } = newService();
    const sneaky: VerifyMessageConfig = {
      ...validConfig,
      copy: { ...validConfig.copy, buttonLabel: 'Ver​ify' },
    };
    await expect(
      service.putConfig('mibera', 'verify-message', sneaky, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test('rejects a RTL-override (U+202E) bidi-spoof char in copy.title', async () => {
    const { service } = newService();
    const sneaky: VerifyMessageConfig = {
      ...validConfig,
      copy: { ...validConfig.copy, title: 'Verify‮gnitteS' },
    };
    await expect(
      service.putConfig('mibera', 'verify-message', sneaky, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test('rejects an unknown key in a theme component props slot (closed slot-schema)', async () => {
    const { service, store } = newService();
    const withRogueProp = {
      ...validConfig,
      theme: {
        id: 't1',
        name: 'Sietch Dark',
        branding: {
          colors: {
            primary: '#e8a', secondary: '#222', accent: '#f0c',
            background: '#000', surface: '#111', text: '#fff',
          },
          fonts: {
            heading: { family: 'Inter', weight: 700 },
            body: { family: 'Inter', weight: 400 },
          },
          borderRadius: 'md', spacing: 'comfortable',
        },
        pages: [{
          id: 'p1', name: 'Verify', slug: 'verify',
          // `onClick` is NOT a known slot key — open-record injection vector.
          components: [{ id: 'c1', type: 'hero', props: { heading: 'gm', onClick: 'alert(1)' } }],
        }],
        createdAt: '2026-05-30T00:00:00.000Z',
        updatedAt: '2026-05-30T00:00:00.000Z',
      },
    } as unknown as VerifyMessageConfig;
    await expect(
      service.putConfig('mibera', 'verify-message', withRogueProp, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
    expect(await store.getCurrent('mibera', 'verify-message')).toBeNull();
  });

  test('rejects a control byte hidden inside a theme component prop string', async () => {
    const { service } = newService();
    const withSneakyProp = {
      ...validConfig,
      theme: {
        id: 't1', name: 'Sietch Dark',
        branding: {
          colors: {
            primary: '#e8a', secondary: '#222', accent: '#f0c',
            background: '#000', surface: '#111', text: '#fff',
          },
          fonts: {
            heading: { family: 'Inter', weight: 700 },
            body: { family: 'Inter', weight: 400 },
          },
          borderRadius: 'md', spacing: 'comfortable',
        },
        pages: [{
          id: 'p1', name: 'Verify', slug: 'verify',
          components: [{ id: 'c1', type: 'rich-text', props: { content: 'hithere' } }],
        }],
        createdAt: '2026-05-30T00:00:00.000Z',
        updatedAt: '2026-05-30T00:00:00.000Z',
      },
    } as unknown as VerifyMessageConfig;
    await expect(
      service.putConfig('mibera', 'verify-message', withSneakyProp, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test('accepts a theme whose component props use only known, bounded slots', async () => {
    const { service } = newService();
    const clean: VerifyMessageConfig = {
      ...validConfig,
      theme: {
        id: 't1', name: 'Sietch Dark',
        branding: {
          colors: {
            primary: '#e8a', secondary: '#222', accent: '#f0c',
            background: '#000', surface: '#111', text: '#fff',
          },
          fonts: {
            heading: { family: 'Inter', weight: 700 },
            body: { family: 'Inter', weight: 400 },
          },
          borderRadius: 'md', spacing: 'comfortable',
        },
        pages: [{
          id: 'p1', name: 'Verify', slug: 'verify',
          components: [
            {
              id: 'c1', type: 'leaderboard',
              props: { title: 'Top holders', showRank: true, maxEntries: 10, columns: 3 },
            },
          ],
        }],
        createdAt: '2026-05-30T00:00:00.000Z',
        updatedAt: '2026-05-30T00:00:00.000Z',
      },
    };
    const ok = await service.putConfig('mibera', 'verify-message', clean, 0, 'cm:alice');
    expect(ok.version).toBe(1);
  });

  test('accepts a deeply nested (recursive children) component tree within bounds', async () => {
    const { service } = newService();
    const nested: VerifyMessageConfig = {
      ...validConfig,
      theme: {
        id: 't1', name: 'Sietch Dark',
        branding: {
          colors: {
            primary: '#e8a', secondary: '#222', accent: '#f0c',
            background: '#000', surface: '#111', text: '#fff',
          },
          fonts: {
            heading: { family: 'Inter', weight: 700 },
            body: { family: 'Inter', weight: 400 },
          },
          borderRadius: 'md', spacing: 'comfortable',
        },
        pages: [{
          id: 'p1', name: 'Verify', slug: 'verify',
          components: [
            {
              id: 'root', type: 'layout-container',
              props: { direction: 'vertical', gap: 'md' },
              children: [
                { id: 'c1', type: 'rich-text', props: { content: 'gm bera', textAlign: 'left' } },
                {
                  id: 'c2', type: 'layout-container', props: { direction: 'horizontal' },
                  children: [{ id: 'c3', type: 'leaderboard', props: { showRank: false } }],
                },
              ],
            },
          ],
        }],
        createdAt: '2026-05-30T00:00:00.000Z',
        updatedAt: '2026-05-30T00:00:00.000Z',
      },
    };
    const ok = await service.putConfig('mibera', 'verify-message', nested, 0, 'cm:alice');
    expect(ok.version).toBe(1);
  });
});

describe('ConfigService — per-world isolation', () => {
  test('two worlds with the same surface keep independent heads + versions', async () => {
    const { service } = newService();
    await service.putConfig('mibera', 'verify-message', validConfig, 0, 'cm:alice'); // mibera v1
    await service.putConfig('apdao', 'verify-message', validConfig, 0, 'cm:alice'); // apdao v1
    await service.putConfig('mibera', 'verify-message', validConfig, 1, 'cm:alice'); // mibera v2

    const m = await service.getConfig('mibera', 'verify-message');
    const a = await service.getConfig('apdao', 'verify-message');
    expect(m!.version).toBe(2);
    expect(a!.version).toBe(1);
  });
});

// ─── role-map surface (Track 2 P1): the CM-editable tier→Discord-role map ──
//
// Mirrors the verify-message fixtures: a valid payload decodes and writes; the
// BLOCKER-1 write-side defenses (excess key, control byte in a CM-editable
// label, the bounded color grammar) reject before any store mutation. The
// rungs cap (≤25) and the discordRoleId snowflake grammar are role-map's own
// invariants. Grounded against freeside-dashboard `_data/roles-shared.ts`
// TierDef (id/label/gate/color); `gate` is the contract-layer numeric score
// threshold (the dashboard renders its plain-language gate string for humans).

// A valid role-map: two rungs, one BOUND to a Discord role, one UNBOUND
// (discordRoleId omitted — "no role assignment for this tier yet").
const validRoleMap: RoleMapConfig = {
  enabled: true,
  rungs: [
    {
      id: 'godfather',
      label: 'Godfather',
      color: 'oklch(0.70 0.13 70)', // dashboard ladders carry oklch …
      gate: 90,
      discordRoleId: '123456789012345678', // … and bind a real snowflake.
    },
    {
      id: 'curious',
      label: 'Curious',
      color: '#C2B280', // … or hex — same bounded grammar accent colors use.
      gate: 0, // floor tier, UNBOUND (discordRoleId omitted).
    },
  ],
};

describe('role-map surface — registration', () => {
  test("'role-map' is a KNOWN_SURFACES member alongside 'verify-message'", () => {
    expect(KNOWN_SURFACES).toContain('role-map');
    expect(KNOWN_SURFACES).toContain('verify-message');
  });
});

describe('role-map surface — valid decode + write', () => {
  test('a valid role-map (one bound rung, one unbound) creates at version 1', async () => {
    const { service, store } = newService();
    const ok = await service.putConfig('mibera', 'role-map', validRoleMap, 0, 'cm:alice');
    expect(ok.version).toBe(1);
    expect(ok.envelope.surface).toBe('role-map');
    const cfg = ok.envelope.config as RoleMapConfig;
    expect(cfg.rungs).toHaveLength(2);
    expect(cfg.rungs[0]!.discordRoleId).toBe('123456789012345678'); // bound
    expect(cfg.rungs[1]!.discordRoleId).toBeUndefined(); // unbound is valid

    const hist = store._history('mibera', 'role-map');
    expect(hist).toHaveLength(1);
    expect(hist[0]!.action).toBe('CREATE');
  });

  test('a rung MAY omit discordRoleId (unbound tier) — accepted', async () => {
    const { service } = newService();
    const allUnbound: RoleMapConfig = {
      enabled: false,
      rungs: [{ id: 'lurker', label: 'lurker', color: '#888', gate: 0 }],
    };
    const ok = await service.putConfig('henlo', 'role-map', allUnbound, 0, 'cm:alice');
    expect(ok.version).toBe(1);
  });

  test('exactly 25 rungs (the cap) is accepted', async () => {
    const { service } = newService();
    const atCap: RoleMapConfig = {
      enabled: true,
      rungs: Array.from({ length: 25 }, (_, i) => ({
        id: `tier-${i}`,
        label: `Tier ${i}`,
        color: '#ffffff',
        gate: i,
      })),
    };
    const ok = await service.putConfig('sietch', 'role-map', atCap, 0, 'cm:alice');
    expect(ok.version).toBe(1);
  });
});

describe('role-map surface — fail-closed validation (BLOCKER-1 + own invariants)', () => {
  test('rejects an excess (unknown) key on a rung — closed slot-schema', async () => {
    const { service, store } = newService();
    const withRogueKey = {
      enabled: true,
      rungs: [{ id: 'x', label: 'X', color: '#fff', gate: 1, bogus: 'inject' }],
    } as unknown as RoleMapConfig;
    await expect(
      service.putConfig('mibera', 'role-map', withRogueKey, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
    expect(await store.getCurrent('mibera', 'role-map')).toBeNull();
  });

  test('rejects a control byte (NUL) in a rung label', async () => {
    const { service, store } = newService();
    const sneaky = {
      enabled: true,
      // U+0000 embedded in the display label.
      rungs: [{ id: 'x', label: `God${String.fromCharCode(0)}father`, color: '#fff', gate: 1 }],
    } as unknown as RoleMapConfig;
    await expect(
      service.putConfig('mibera', 'role-map', sneaky, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
    expect(await store.getCurrent('mibera', 'role-map')).toBeNull();
  });

  test('rejects a zero-width character (U+200B) in a rung label', async () => {
    const { service } = newService();
    const sneaky = {
      enabled: true,
      rungs: [{ id: 'x', label: `God${String.fromCharCode(0x200b)}father`, color: '#fff', gate: 1 }],
    } as unknown as RoleMapConfig;
    await expect(
      service.putConfig('mibera', 'role-map', sneaky, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test('rejects a label longer than the 60-char cap', async () => {
    const { service } = newService();
    const overlong = {
      enabled: true,
      rungs: [{ id: 'x', label: 'L'.repeat(61), color: '#fff', gate: 1 }],
    } as unknown as RoleMapConfig;
    await expect(
      service.putConfig('mibera', 'role-map', overlong, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test('rejects a control byte hidden in the color value (bounded color grammar)', async () => {
    const { service } = newService();
    const sneaky = {
      enabled: true,
      rungs: [{ id: 'x', label: 'X', color: `#ff${String.fromCharCode(0x1b)}f`, gate: 1 }],
    } as unknown as RoleMapConfig;
    await expect(
      service.putConfig('mibera', 'role-map', sneaky, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test('rejects a bad tier id grammar (uppercase / underscore not in [a-z0-9-])', async () => {
    const { service } = newService();
    const badId = {
      enabled: true,
      rungs: [{ id: 'Bad_ID', label: 'X', color: '#fff', gate: 1 }],
    } as unknown as RoleMapConfig;
    await expect(
      service.putConfig('mibera', 'role-map', badId, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test('rejects a negative gate (score threshold must be ≥ 0)', async () => {
    const { service } = newService();
    const negGate = {
      enabled: true,
      rungs: [{ id: 'x', label: 'X', color: '#fff', gate: -1 }],
    } as unknown as RoleMapConfig;
    await expect(
      service.putConfig('mibera', 'role-map', negGate, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test('rejects a non-numeric discordRoleId (snowflake must be [0-9]+)', async () => {
    const { service } = newService();
    const badRole = {
      enabled: true,
      rungs: [{ id: 'x', label: 'X', color: '#fff', gate: 1, discordRoleId: 'role-1' }],
    } as unknown as RoleMapConfig;
    await expect(
      service.putConfig('mibera', 'role-map', badRole, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test('rejects a rungs array over the 25-rung cap', async () => {
    const { service, store } = newService();
    const tooMany = {
      enabled: true,
      rungs: Array.from({ length: 26 }, (_, i) => ({
        id: `tier-${i}`,
        label: `Tier ${i}`,
        color: '#fff',
        gate: i,
      })),
    } as unknown as RoleMapConfig;
    await expect(
      service.putConfig('mibera', 'role-map', tooMany, 0, 'cm:alice'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
    expect(await store.getCurrent('mibera', 'role-map')).toBeNull();
  });
});

describe('role-map surface — per-surface isolation from verify-message', () => {
  test('a world can hold BOTH a verify-message and a role-map head independently', async () => {
    const { service } = newService();
    await service.putConfig('mibera', 'verify-message', validConfig, 0, 'cm:alice');
    await service.putConfig('mibera', 'role-map', validRoleMap, 0, 'cm:alice');

    const vm = await service.getConfig('mibera', 'verify-message');
    const rm = await service.getConfig('mibera', 'role-map');
    expect(vm!.version).toBe(1);
    expect(rm!.version).toBe(1);
    expect(vm!.envelope.surface).toBe('verify-message');
    expect(rm!.envelope.surface).toBe('role-map');
  });
});
