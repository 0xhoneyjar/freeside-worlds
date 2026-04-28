# Schema Versioning Policy — freeside-world/packages/protocol

> Imported verbatim from [`loa-constructs/.claude/schemas/VERSIONING.md`](https://github.com/0xHoneyJar/loa-constructs/blob/main/.claude/schemas/VERSIONING.md). One discipline across the org. Adapted only where the file path / consumer set differs.

> Schemas are bridges. They survive longer than impls. The version field is how we keep the bridge load-bearing as it ages.

This is the governance discipline for evolving every schema in this package. Reference: `~/vault/wiki/concepts/contracts-as-bridges.md` and `composition-schema-as-bridge.md`.

---

## TL;DR

- `schema_version` is **enum-locked** on every schema (not a regex pattern). Explicit audit trail.
- **Minor bumps are additive only.** v1.0 documents must validate against v1.1 unchanged.
- **Major bumps require a migration plan** alongside the schema PR. No silent v1 → v2.
- The public `$id` URL stays stable across all versions. Major breakage is signaled in `schema_version`, never the URL.
- **One bridge, two homes.** Schema lives in `freeside-world/packages/protocol`; consumers (registry generator, future Freeside dashboard, future MCP wrappers) reference it.

---

## When to bump

| Change | Bump |
|--------|------|
| Add a new optional property | minor (`1.0` → `1.1`) |
| Add a new enum value to an existing field | minor |
| Add a new optional `$defs` block | minor |
| Tighten validation (new pattern, smaller `maxLength`) on a field | **major** — existing valid docs may now fail |
| Remove a property | **major** |
| Rename a property | **major** (with migration plan) |
| Change a `const` to an `enum` (additive) | minor |
| Change a property type | **major** |
| Tighten `additionalProperties: false` where it was previously `true` | **major** |
| Add a new required field | **major** — breaks all prior docs |
| Cosmetic edits (descriptions, `$comment`, examples) | no bump |

If unsure, ask: *would any existing valid document fail under the new schema?* If yes → major. If no → minor.

---

## How to bump

### Minor (additive)

1. Edit the schema file. Add the new optional shape; do not change required fields.
2. Update `schema_version`:
   ```json
   "schema_version": { "type": "string", "enum": ["1.0", "1.1"] }
   ```
   Add the new version to the enum; **do not remove old versions**. Multi-version validation is the whole point.
3. Mark added fields with `// v1.1` in their `description` so a reader can date them.
4. Update this `VERSIONING.md` with the change in the changelog below.
5. PR-merge as a single atomic change. Ship the spec doc alongside if non-trivial.

### Major (breaking)

1. Cut a new file: `world-manifest.v2.schema.json` (or similar). Both files coexist for the deprecation window.
2. Update `$id` on the v2 file. **Do not change v1's `$id`.**
3. Write a migration plan in `docs/<schema>-v2-migration.md`:
   - what changed (diff)
   - automatic transformer (script that converts v1 docs → v2)
   - deprecation date for v1
   - consumer impact list
4. Land v2 schema + transformer + at least one migrated registry YAML as the proof-of-life.
5. Other consumers migrate at their own pace; CI tracks both.
6. After the deprecation window closes, the v1 file is moved to `archived/` (not deleted; archaeology matters).

---

## What does not change across versions

These invariants hold for any version of any schema in this package:

1. **The `$id` URL is permanent.** Major versions get a new file, not a moved URL. External consumers cache by URL.
2. **The schema family stays cohesive in `freeside-world/packages/protocol/`.** No asymmetric extraction. Extraction triggers are documented in `docs/splitting-paths.md`.
3. **Schemas describe shape, not narrative.** Prose belongs in YAML `description` fields and Markdown docs, not in validation rules.
4. **Validation runs at the substrate boundary**, not after work. `bin/validate.ts` validates pre-generation (gate before terraform emission).

---

## Why enum, not pattern

A `pattern` like `^1\.\d+$` admits any minor version implicitly. That's seductive but harmful:

- **Audit trail vanishes.** "Which versions exist?" requires reading code, not the schema.
- **Doc tooling breaks.** Generators that enumerate version values produce nothing.
- **Forward compat becomes a guessing game.** A consumer can't know which v1.x shapes exist without checking every consumer.

Enum is explicit. Every supported version is named. Adding one is a one-line, reviewable change.

---

## Versions in flight

| Schema | Path | Current | Notes |
|--------|------|---------|-------|
| `world-manifest` | `world-manifest.schema.json` | **1.0** | Initial. Covers every field used by the 5 existing worlds (apdao, mibera, midi, rektdrop, score-api) at terraform/modules/world/variables.tf field-for-field, plus ECS Component vocabulary (Hosting, Identity), construct-composition declarations, secret declarations, and reserved Room slots for v1.1+. |

---

## Changelog

### world-manifest.schema.json

| Version | Date | Change | Backward-compat | PR |
|---------|------|--------|-----------------|-----|
| 1.0 | 2026-04-28 | Initial schema. Mirrors terraform/modules/world/variables.tf inputs + adds Component vocabulary + construct-composition + Room reservation. Validates all 5 existing worlds when bootstrapped from terraform. | — | (initial commit) |

---

## References

- `vault/wiki/concepts/contracts-as-bridges.md` — parent doctrine
- `vault/wiki/concepts/composition-schema-as-bridge.md` — instance-1 of this discipline
- `vault/wiki/concepts/world-system-pattern.md` — the design that produced this package
- `loa-constructs/.claude/schemas/VERSIONING.md` — the source-of-truth this file imports from
