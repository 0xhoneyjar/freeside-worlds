# @freeside-worlds/config-protocol

**Effect.Schema** protocol + derived TS types for **world surface-config** —
the runtime-editable, per-surface config a community manager edits live (copy,
theme), keyed by `(world_slug, surface)`.

C-1 extraction: ports Jani's sietch **Theme model**
(`themes/sietch/src/ui/builder/src/types/index.ts`) faithfully, and the
head-pointer / append-only / optimistic-lock **machinery**
(`themes/sietch/src/services/config/ConfigService.ts`) into freeside-worlds.

## The two faces of a per-world model

| | world-manifest (`packages/protocol`) | surface-config (this package) |
|---|---|---|
| **what** | infra declaration | runtime content |
| **when** | deploy-time (terraform-bound) | live (CM edits) |
| **carries** | hosting, identity, secrets, `tenant_id`, `guild_ids`, `auth` | per-surface `{enabled, copy, theme?}` |
| **key** | `slug` | `(world_slug, surface)` |

surface-config **references** `world_slug` only — it NEVER duplicates the
manifest's `tenant_id` / `guild_ids` / `auth`. Those stay the manifest's
source-of-truth.

## Convention — Effect.Schema (NOT Ajv)

The NEW config protocol is authored in **`@effect/schema`**, following the
cluster's zod→@effect/schema direction (operator-memory
`freeside-effect-transition`). `surface-config.ts` IS the contract: the
`Schema.Struct`/`Schema.Literal`/`Schema.Array`/`Schema.suspend` definitions are
the source of truth, and TS types are **derived** via
`Schema.Schema.Type<typeof X>` (the Effect equivalent of `z.infer`). The
canonical cluster reference this mirrors is freeside-auth
`packages/protocol/src/svc-jwt-claims.ts` (the first Effect.Schema artifact).

Validation runs at the **service boundary** (`validate.ts`) via
`Schema.decodeUnknownEither` with `onExcessProperty: 'error'` (reject unknown
keys, don't strip). It is wrapped in a thin, non-throwing
`{ ok, value | errors }` API so engine/route code never imports `effect`
directly.

> **Mixed-state is fine.** The legacy `world-manifest` protocol
> (`packages/protocol`) stays **Ajv / JSON-Schema** — this Effect.Schema
> conversion is scoped to the NEW config protocol only, matching the cluster's
> transition window (new protocol-layer types use Effect.Schema; legacy zod/Ajv
> stays for now).

## Surfaces (v1.0)

- `verify-message` — `{ enabled, copy: {title, body, buttonLabel}, theme? }`

Adding a surface = additive bump (extend the `Surface` literal + the
`SurfaceConfigMap` + the per-surface payload schema).

## Security: store raw-but-bounded, escape-at-render (BLOCKER-1)

This package is the **write-side, medium-agnostic VALIDATION** half of the
config-injection defense: a **closed** `ComponentInstance.props` slot-schema (no
open record), **length caps** on every CM-editable string, and **control-byte /
zero-width rejection** on every stored string. It does **NOT** escape output.

The **render-side, medium-specific ESCAPING** is owned by `freeside-mediums`
(bead **arrakis-4re1 / C-5**): Discord CV2 + the verify web page HTML (see
loa-freeside **arrakis-art2 F-001**). **The store never emits to a medium
directly.**

➡ Full contract: **[`RENDER-CONTRACT.md`](./RENDER-CONTRACT.md)**.
