/**
 * schemas.test.ts — config-surface payload schema acceptance (401.2).
 *
 *   - RoleMapConfig / ApplyModeConfig / OnboardingLifecycle decode valid input.
 *   - BoundedString hardening: a control byte / zero-width char is REJECTED.
 *   - @effect/schema Struct is CLOSED — unknown keys rejected (onExcessProperty).
 *   - ApplyModeConfig: apply_mode literal SHADOW|LIVE; Hex64 forensic field.
 *
 * Control/zero-width bytes are built via `String.fromCharCode` so this source
 * carries NO raw control bytes (diff-clean + reviewable). PURE — schema decode,
 * no Layers, no mocks.
 */
import { describe, expect, test } from 'bun:test';
import { Schema as S } from '@effect/schema';
import {
  RoleMapConfig,
  ApplyModeConfig,
  OnboardingLifecycle,
} from '../src/schemas/config-surfaces.js';

const BELL = String.fromCharCode(0x07); // C0 control byte
const ZWSP = String.fromCharCode(0x200b); // zero-width space (Cf)

describe('RoleMapConfig', () => {
  const valid = {
    enabled: true,
    namespace_prefix: 'purupuru:',
    rules: [
      {
        role_key: 'purupuru:holder',
        display_name: 'Holder',
        qualifies: { source: 'tier', min_tier: 'tier-1' },
        create_if_absent: true,
      },
    ],
  };

  test('decodes a valid role-map', () => {
    expect(() => S.decodeUnknownSync(RoleMapConfig)(valid)).not.toThrow();
  });

  test('REJECTS a control byte in a CM-editable string (BoundedString hardening)', () => {
    const withControlByte = {
      ...valid,
      rules: [{ ...valid.rules[0], display_name: `Holder${BELL}Bell` }],
    };
    expect(() => S.decodeUnknownSync(RoleMapConfig)(withControlByte)).toThrow();
  });

  test('REJECTS a zero-width char in a string', () => {
    const withZeroWidth = { ...valid, namespace_prefix: `puru${ZWSP}puru:` };
    expect(() => S.decodeUnknownSync(RoleMapConfig)(withZeroWidth)).toThrow();
  });

  test('REJECTS an unknown key (closed Struct)', () => {
    const withExtra = { ...valid, sneaky: true };
    expect(() =>
      S.decodeUnknownSync(RoleMapConfig)(withExtra, { onExcessProperty: 'error' }),
    ).toThrow();
  });

  test('cycle-010 FR-3: a rule WITHOUT owner still decodes (additivity)', () => {
    // `owner` is plain-optional — an existing role-map authored before cycle-010
    // (no owner key on any rule) must still validate.
    expect(() => S.decodeUnknownSync(RoleMapConfig)(valid)).not.toThrow();
  });

  test('cycle-010 FR-3: a rule WITH owner manual|freeside decodes', () => {
    const withOwner = {
      ...valid,
      rules: [
        { ...valid.rules[0], owner: 'freeside' },
        { ...valid.rules[0], role_key: 'purupuru:whale', owner: 'manual' },
      ],
    };
    expect(() => S.decodeUnknownSync(RoleMapConfig)(withOwner)).not.toThrow();
  });

  test('cycle-010 FR-3: an unknown owner value is REJECTED', () => {
    const badOwner = { ...valid, rules: [{ ...valid.rules[0], owner: 'overlord' }] };
    expect(() => S.decodeUnknownSync(RoleMapConfig)(badOwner)).toThrow();
  });
});

describe('ApplyModeConfig', () => {
  test('decodes SHADOW and LIVE', () => {
    expect(() => S.decodeUnknownSync(ApplyModeConfig)({ apply_mode: 'SHADOW' })).not.toThrow();
    expect(() => S.decodeUnknownSync(ApplyModeConfig)({ apply_mode: 'LIVE' })).not.toThrow();
  });
  test('rejects an unknown apply_mode literal', () => {
    expect(() => S.decodeUnknownSync(ApplyModeConfig)({ apply_mode: 'YOLO' })).toThrow();
  });
  test('accepts an optional last_go_live_report_hash (Hex64)', () => {
    expect(() =>
      S.decodeUnknownSync(ApplyModeConfig)({ apply_mode: 'LIVE', last_go_live_report_hash: 'd'.repeat(64) }),
    ).not.toThrow();
  });
  test('rejects a non-hex64 last_go_live_report_hash', () => {
    expect(() =>
      S.decodeUnknownSync(ApplyModeConfig)({ apply_mode: 'LIVE', last_go_live_report_hash: 'nothex' }),
    ).toThrow();
  });
});

describe('OnboardingLifecycle', () => {
  const valid = {
    cm_identity_id: '550e8400-e29b-41d4-a716-446655440000',
    step: 'shadow_preview',
    link_state: 'linked',
    last_medium: 'web',
  };
  test('decodes a valid per-CM lifecycle record', () => {
    expect(() => S.decodeUnknownSync(OnboardingLifecycle)(valid)).not.toThrow();
  });
  test('requires a UUID cm_identity_id', () => {
    expect(() => S.decodeUnknownSync(OnboardingLifecycle)({ ...valid, cm_identity_id: 'not-a-uuid' })).toThrow();
  });
  test('rejects an unknown step literal', () => {
    expect(() => S.decodeUnknownSync(OnboardingLifecycle)({ ...valid, step: 'teleport' })).toThrow();
  });
  test('accepts an optional go_live_job', () => {
    const withJob = {
      ...valid,
      step: 'go_live',
      go_live_job: {
        job_id: 'job-1',
        status: 'running',
        progress: { total: 3, completed: 1, failed: 0 },
        roles_created: [{ role_key: 'purupuru:holder', role_id: '123', op_id: 'op-1' }],
        op_status: [{ op_id: 'op-1', status: 'ok' }],
      },
    };
    expect(() => S.decodeUnknownSync(OnboardingLifecycle)(withJob)).not.toThrow();
  });
});
