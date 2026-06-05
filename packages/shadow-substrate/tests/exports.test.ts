/**
 * exports.test.ts — the REACHABILITY / exported-symbol acceptance gate
 * (SDD §8.4 proof 1 — accident-prevention coverage; the B9 reframe makes the
 * runtime gate the enforced boundary, but this asserts the export SURFACE).
 *
 *   - the barrel exports the four PURE functions + the ports + the data/schema
 *     types + the error ADT (the §4.6 table).
 *   - the barrel exports NO raw live-writer constructor (no LiveRoleWriter,
 *     makeRoleWriter, createLiveRoleWriter, etc.) — the only RoleWriter path is
 *     the S1 GateCheckedRoleWriter (NOT in the S0 surface either).
 *   - the barrel exports NO `WriteCapability` CONSTRUCTOR (the branded type is a
 *     type-only export; no runtime value `WriteCapability`, mintWriteCapability,
 *     makeWriteCapability, etc.).
 *
 * Pure surface assertion — no Layers, no mocks.
 */
import { describe, expect, test } from 'bun:test';
import * as substrate from '../index.js';

const runtimeKeys = Object.keys(substrate);

describe('exported-symbol table (§4.6) — required symbols present', () => {
  test('the four PURE functions are exported', () => {
    expect(typeof substrate.roleMapVersionHash).toBe('function');
    expect(typeof substrate.computeProposed).toBe('function');
    expect(typeof substrate.diff).toBe('function');
    expect(typeof substrate.transition).toBe('function');
  });

  test('the three ports are exported as Context.Tags', () => {
    expect(substrate.RosterSource).toBeDefined();
    expect(substrate.RoleWriter).toBeDefined();
    expect(substrate.ScoreSource).toBeDefined();
  });

  test('the error ADT constructors are exported', () => {
    expect(typeof substrate.GuardFailed).toBe('function');
    expect(typeof substrate.ShadowGateRejected).toBe('function');
    expect(typeof substrate.WriteError).toBe('function');
    expect(typeof substrate.AuthzError).toBe('function');
    expect(typeof substrate.AuditError).toBe('function');
    expect(typeof substrate.RosterError).toBe('function');
    expect(typeof substrate.ScoreError).toBe('function');
  });

  test('the render-model + config-surface schemas are exported', () => {
    expect(substrate.Discrepancy).toBeDefined();
    expect(substrate.ProposedRoster).toBeDefined();
    expect(substrate.CurrentRoster).toBeDefined();
    expect(substrate.RoleMapConfig).toBeDefined();
    expect(substrate.ApplyModeConfig).toBeDefined();
    expect(substrate.OnboardingLifecycle).toBeDefined();
  });

  test('the cycle-010 ADDITIVE op intents + owner schema/helper are exported (FR-9/10/3)', () => {
    expect(substrate.RevokeRoleIntent).toBeDefined();
    expect(substrate.RenameRoleIntent).toBeDefined();
    expect(substrate.RoleOwner).toBeDefined();
    expect(typeof substrate.roleOwnerOf).toBe('function');
    // pre-existing intents stay exported (additivity — nothing removed).
    expect(substrate.CreateRoleIntent).toBeDefined();
    expect(substrate.AssignRoleIntent).toBeDefined();
    expect(substrate.WriteOpKind).toBeDefined();
  });

  test('the S1 EFFECTFUL programs + ports are now exported (§4.6)', () => {
    // EFFECTFUL programs (require Layers) — the S1 half of the §4.6 table.
    expect(typeof substrate.makeGateCheckedRoleWriter).toBe('function');
    expect(typeof substrate.makeModeControl).toBe('function');
    expect(typeof substrate.goLive).toBe('function');
    expect(typeof substrate.rollback).toBe('function');
    expect(typeof substrate.resolveAuthz).toBe('function');
    expect(typeof substrate.resolveReader).toBe('function');
    expect(typeof substrate.loadCurrentRoster).toBe('function');
    expect(typeof substrate.loadLatentCounts).toBe('function');
    expect(typeof substrate.rosterFingerprint).toBe('function');
    expect(typeof substrate.evalRosterFreshness).toBe('function');
    // the S1 ports (Context.Tags the actor supplies Layers for).
    expect(substrate.GateCheckedRoleWriter).toBeDefined();
    expect(substrate.AcvpEmitter).toBeDefined();
    expect(substrate.WorldLock).toBeDefined();
    expect(substrate.AdminAllowlistSource).toBeDefined();
  });

  test('the in-package shadow.* event identifiers + payload schemas are exported (§6.3)', () => {
    expect(substrate.SHADOW_ROLE_REJECTED).toBe('shadow.role.rejected.v1');
    expect(substrate.SHADOW_ROLE_INTENT).toBe('shadow.role.intent.v1');
    expect(substrate.SHADOW_ROLE_APPLIED).toBe('shadow.role.applied.v1');
    expect(substrate.SHADOW_MODE_TRANSITIONED).toBe('shadow.mode.transitioned.v1');
    expect(substrate.SHADOW_AUTHZ_DECIDED).toBe('shadow.authz.decided.v1');
    expect(substrate.ShadowEventType).toBeDefined();
    expect(substrate.ShadowRoleRejectedPayload).toBeDefined();
  });
});

describe('REACHABILITY — deliberate absences (§8.4 proof 1)', () => {
  test('NO raw/concrete live-writer constructor is exported (only the gate + the port Tag)', () => {
    // S1 ADDS the gate: the `RoleWriter` port Tag, the `GateCheckedRoleWriter`
    // Tag, and the `makeGateCheckedRoleWriter` Layer FACTORY are all legitimate
    // — they are the ONLY write path and STILL require an inner `RoleWriter`
    // Layer + a `WriteCapability` per write. What must NOT leak is a CONCRETE
    // LIVE writer constructor (a `makeLiveRoleWriter`/`createDiscordRoleWriter`
    // that performs real Discord I/O) — the actor supplies that as a Layer in S4,
    // never the substrate barrel.
    const ALLOWED = new Set(['RoleWriter', 'GateCheckedRoleWriter', 'makeGateCheckedRoleWriter']);
    const roleWriterish = runtimeKeys.filter((k) => /rolewriter/i.test(k));
    const unexpected = roleWriterish.filter((k) => !ALLOWED.has(k));
    expect(unexpected).toEqual([]);
    // explicitly: no concrete LIVE writer constructor by common names.
    const concreteLive = runtimeKeys.filter((k) =>
      /(make|create|build|new).*(live|discord).*rolewriter/i.test(k),
    );
    expect(concreteLive).toEqual([]);
  });

  test('NO WriteCapability CONSTRUCTOR / runtime value is exported', () => {
    // `WriteCapability` is a TYPE-only export — there must be no runtime binding
    // by that name, and no mint/make/create constructor for it (mintWriteCapability
    // is internal to go-live.ts; the authorized SHADOW→LIVE path is its only caller).
    expect(substrate).not.toHaveProperty('WriteCapability');
    const capabilityCtors = runtimeKeys.filter((k) =>
      /(mint|make|create|build|new|issue).*writecapability|writecapability.*(constructor|ctor)/i.test(k),
    );
    expect(capabilityCtors).toEqual([]);
    // belt-and-suspenders: no runtime key contains "writecapability" at all
    expect(runtimeKeys.filter((k) => /writecapability/i.test(k))).toEqual([]);
    // and no `mintWriteCapability` symbol on the barrel.
    expect(substrate).not.toHaveProperty('mintWriteCapability');
  });

  test('NO discord.js / HTTP / DB / NATS symbol leaked through the barrel', () => {
    // `WorldLock` is an allowed PORT Tag (the lock seam) — exclude it from the
    // I/O leak check (it is a Context.Tag, not a concrete lock impl).
    const ioish = runtimeKeys.filter(
      (k) => /discord|guild|http|fetch|\bpg\b|postgres|redis|nats/i.test(k),
    );
    expect(ioish).toEqual([]);
  });

  test('NO test mock Layers leaked through the barrel', () => {
    const mockish = runtimeKeys.filter((k) =>
      /(makeRecording|makeInMemory|mock|recorder)/i.test(k),
    );
    expect(mockish).toEqual([]);
  });
});
