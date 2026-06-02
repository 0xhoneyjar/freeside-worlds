/**
 * conformance/check.ts — the worlds-api CI compat check (B7, task 401.8 / SDD
 * §1.7.1). Run: `bun run conformance:check` (or `bun run conformance/check.ts`).
 *
 * Asserts three things, failing the build (exit 1) on ANY mismatch:
 *   1. The `@0xhoneyjar/events`-backed `roleMapVersionHash` of the canonical
 *      input reproduces `CANONICAL_VERSION_HASH` byte-for-byte (cross-producer
 *      determinism — the substrate's hash == the events package's JCS+sha256).
 *   2. The REAL exported `@effect/schema` schemas (`Discrepancy` + its nested
 *      role element schemas, `RoleCountProjection`, `AuthzContext` + its nested
 *      `roster_version`/`token_metadata`) carry key sets that are SET-EQUAL to
 *      the `FROZEN_SHAPES` manifest — both directions (a frozen key absent from
 *      the schema, OR a schema key absent from the manifest, fails the build).
 *      This is the B7 cross-repo boundary-skew guard: a rename/add/remove in
 *      render-model.ts or types.ts is caught here before deploy.
 *   3. The PINNED events SHA in this package equals the cycle-canonical SHA
 *      recorded in loa-freeside's `substrate-sha.lock` (NOTE: the SUBSTRATE's
 *      own SHA only exists after commit, so THAT lock is recorded separately by
 *      the orchestrator — see conformance/ROLLBACK.md §"Boundary"). What this
 *      check enforces in-repo is the EVENTS pin, the substrate's only external
 *      dependency whose drift would change the hash.
 *
 * The dashboard (404) + characters (405) CI checks import the SAME fixture from
 * the SHA-pinned substrate and run assertions 1+2 against their pinned copy.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { roleMapVersionHash } from '../src/pure/role-map-version-hash.js';
import {
  Discrepancy,
  BeforeRole,
  AfterRole,
  PreexistingRole,
  LatentQualified,
  RoleCountProjection,
} from '../src/schemas/render-model.js';
import { AuthzContext, RosterVersion } from '../src/types.js';
import type { WriteCapability } from '../src/types.js';
import {
  CANONICAL_VERSION_HASH_INPUT,
  CANONICAL_VERSION_HASH,
  FROZEN_SHAPES,
} from './fixture.js';

const EVENTS_PIN_EXPECTED = '68f5a89cb02c6b3ddf5ab14a1d65753bc02bd9fe';

const TAG = '[conformance-check]';
let failures = 0;

function ok(label: string): void {
  console.log(`${TAG} [OK] ${label}`);
}
function fail(label: string, detail: string): void {
  console.error(`${TAG} [FAIL] ${label}: ${detail}`);
  failures += 1;
}

/**
 * Extract the property names of an `@effect/schema` `S.Struct`. On
 * `@effect/schema ^0.75` the field record is exposed as `(schema as any).fields`
 * (verified on 0.75.5); keys are the struct's declared property names, including
 * optional ones. (If a future bump drops `.fields`, fall back to
 * `AST.getPropertySignatures(schema.ast)` — both return the same key set here.)
 */
function structKeys(schema: unknown): string[] {
  const fields = (schema as { fields?: Record<string, unknown> } | undefined)?.fields;
  return fields ? Object.keys(fields) : [];
}

/** The nested-struct schema at `parent.fields[key]` (e.g. AuthzContext.token_metadata). */
function nestedStruct(parent: unknown, key: string): unknown {
  return (parent as { fields?: Record<string, unknown> } | undefined)?.fields?.[key];
}

/**
 * Assert two key lists are SET-EQUAL (order-insensitive). Reports BOTH the keys
 * the schema is missing (frozen-but-absent) and the keys the manifest is missing
 * (schema-but-unfrozen) — either direction fails the check.
 */
function assertSetEqual(
  label: string,
  schemaKeys: readonly string[],
  frozenKeys: readonly string[],
): void {
  const schemaSet = new Set(schemaKeys);
  const frozenSet = new Set(frozenKeys);
  const missingFromSchema = [...frozenSet].filter((k) => !schemaSet.has(k));
  const missingFromFrozen = [...schemaSet].filter((k) => !frozenSet.has(k));
  if (missingFromSchema.length === 0 && missingFromFrozen.length === 0) {
    ok(`${label} schema keys ≡ frozen manifest (${schemaKeys.length} keys)`);
  } else {
    fail(
      `${label} schema-shape skew`,
      `frozen-but-absent-from-schema=[${missingFromSchema.join(', ')}] ` +
        `schema-but-not-frozen=[${missingFromFrozen.join(', ')}] ` +
        `(schema=[${[...schemaSet].sort().join(', ')}] frozen=[${[...frozenSet].sort().join(', ')}]) ` +
        `— a render-model.ts/types.ts shape change must be matched in conformance/fixture.ts (re-freeze deliberately)`,
    );
  }
}

// ── 1. cross-producer determinism: the frozen hash reproduces ───────────────
const computed = roleMapVersionHash(CANONICAL_VERSION_HASH_INPUT);
if (computed === CANONICAL_VERSION_HASH) {
  ok(`roleMapVersionHash reproduces canonical hash (${computed.slice(0, 12)}…)`);
} else {
  fail(
    'roleMapVersionHash drift',
    `expected ${CANONICAL_VERSION_HASH} got ${computed} — a SHA bump changed the hash algorithm; re-freeze + lockstep rollout (conformance/ROLLBACK.md)`,
  );
}

// ── 2. frozen shapes: the REAL schemas carry exactly the frozen keys ────────
// Derive the ACTUAL field keys from the exported @effect/schema schemas and
// assert SET-EQUALITY against the FROZEN_SHAPES manifest (both directions). A
// rename/add/remove in render-model.ts or types.ts is caught here — NOT a
// self-check of the manifest against itself.
const dShape = FROZEN_SHAPES.Discrepancy;

// Discrepancy.top_level — from the real `Discrepancy` struct.
assertSetEqual('Discrepancy.top_level', structKeys(Discrepancy), dShape.top_level);
// The nested role element schemas are the named exports BeforeRole/AfterRole/
// PreexistingRole/LatentQualified (the arrays inside Discrepancy hold these).
assertSetEqual('Discrepancy.before_role', structKeys(BeforeRole), dShape.before_role);
assertSetEqual('Discrepancy.after_role', structKeys(AfterRole), dShape.after_role);
assertSetEqual('Discrepancy.preexisting_role', structKeys(PreexistingRole), dShape.preexisting_role);
assertSetEqual('Discrepancy.latent_qualified', structKeys(LatentQualified), dShape.latent_qualified);
assertSetEqual('Discrepancy.role_count', structKeys(RoleCountProjection), dShape.role_count);

const aShape = FROZEN_SHAPES.AuthzContext;
assertSetEqual('AuthzContext.top_level', structKeys(AuthzContext), aShape.top_level);
// token_metadata is an anonymous nested S.Struct on AuthzContext.
assertSetEqual(
  'AuthzContext.token_metadata',
  structKeys(nestedStruct(AuthzContext, 'token_metadata')),
  aShape.token_metadata,
);
// roster_version is the named `RosterVersion` schema.
assertSetEqual('AuthzContext.roster_version', structKeys(RosterVersion), aShape.roster_version);

// WriteCapability is a TS branded `export type` (no runtime schema). Derive its
// DATA keys at COMPILE TIME as every string-keyed field — the brand is a
// `unique symbol`, excluded by `Extract<…, string>`. A FULL mapped type (not a
// hand-picked Pick) means ADDING a data field forces a new entry here (tsc
// error), closing the add-direction hole: now add/rename/remove ALL fail the
// build. `Object.keys` then gives the real runtime key set for assertSetEqual.
type WriteCapabilityDataKey = Extract<keyof WriteCapability, string>;
const writeCapSample: { readonly [K in WriteCapabilityDataKey]: WriteCapability[K] } = {
  report_hash: '0'.repeat(64) as WriteCapability['report_hash'],
  transition_version: 1,
  authz_decision_id: 'authz-decision-conformance-sample',
};
assertSetEqual(
  'WriteCapability.data_keys',
  Object.keys(writeCapSample),
  FROZEN_SHAPES.WriteCapability.data_keys,
);

// ── 3. events pin matches the expected canonical events SHA ─────────────────
try {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const eventsDep = pkg.dependencies?.['@0xhoneyjar/events'] ?? '';
  const m = eventsDep.match(/#([0-9a-f]{7,40})$/);
  const pinned = m?.[1] ?? '';
  if (pinned === EVENTS_PIN_EXPECTED) {
    ok(`@0xhoneyjar/events pin matches canonical (${pinned.slice(0, 12)}…)`);
  } else {
    fail('events pin drift', `expected ${EVENTS_PIN_EXPECTED} got "${pinned}"`);
  }
} catch (e) {
  fail('events pin read', String(e));
}

if (failures > 0) {
  console.error(`${TAG} ${failures} conformance assertion(s) FAILED`);
  process.exit(1);
}
console.log(`${TAG} all conformance assertions passed`);
