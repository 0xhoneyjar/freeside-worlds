# Splitting Paths — when packages extract from this repo

`freeside-worlds` is a monorepo today. The four packages (`creator`, `base`, `protocol`, `registry`) coexist in one repo because they're co-evolving. Each can extract to its own repo when load-bearing pressure earns the split. This doc names the triggers.

Per [`loa-org-naming-conventions`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/loa-org-naming-conventions.md): extracted packages take the attachment-prefix convention (`freeside-worlds-protocol`, `freeside-worlds-creator`, etc.) unless promotion to a top-level multi-consumer schema (like `score-vault`) is justified.

---

## packages/protocol

**Extract trigger**: 2+ external repos consume the schema as a stable contract (CI validates against it; downstream impls bind to it).

**Extract target**: `0xHoneyJar/freeside-worlds-protocol`

**Why first**: schemas survive longer than impls. The schema's stability matters more than its co-location. As soon as external consumers exist, the schema needs its own release cadence (semver bumps separate from registry/creator/base velocity).

**Migration mechanism**: `git filter-repo --path packages/protocol/ --path-rename packages/protocol/:`. Preserve history. Update `freeside-worlds/packages/registry/bin/validate.ts` to fetch from the extracted repo's raw URL or pin to a commit.

**Keep here**: `packages/protocol/README.md` becomes a stub pointing at the extracted repo.

---

## packages/creator

**Extract trigger**: COSMOGRAPHER's stage state-machine grows beyond 500 LOC, OR additional creator-shaped surfaces emerge in the org (e.g., `freeside-metadata-creator`, `freeside-bot-creator`).

**Extract target**: `0xHoneyJar/freeside-worlds-creator`

**Why later**: COSMOGRAPHER's voice and the schema-it-validates-against need to stay close while the apprenticeship matures. Extracting too early makes coordination expensive.

**Migration mechanism**: `git filter-repo --path packages/creator/ --path-rename packages/creator/:`. After extraction, COSMOGRAPHER continues to validate Stage 9 against `freeside-worlds-protocol/world-manifest.schema.json` (which by this point is also extracted).

---

## packages/base

**Extract trigger**: `packages/base/starter/` becomes a GitHub Template repo that operators clone via `gh repo create --template`.

**Extract target**: `0xHoneyJar/freeside-worlds-base`

**Why this trigger**: GitHub doesn't (currently) support template-from-subdir. To get the `gh repo create --template` flow, the starter must be its own repo.

**Migration mechanism**: 
- `git filter-repo --path packages/base/starter/ --path-rename packages/base/starter/:` 
- Mark new repo as Template in GitHub settings
- Update `freeside-worlds/packages/creator/skills/creating-worlds/SKILL.md` Stage 3 to reference `gh repo create <slug>-world --template 0xHoneyJar/freeside-worlds-base`

**Keep here**: `packages/base/docs/{PHASES,GRADUATION,COMPONENTS}.md` stay in `freeside-worlds/docs/` (these document patterns, not the scaffold itself).

---

## packages/registry

**Extract trigger**: Freeside dashboard needs runtime queries against world data (sub-second latency, joined queries with deployment state).

**Extract target**: `loa-freeside/apps/dashboard` (NOT a new top-level repo — folded INTO loa-freeside per [`world-system-pattern`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/world-system-pattern.md)).

**Why folded, not extracted top-level**: at runtime-query scale, the registry IS Freeside's world database. Decoupling it from `loa-freeside` would create a worse seam than the current YAML→PR mechanism.

**Migration mechanism**:
- Add a Convex (or Postgres) table in `loa-freeside/apps/dashboard/convex/schema.ts`
- CI in `freeside-worlds` pushes registry YAML changes to the DB on PR-merge
- `freeside-worlds/packages/registry/worlds/*.yaml` remains the source-of-truth; DB is a derived mirror

**Stay here**: the `worlds/*.yaml` source-of-truth + the `bin/generate-tf.ts` generator. The DB mirror is downstream of these.

---

## Schema-extraction precedent

Per [`score-vault`](https://github.com/0xHoneyJar/score-vault) (instance-1 of top-level schema-vault repos): extract a schema package to a top-level repo when 2+ external repos consume it. The extraction happens BEFORE the schema becomes load-bearing across the org.

For `freeside-worlds/packages/protocol/`, the consumer set today is internal (registry generator + creator validator). Extraction earns its way when:
- `freeside-metadata` adopts the same `world-manifest` shape (unlikely — metadata is a different domain)
- A future Freeside dashboard's MCP wrapper validates external manifests
- A third-party ecosystem (someone else's `0xCommunity/world-deploy-helper`) wants to author worlds against this schema

Until then: keep here.

---

## Decision matrix

| package | extract first? | extract trigger | new repo |
|---|---|---|---|
| protocol | ✅ likely first | 2+ external repos consume | `freeside-worlds-protocol` |
| creator | ⏳ later | 500+ LOC stage machine OR sibling creators emerge | `freeside-worlds-creator` |
| base | 🌱 medium | needs GitHub Template-repo treatment | `freeside-worlds-base` |
| registry | 🚫 not extracted | folds into `loa-freeside` when runtime queries demand | (merged) |

---

## Anti-patterns

- **Premature extraction**: splitting a 200-LOC creator into its own repo because "schemas should be separate" is cargo culting. Wait for the friction.
- **Over-extracting**: putting every package in its own repo means cross-repo coordination on every change. If the four packages are co-evolving (today's reality), one repo wins.
- **Top-level extraction without multi-consumer**: extracting `protocol` to a top-level `world-protocol` repo when the only consumer is `freeside-worlds` itself is a churn-cost without payoff.
