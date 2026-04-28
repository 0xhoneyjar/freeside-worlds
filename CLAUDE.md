# freeside-world — agent instructions

This is the META layer for worlds. Four packages: `creator/` (apprenticeship), `base/` (scaffold), `protocol/` (sealed schemas), `registry/` (YAML source-of-truth → terraform generator).

## When loaded

Load this CLAUDE.md when:
- Operator invokes `/create-world` (loads `packages/creator`)
- Operator authors / edits a world manifest (loads `packages/registry/worlds/*.yaml` + `packages/protocol/`)
- Operator wants to scaffold a new world (loads `packages/base/starter/`)
- Operator asks "where does world X live in the org?" (load `docs/family-map.md`)

## Hard rules

- **Naming is locked.** `freeside-world` umbrella + `packages/protocol/` schema vocabulary are LOCKED per [`loa-org-naming-conventions`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/loa-org-naming-conventions.md). Other package names (`creator`, `base`, `registry`) are recommendations from the design doctrine; finalizable during implementation.
- **Schema governance imported verbatim from loa-constructs.** Enum-locked `schema_version`, additive-only minor bumps, major bumps require migration plan + new file + stable `$id`.
- **Idempotency gate**: `bin/generate-tf.ts` MUST produce zero-diff `terraform plan` against `loa-freeside/infrastructure/terraform/world-{name}.tf` for the 5 existing worlds. If the diff is non-zero, the schema is incomplete or the templates are wrong.
- **Don't push to `loa-freeside` directly.** The registry → terraform pipeline opens a cross-repo PR; humans merge.

## Composition

This repo composes with:
- `loa-freeside` — terraform module + downstream consumer of generated `.tf` files
- `loa-constructs` — schema-governance discipline (`VERSIONING.md`)
- `construct-creator` — apprenticeship pattern (mirrored shape, sibling persona)
- `construct-base` — scaffold pattern (mirrored shape, world-flavor)

## What this repo does NOT own

- The terraform module itself (`loa-freeside/infrastructure/terraform/modules/world/`) — module stays in loa-freeside; only the per-tenant `.tf` files get auto-generated from here.
- Domain-specific schemas (mibera trait enums, score event payloads) — those live in their own packages (`score-vault`, per-world `packages/{world}-protocol/`).
- World deployment runtime (ECS task lifecycle) — that's Freeside.

## References

- Design doctrine: `vault/wiki/concepts/world-system-pattern.md`
- Naming: `vault/wiki/concepts/loa-org-naming-conventions.md`
- Parent: `vault/wiki/concepts/contracts-as-bridges.md`
