# packages/protocol — sealed schemas every world consumes

The wire-format contracts that bridge `freeside-world` consumers (registry generator, future Freeside dashboard, future MCP wrappers, BUILDER tooling) to a single coherent vocabulary about what a "world" is.

## Schemas

| File | What | Status |
|---|---|---|
| `world-manifest.schema.json` | declares a world Entity with its Component attachments. Consumed by `packages/registry/bin/generate-tf.ts`. | **v1.0** (active) |
| `world-component.schema.json` | (reserved) extracted Component types if reuse outside `world-manifest` emerges. Today they live as `$defs` in `world-manifest`. | not yet authored |
| `room.schema.json` | (reserved) per-route declarations consumed by a future Freeside Navigation System. Today they live as `$defs/Room` in `world-manifest`. | reserved for v1.1+ |

## What lives here

- World Entity shape
- Component type vocabulary (Hosting, Identity, Payment, Render, ...) per [`ecs-architecture-freeside`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/ecs-architecture-freeside.md)
- Construct-attachment declarations
- Secret declarations (lifecycle + key shape)
- Network extras (per-world security-group rules beyond defaults)
- Reserved Room/Door declarations

## What does NOT live here

- **Score schemas** — already in [`score-vault`](https://github.com/0xHoneyJar/score-vault) (multi-consumer; correctly extracted top-level).
- **Composition orchestration schemas** — live in [`loa-constructs/.claude/schemas/runtime/composition.schema.json`](https://github.com/0xHoneyJar/loa-constructs/blob/main/.claude/schemas/runtime/composition.schema.json). Worlds reference compositions; they don't define the composition shape.
- **Per-world domain schemas** (mibera trait enums, purupuru element types) — live in each world's own `packages/{world}-protocol/` (per [`mibera-world-consolidation`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/mibera-world-consolidation.md)'s `@mibera/manifest-schema` precedent).

## Governance

See [`VERSIONING.md`](VERSIONING.md). Imported verbatim from `loa-constructs/.claude/schemas/VERSIONING.md`. Enum-locked `schema_version`, additive-only minor bumps, major bumps require new file + migration plan + stable `$id`.

## Consumers

- `freeside-world/packages/registry/bin/validate.ts` — pre-generation gate
- `freeside-world/packages/registry/bin/generate-tf.ts` — emits terraform
- `freeside-world/packages/creator/skills/creating-worlds/SKILL.md` — Stage 9 validates a draft against this
- (future) Freeside dashboard — runtime queries
- (future) `bin/loa world create` CLI wrapper

When 2+ external repos consume this schema, extraction trigger fires per `docs/splitting-paths.md` (extract to standalone repo `freeside-world-protocol`).
