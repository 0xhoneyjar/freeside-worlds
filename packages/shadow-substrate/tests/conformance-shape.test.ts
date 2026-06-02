/**
 * conformance-shape.test.ts — guards the B7 cross-repo boundary-skew check
 * (conformance/check.ts §2 / SDD §1.7.1).
 *
 * Two obligations:
 *   1. POSITIVE: the REAL exported @effect/schema schemas carry key sets that are
 *      SET-EQUAL to the FROZEN_SHAPES manifest (so any rename/add/remove in
 *      render-model.ts or types.ts breaks `bun test`, not just CI's
 *      conformance:check).
 *   2. NEGATIVE: the set-equality guard actually CATCHES a drifted schema (an
 *      injected phantom key fails the comparison) — proving §2 is a real guard,
 *      not a self-check of the manifest against itself (the FAGAN iter-1 defect).
 *
 * PURE — schema field introspection, no Layers, no mocks. The key extraction
 * mirrors `structKeys` in conformance/check.ts (`.fields` on @effect/schema
 * ^0.75; verified on 0.75.5).
 */
import { describe, expect, test } from 'bun:test';
import {
  Discrepancy,
  BeforeRole,
  AfterRole,
  PreexistingRole,
  LatentQualified,
  RoleCountProjection,
} from '../src/schemas/render-model.js';
import { AuthzContext, RosterVersion } from '../src/types.js';
import { FROZEN_SHAPES } from '../conformance/fixture.js';

function structKeys(schema: unknown): string[] {
  const fields = (schema as { fields?: Record<string, unknown> } | undefined)?.fields;
  return fields ? Object.keys(fields) : [];
}
function nestedStruct(parent: unknown, key: string): unknown {
  return (parent as { fields?: Record<string, unknown> } | undefined)?.fields?.[key];
}
/** True iff the two key lists are set-equal (order-insensitive, both directions). */
function setEqual(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const k of sa) if (!sb.has(k)) return false;
  return true;
}

describe('conformance §2 — real schema keys ≡ frozen manifest', () => {
  const d = FROZEN_SHAPES.Discrepancy;
  test('Discrepancy.top_level', () => {
    expect(setEqual(structKeys(Discrepancy), d.top_level)).toBe(true);
  });
  test('Discrepancy.before_role (BeforeRole)', () => {
    expect(setEqual(structKeys(BeforeRole), d.before_role)).toBe(true);
  });
  test('Discrepancy.after_role (AfterRole)', () => {
    expect(setEqual(structKeys(AfterRole), d.after_role)).toBe(true);
  });
  test('Discrepancy.preexisting_role (PreexistingRole)', () => {
    expect(setEqual(structKeys(PreexistingRole), d.preexisting_role)).toBe(true);
  });
  test('Discrepancy.latent_qualified (LatentQualified)', () => {
    expect(setEqual(structKeys(LatentQualified), d.latent_qualified)).toBe(true);
  });
  test('Discrepancy.role_count (RoleCountProjection)', () => {
    expect(setEqual(structKeys(RoleCountProjection), d.role_count)).toBe(true);
  });

  const a = FROZEN_SHAPES.AuthzContext;
  test('AuthzContext.top_level', () => {
    expect(setEqual(structKeys(AuthzContext), a.top_level)).toBe(true);
  });
  test('AuthzContext.token_metadata (nested struct)', () => {
    expect(setEqual(structKeys(nestedStruct(AuthzContext, 'token_metadata')), a.token_metadata)).toBe(true);
  });
  test('AuthzContext.roster_version (RosterVersion)', () => {
    expect(setEqual(structKeys(RosterVersion), a.roster_version)).toBe(true);
  });
});

describe('conformance §2 — the guard CATCHES schema drift (negative)', () => {
  test('an extra schema key is NOT set-equal to the frozen manifest', () => {
    const drifted = [...structKeys(RoleCountProjection), '__JUNK_DRIFT_KEY__'];
    expect(setEqual(drifted, FROZEN_SHAPES.Discrepancy.role_count)).toBe(false);
  });
  test('a removed schema key is NOT set-equal to the frozen manifest', () => {
    const drifted = structKeys(AuthzContext).filter((k) => k !== 'authz_decision_id');
    expect(setEqual(drifted, FROZEN_SHAPES.AuthzContext.top_level)).toBe(false);
  });
});
