/**
 * validate.ts — surface-config validator (Effect.Schema decode)
 *
 * The SERVICE-BOUNDARY gate. The config service decodes-and-validates an
 * incoming config payload BEFORE it writes to the head pointer (fail-closed on
 * write). Reads are trusted (fail-soft) — already-validated data is returned
 * as-is.
 *
 * This replaces the C-1 scaffold's Ajv compile/validate path with Effect.Schema
 * `decodeUnknownEither`, matching the cluster convention in freeside-auth
 * `packages/protocol/src/svc-jwt-claims.ts` (`decodeSvcJwtClaims`): a thin,
 * non-throwing sync wrapper around the schema so route/engine code never has to
 * import `effect` directly, while the schema stays the single source of truth.
 *
 * The BLOCKER-1 hardening (bounded props slot-schema + length caps + control-
 * byte/zero-width rejection) is enforced inside the schema itself — so decoding
 * here IS the write-side defense. The render-side escape contract is C-5's
 * (see ./RENDER-CONTRACT.md).
 *
 * Usage (library):
 *   import { validateSurfacePayload } from "@freeside-worlds/config-protocol/validate";
 *   const result = validateSurfacePayload(world, "verify-message", config);
 *   if (!result.ok) { ... result.errors ... }
 */
import { Schema as S, ArrayFormatter, ParseResult } from '@effect/schema';
import { Either } from 'effect';
import {
  SurfaceConfigSchema,
  type Surface,
  type SurfaceConfig,
  type SurfaceConfigMap,
} from './surface-config.js';

export interface ValidationOk<Sf extends Surface> {
  ok: true;
  value: SurfaceConfig<Sf>;
}

/** A single parse issue, flattened to the {instancePath, message} shape the
 * engine + HTTP layer already consume (kept identical to the prior Ajv shape so
 * the engine's error model is unchanged). */
export interface ValidationIssue {
  instancePath: string;
  message: string;
}

export interface ValidationErr {
  ok: false;
  errors: ValidationIssue[];
}

export type ValidationResult<Sf extends Surface> = ValidationOk<Sf> | ValidationErr;

/**
 * `onExcessProperty: 'error'` is load-bearing for BLOCKER-1: by default
 * Effect.Schema STRIPS unknown keys (silent mutation). We instead REJECT any
 * key not declared in the schema — tree-wide. This is what makes
 * `ComponentInstance.props` a CLOSED slot-schema (an unknown prop key like
 * `onClick` → ConfigValidationError, not a silent drop) AND keeps the contract
 * promise that the store never silently mutates stored content. `errors: 'all'`
 * collects every issue so the operator's 422 lists all problems at once.
 */
const decode = S.decodeUnknownEither(SurfaceConfigSchema, {
  errors: 'all',
  onExcessProperty: 'error',
});

/**
 * Flatten an Effect ParseError into the {instancePath, message}[] shape the
 * consumers expect. `ArrayFormatter.formatErrorSync` yields one issue per
 * leaf with a `path` array (e.g. `["config", "copy", "title"]`) — we join it
 * into a JSON-pointer-ish `/config/copy/title` so the wire shape matches the
 * prior Ajv `instancePath`.
 */
function flattenParseError(err: ParseResult.ParseError): ValidationIssue[] {
  const issues = ArrayFormatter.formatErrorSync(err);
  if (issues.length === 0) {
    return [{ instancePath: '/', message: err.message }];
  }
  return issues.map((i) => ({
    instancePath: '/' + i.path.map(String).join('/'),
    message: i.message,
  }));
}

/** Validate a full SurfaceConfig envelope against the Effect.Schema. */
export function validateSurfaceConfig<Sf extends Surface = Surface>(
  candidate: unknown,
): ValidationResult<Sf> {
  const result = decode(candidate);
  if (Either.isRight(result)) {
    return { ok: true, value: result.right as SurfaceConfig<Sf> };
  }
  return { ok: false, errors: flattenParseError(result.left) };
}

/**
 * Validate just the inner `config` payload for a given surface by wrapping it
 * in a minimal envelope. Used by the PUT handler when the caller sends only
 * `{ config }` and the (world, surface) come from the URL path.
 */
export function validateSurfacePayload<Sf extends Surface>(
  world_slug: string,
  surface: Sf,
  config: SurfaceConfigMap[Sf],
): ValidationResult<Sf> {
  return validateSurfaceConfig<Sf>({
    schema_version: '1.0',
    world_slug,
    surface,
    config,
  });
}
