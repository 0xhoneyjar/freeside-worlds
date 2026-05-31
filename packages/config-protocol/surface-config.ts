/**
 * surface-config.ts — Effect.Schema surface-config protocol (C-1)
 *
 * The runtime-editable, per-surface config a community manager edits live
 * (copy, theme), keyed by `(world_slug, surface)`. Distinct from
 * world-manifest (the INFRA declaration): the manifest declares
 * hosting/identity/secrets/tenant_id/guild_ids (deploy-time, terraform-bound);
 * this declares per-surface runtime content (copy, theme). surface-config
 * NEVER duplicates the manifest's tenant_id/guild_ids/auth — it references
 * `world_slug` only.
 *
 * ── Effect.Schema, not Ajv ────────────────────────────────────────────────
 * The C-1 scaffold used Ajv (matching freeside-worlds' legacy
 * `world-manifest.schema.json`). This module overrides that for the NEW config
 * protocol: it is authored in **@effect/schema**, following the cluster's
 * zod→@effect/schema direction (operator-memory `freeside-effect-transition`,
 * 2026-05-26). The legacy world-manifest stays Ajv — mixed-state is fine.
 *
 * The canonical cluster reference is freeside-auth
 * `packages/protocol/src/svc-jwt-claims.ts` (SvcJwtClaims — the first
 * Effect.Schema artifact in the cluster). This module mirrors its import style
 * (`import { Schema as S } from '@effect/schema'`), its `S.Schema.Type<typeof X>`
 * type-derivation idiom, and its non-throwing `decodeUnknownEither` wrapper
 * posture (see ./validate.ts).
 *
 * ── Jani's Theme model, faithful ──────────────────────────────────────────
 * Theme / ThemeBranding / PageLayout / ComponentInstance are Jani's sietch
 * model (themes/sietch/src/ui/builder/src/types/index.ts), field-for-field.
 * The ComponentInstance tree is recursive via `S.suspend`. The ONLY structural
 * change is BLOCKER-1 hardening (below) — same fields, tighter constraints.
 *
 * ── BLOCKER-1 (config-injection) hardening: store-raw-but-bounded ─────────
 * The bridgebuilder found that editable `copy.*` + an OPEN `theme.props`
 * record (sietch: `Record<string, unknown>`, schema: `additionalProperties:
 * true`) were rendered into Discord with zero sanitization. sietch's verify
 * copy was a hardcoded string; making it CM-editable changed the trust model,
 * and the port dropped the defense. The CONFIRMED contract splits the defense:
 *
 *   • WRITE-side (this package + config-engine) = generic VALIDATION
 *     (medium-agnostic). Enforced HERE:
 *       1. `ComponentInstance.props` is a CLOSED slot-schema (a bounded set of
 *          allowed keys + value-types — NOT an open record). Unknown keys are
 *          rejected at decode (Struct is closed by default in Effect.Schema).
 *       2. Every CM-editable string is LENGTH-CAPPED (title ≤ 200, body ≤ 4000,
 *          buttonLabel ≤ 80, prop strings ≤ 4000, names/ids ≤ 200).
 *       3. Every stored string REJECTS C0/C1 control bytes, DEL, and zero-width
 *          characters (the `BoundedString` filter) — mirrors loa-freeside's
 *          soul/handoff sanitizers (`.claude/scripts/lib/soul-identity-lib.sh`
 *          `_scrub_heading`), but REJECTS at write rather than strips.
 *
 *   • RENDER-side (mediums, C-5) = medium-specific ESCAPING. NOT here.
 *     See ./RENDER-CONTRACT.md: the store emits raw-but-bounded; the rendering
 *     medium (freeside-mediums, bead arrakis-4re1/C-5) MUST escape per-medium
 *     (Discord CV2, the verify web page HTML — loa-freeside arrakis-art2 F-001)
 *     before output. The store never emits to a medium directly.
 *
 * Source-of-truth for the Theme shape: Jani's sietch builder types.
 * Sibling pattern: freeside-auth `packages/protocol/src/svc-jwt-claims.ts`.
 */

import { Schema as S } from '@effect/schema';

// ─── BLOCKER-1 primitives: bounded, control-byte-free strings ─────────────

/**
 * Reject C0 control bytes (0x00–0x1F), DEL (0x7F), C1 control bytes
 * (0x80–0x9F), and zero-width Cf characters. Mirrors the ranges in
 * loa-freeside `.claude/scripts/lib/soul-identity-lib.sh` (`_scrub_heading` +
 * `_ZW_CLASS`) and the L6 handoff `_control` regex — but this is a config
 * WRITE gate, so it REJECTS rather than strips (the operator gets a 422 and
 * fixes the input; we never silently mutate stored content).
 *
 * Built from `\u` escapes via `new RegExp` so the source carries NO raw
 * control bytes (keeps the file reviewable + diff-clean).
 * Zero-width set (Cf): U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+FEFF.
 */
const CONTROL_OR_ZEROWIDTH = new RegExp(
  '[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]',
);

/**
 * A length-capped string that rejects control bytes + zero-width chars.
 * The single BLOCKER-1 write-side string primitive: every CM-editable /
 * stored string field is built from this so length + control-byte defense is
 * impossible to forget per-field.
 *
 * `filter` returns a string message on failure (Effect.Schema treats a
 * returned string as the parse-issue message — see svc-jwt-claims pattern).
 */
const BoundedString = (max: number) =>
  S.String.pipe(
    S.maxLength(max),
    S.filter((s): true | string =>
      CONTROL_OR_ZEROWIDTH.test(s)
        ? 'string contains a control byte or zero-width character (rejected)'
        : true,
    ),
  );

/** Non-empty bounded string (ids, names, required copy). */
const NonEmptyBounded = (max: number) => BoundedString(max).pipe(S.minLength(1));

// Field-specific caps (BLOCKER-1 length bounds).
const ID_MAX = 200;
const NAME_MAX = 200;
const TITLE_MAX = 200;
const BODY_MAX = 4000;
const BUTTON_MAX = 80;
const DESCRIPTION_MAX = 1000;
const PROP_STRING_MAX = 4000;
const FONT_FAMILY_MAX = 120;
const COLOR_MAX = 64;

// ─── Jani's sietch Theme model (faithful; props bounded per BLOCKER-1) ────

/**
 * ComponentInstance.props — the BLOCKER-1 closed slot-schema.
 *
 * sietch shipped `props: Record<string, unknown>` (open record;
 * `additionalProperties: true`). That open record is the config-injection
 * surface: a CM could store arbitrary keys/values that a medium renders
 * unsanitized. The contract replaces it with a CLOSED slot-schema — a bounded
 * set of allowed keys, each with a bounded value-type. The keys are the union
 * of the props sietch's own renderers read (rich-text `content`/`textAlign`/
 * `maxWidth`; nft-gallery `columns`/`layout`/`showMetadata`/...; leaderboard
 * `title`/`showRank`/`maxEntries`/...; layout-container `direction`/`gap`/...;
 * profile-card `showAvatar`/`showWallet`/`contractId`/...). Effect.Schema
 * `Struct` is CLOSED by default: any key NOT listed here is rejected at decode.
 * Every string slot uses `BoundedString` (length cap + control-byte reject).
 *
 * This is the medium-AGNOSTIC validation half of the BLOCKER-1 contract;
 * per-medium ESCAPING is C-5's job (see RENDER-CONTRACT.md).
 */
const ComponentProps = S.Struct({
  // Text / content slots (CM-editable display strings — capped + control-free).
  content: S.optional(BoundedString(PROP_STRING_MAX)),
  title: S.optional(BoundedString(TITLE_MAX)),
  heading: S.optional(BoundedString(TITLE_MAX)),
  subheading: S.optional(BoundedString(TITLE_MAX)),
  label: S.optional(BoundedString(NAME_MAX)),
  text: S.optional(BoundedString(PROP_STRING_MAX)),
  // Enum-ish layout strings (bounded; the renderer maps to a fixed class set).
  layout: S.optional(BoundedString(COLOR_MAX)),
  textAlign: S.optional(BoundedString(COLOR_MAX)),
  maxWidth: S.optional(BoundedString(COLOR_MAX)),
  direction: S.optional(BoundedString(COLOR_MAX)),
  gap: S.optional(BoundedString(COLOR_MAX)),
  padding: S.optional(BoundedString(COLOR_MAX)),
  background: S.optional(BoundedString(COLOR_MAX)),
  borderRadius: S.optional(BoundedString(COLOR_MAX)),
  // Reference ids (contract / collection ids the renderer resolves server-side).
  contractId: S.optional(BoundedString(ID_MAX)),
  collectionId: S.optional(BoundedString(ID_MAX)),
  // Numeric slots (bounded integers — no arbitrary numbers).
  columns: S.optional(S.Number.pipe(S.int(), S.between(1, 12))),
  maxEntries: S.optional(S.Number.pipe(S.int(), S.between(0, 1000))),
  maxItems: S.optional(S.Number.pipe(S.int(), S.between(0, 1000))),
  // Boolean display toggles.
  showRank: S.optional(S.Boolean),
  showAvatar: S.optional(S.Boolean),
  showChange: S.optional(S.Boolean),
  showMetadata: S.optional(S.Boolean),
  showOwner: S.optional(S.Boolean),
  showWallet: S.optional(S.Boolean),
  showBalance: S.optional(S.Boolean),
  showRoles: S.optional(S.Boolean),
  showStats: S.optional(S.Boolean),
});
export type ComponentProps = S.Schema.Type<typeof ComponentProps>;

/**
 * Jani's ComponentInstance — recursive tree. `props` is the bounded slot-schema
 * above (was an open record). `children` is recursive via `S.suspend` (the
 * Effect.Schema idiom for self-referential schemas — the thunk defers
 * resolution until the schema is fully constructed, breaking the init cycle).
 */
export interface ComponentInstance {
  readonly id: string;
  readonly type: string;
  readonly props: ComponentProps;
  readonly children?: ReadonlyArray<ComponentInstance> | undefined;
}

const ComponentInstance: S.Schema<ComponentInstance> = S.Struct({
  id: NonEmptyBounded(ID_MAX),
  type: NonEmptyBounded(NAME_MAX),
  props: ComponentProps,
  children: S.optional(
    S.Array(S.suspend((): S.Schema<ComponentInstance> => ComponentInstance)),
  ),
});

export const PageLayout = S.Struct({
  id: NonEmptyBounded(ID_MAX),
  name: NonEmptyBounded(NAME_MAX),
  slug: NonEmptyBounded(NAME_MAX),
  components: S.Array(ComponentInstance),
});
export type PageLayout = S.Schema.Type<typeof PageLayout>;

/** Font family + weight (Jani's FontSpec; weight bounded 1–1000). */
const FontSpec = S.Struct({
  family: NonEmptyBounded(FONT_FAMILY_MAX),
  weight: S.Number.pipe(S.int(), S.between(1, 1000)),
});

export const ThemeBranding = S.Struct({
  colors: S.Struct({
    primary: BoundedString(COLOR_MAX),
    secondary: BoundedString(COLOR_MAX),
    accent: BoundedString(COLOR_MAX),
    background: BoundedString(COLOR_MAX),
    surface: BoundedString(COLOR_MAX),
    text: BoundedString(COLOR_MAX),
  }),
  fonts: S.Struct({
    heading: FontSpec,
    body: FontSpec,
  }),
  borderRadius: S.Literal('none', 'sm', 'md', 'lg', 'full'),
  spacing: S.Literal('compact', 'comfortable', 'spacious'),
});
export type ThemeBranding = S.Schema.Type<typeof ThemeBranding>;

export const Theme = S.Struct({
  id: NonEmptyBounded(ID_MAX),
  name: NonEmptyBounded(NAME_MAX),
  description: S.optional(BoundedString(DESCRIPTION_MAX)),
  branding: ThemeBranding,
  pages: S.Array(PageLayout),
  // sietch stored createdAt/updatedAt as plain `string` (ISO-8601). Bounded.
  createdAt: NonEmptyBounded(NAME_MAX),
  updatedAt: NonEmptyBounded(NAME_MAX),
});
export type Theme = S.Schema.Type<typeof Theme>;

// ─── NEW: SurfaceConfig envelope + V1 verify-message surface ───────────────

/** The editable text shown on the verify surface (BLOCKER-1: all capped + control-free). */
export const VerifyMessageCopy = S.Struct({
  title: NonEmptyBounded(TITLE_MAX),
  body: NonEmptyBounded(BODY_MAX),
  buttonLabel: NonEmptyBounded(BUTTON_MAX),
});
export type VerifyMessageCopy = S.Schema.Type<typeof VerifyMessageCopy>;

/** The V1 community-manager-editable verify-message surface payload. */
export const VerifyMessageConfig = S.Struct({
  enabled: S.Boolean,
  copy: VerifyMessageCopy,
  /** Optional Jani Theme override; omit to inherit the world's default theme. */
  theme: S.optional(Theme),
});
export type VerifyMessageConfig = S.Schema.Type<typeof VerifyMessageConfig>;

/** The known surfaces. Literal-locked; additive minor bumps add surfaces. */
export const SurfaceSchema = S.Literal('verify-message');
export type Surface = S.Schema.Type<typeof SurfaceSchema>;

/** Map of surface -> its validated config shape (the per-surface payload type). */
export interface SurfaceConfigMap {
  'verify-message': VerifyMessageConfig;
}

/**
 * The wire envelope keyed by (world_slug, surface). `config` is the
 * surface-specific validated payload. V1 ships `verify-message` only, so the
 * envelope's `config` is decoded against `VerifyMessageConfig`. The generic
 * `SurfaceConfig<S>` TS type below preserves the surface->payload mapping for
 * callers; the runtime schema validates the V1 surface.
 *
 * `world_slug` regex matches world-manifest.schema.json `slug`
 * (`^[a-z][a-z0-9-]{1,20}$`) — surface-config REFERENCES the manifest's world,
 * it does not redeclare tenant_id/guild_ids/auth.
 */
export const WORLD_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,20}$/;

export const SurfaceConfigSchema = S.Struct({
  schema_version: S.Literal('1.0'),
  world_slug: S.String.pipe(S.pattern(WORLD_SLUG_PATTERN)),
  surface: SurfaceSchema,
  config: VerifyMessageConfig,
});

/** Generic TS envelope preserving the surface->payload mapping for callers. */
export interface SurfaceConfig<Sf extends Surface = Surface> {
  readonly schema_version: '1.0';
  readonly world_slug: string;
  readonly surface: Sf;
  readonly config: SurfaceConfigMap[Sf];
}

export const SURFACE_CONFIG_SCHEMA_VERSION = '1.0' as const;
export const KNOWN_SURFACES: readonly Surface[] = ['verify-message'] as const;

export { ComponentInstance };
