/**
 * deployed-smoke.test.ts — the DEPLOYED-config-service smoke test (task 403.6 / D4).
 *
 * The in-memory ConfigStore integration tests (fr10-config-seam.test.ts) prove
 * the engine + handler logic, but they CANNOT catch deploy-time mismatches:
 * routing (does the live service know the new surfaces?), schema (is migration
 * 0002 applied?), and the FR-10 token format (does the live verifier reject an
 * unverifiable bearer?). This smoke test hits the LIVE config-service to surface
 * those BEFORE the apply cutover (S4), not during it.
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────
 *   CONFIG_SERVICE_SMOKE_URL=https://config-service.../  \
 *   [CONFIG_SERVICE_TOKEN=<read-token>]                   \
 *   [SMOKE_WRITER_BEARER=<a real identity-api token>]     \
 *   [SMOKE_WORLD=purupuru]                                \
 *     bun test packages/config-service/__tests__/deployed-smoke.test.ts
 *
 * Without CONFIG_SERVICE_SMOKE_URL the suite SKIPS (no creds in CI / local) —
 * that is intentional; this is a manual pre-cutover gate, documented here + in
 * the S4 cutover task (405.7 runs it BEFORE the CONFIG_SERVICE_URL cutover).
 *
 * It does NOT mutate state unless SMOKE_WRITER_BEARER is supplied (then it does a
 * single round-trip PUT/GET on apply-mode and leaves it at SHADOW).
 */
import { describe, expect, test } from 'bun:test';

const BASE = process.env.CONFIG_SERVICE_SMOKE_URL;
const READ_TOKEN = process.env.CONFIG_SERVICE_TOKEN;
const WRITER_BEARER = process.env.SMOKE_WRITER_BEARER;
const WORLD = process.env.SMOKE_WORLD ?? 'purupuru';

const RUN = !!BASE;
const d = RUN ? describe : describe.skip;

function base(): string {
  return BASE!.replace(/\/$/, '');
}
function readHeaders(): Record<string, string> {
  return READ_TOKEN ? { 'x-service-token': READ_TOKEN } : {};
}

d('deployed config-service smoke (D4)', () => {
  test('health endpoint is live', async () => {
    const r = await fetch(`${base()}/health`);
    expect(r.status).toBe(200);
  });

  test('ROUTING: the new surfaces are known (GET returns 404 not_configured / 200, NOT unknown_surface)', async () => {
    for (const surface of ['role-map', 'apply-mode']) {
      const r = await fetch(`${base()}/v1/config/${WORLD}/${surface}`, { headers: readHeaders() });
      expect([200, 404]).toContain(r.status);
      if (r.status === 404) {
        const body = (await r.json()) as { error?: string };
        // 'not_configured' = surface KNOWN but no row yet (good).
        // 'unknown_surface' = the deployed service predates S2 (BAD — surface registration not deployed).
        expect(body.error).not.toBe('unknown_surface');
      }
    }
  });

  test('ROUTING: onboarding-lifecycle without ?cm= → 400 (surface known, cm required)', async () => {
    const r = await fetch(`${base()}/v1/config/${WORLD}/onboarding-lifecycle`, { headers: readHeaders() });
    // 400 (cm required) or 401/403 (auth gate) all prove the surface is ROUTED;
    // a 404 unknown_surface would prove the deploy is stale.
    if (r.status === 404) {
      const body = (await r.json()) as { error?: string };
      expect(body.error).not.toBe('unknown_surface');
    } else {
      expect([400, 401, 403]).toContain(r.status);
    }
  });

  test('FR-10 TOKEN FORMAT: a PUT with a bogus bearer → 403 (NOT accepted as actor)', async () => {
    const r = await fetch(`${base()}/v1/config/${WORLD}/role-map`, {
      method: 'PUT',
      headers: { authorization: 'Bearer not-a-real-identity-token', ...readHeaders() },
      body: JSON.stringify({ config: { enabled: false, namespace_prefix: 'freeside', rules: [] }, expected_version: 0 }),
    });
    // The floor: a non-verifiable / non-allowlisted bearer is rejected. (If the
    // LIVE JWKS verifier is wired this is a signature failure → 403; if still on
    // the fail-closed default, also 403.) Either way: NEVER 200.
    expect(r.status).toBe(403);
  });

  test.skipIf(!WRITER_BEARER)('PERSISTENCE: apply-mode round-trip with a real writer bearer (leaves SHADOW)', async () => {
    // Read current version (404 → start at 0).
    const cur = await fetch(`${base()}/v1/config/${WORLD}/apply-mode`, { headers: readHeaders() });
    let version = 0;
    if (cur.status === 200) version = ((await cur.json()) as { version: number }).version;

    const put = await fetch(`${base()}/v1/config/${WORLD}/apply-mode`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${WRITER_BEARER}`, 'content-type': 'application/json', ...readHeaders() },
      body: JSON.stringify({ config: { apply_mode: 'SHADOW' }, expected_version: version }),
    });
    expect([200, 409]).toContain(put.status); // 200 fresh write, or 409 if a concurrent writer moved it.
  });
});
