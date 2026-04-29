# freeside-worlds

> The META layer that produces world-architecture instances. Authoring + sealed schemas + registry + docs — the pieces that take a world from intent to a live ECS task on Freeside. The scaffold (`world-base`) lives as its own sibling repo.

This repo houses the system that produces every world deployed onto Freeside. Each existing world (`apdao`, `mibera`, …) is an **instance**; this repo is the **production system** for instance-N.

Doctrine: [`world-system-pattern`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/world-system-pattern.md). This repo is **instance-1** of [`freeside-modules-as-installables`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/freeside-modules-as-installables.md) — siblings: `freeside-score`, `freeside-filesystem`, `freeside-ruggy`. Plural slug (`freeside-worlds`) marks "registry of multiple subjects"; siblings are singular ("single capability set").

## The packages

```
freeside-worlds/
├── packages/
│   ├── creator/    📜 apprenticeship — COSMOGRAPHER guides world authoring across 11 stages
│   ├── base/       🪨 docs only — references the standalone 0xHoneyJar/world-base scaffold
│   ├── protocol/   📐 sealed schemas every world consumes (world-manifest, components, attachments)
│   └── registry/   🗂 YAML source-of-truth → auto-generates world-{slug}.tf in loa-freeside
└── docs/           extraction triggers, naming family map
```

| package | role | analogous to |
|---|---|---|
| `creator/` | authoring surface (apprenticeship, refusal-gated stages) | [`construct-creator`](https://github.com/0xHoneyJar/construct-creator) |
| `base/` | guidance for using the standalone `world-base` scaffold (PHASES, GRADUATION, COMPONENTS docs) | [`construct-base`](https://github.com/0xHoneyJar/construct-base) (sibling pattern; world-base is its world equivalent) |
| `protocol/` | wire-format contracts (Draft 2020-12 JSON Schema, enum-locked versioning) | [`loa-constructs/.claude/schemas/`](https://github.com/0xHoneyJar/loa-constructs/tree/main/.claude/schemas) |
| `registry/` | declarative source-of-truth + Terraform generator | implicit today: `loa-freeside/infrastructure/terraform/world-{slug}.tf` (hand-written) |

## How a world gets created

```
COSMOGRAPHER (packages/creator)
    │  guides 11 stages
    ▼
clone 0xHoneyJar/world-base into world-<slug> repo
    │  Phase 1: solo SvelteKit at root
    │  Phase 3: graduate to apps/* + packages/* turborepo
    ▼
declare world-manifest.yaml (Component attachments per ECS doctrine)
    │  Hosting / Identity / Payment / Render / ...
    ▼
register in packages/registry/worlds/<slug>.yaml
    │  validates against packages/protocol/world-manifest.schema.json
    ▼
bin/generate-tf.ts <slug>
    │  emits tf-out/world-<slug>.tf + tf-out/world-<slug>-secrets.tf
    ▼
cross-repo PR → loa-freeside/infrastructure/terraform/
    │  terraform plan + apply
    ▼
world live on Freeside ECS
```

## Naming

Per [`loa-org-naming-conventions`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/loa-org-naming-conventions.md) (attachment-prefix doctrine + 2026-04-28-late evolution):

- `freeside-*` — installable modules attaching to Freeside. Each owns sealed schemas + adapters. (`freeside-worlds`, `freeside-score`, `freeside-filesystem`, `freeside-ruggy`)
- `packages/protocol/` — sealed schemas, single consistent vocabulary across every `freeside-*` module.
- `loa-*` — engine layer (loa-finn, loa-freeside, loa-constructs, …).
- `construct-*` — skill packs (`construct-creator`, `construct-the-orchard`, …).
- `world-{slug}` — the WORLD repo itself (monorepo containing apps + per-world Components). `world-apdao`, `world-mibera`, `world-base`. *Operator decision 2026-04-28 late*: prefix-first, mirrors `construct-{slug}`. Existing `{slug}-world` repos to be renamed via `gh repo rename`.
- `{world-slug}-{component}` — per-world apps + tooling. (`mibera-honeyroad`, `mibera-codex`, `apdao-auction-house`).

See [`docs/family-map.md`](docs/family-map.md) for the full diagram.

## Splitting paths (when packages extract)

This repo is a monorepo today. Pre-documented extraction triggers:

| signal | extract | new repo |
|---|---|---|
| 2+ external repos consume `packages/protocol` | `packages/protocol` first | `freeside-worlds-protocol` (or per attachment-prefix at extraction time) |
| creator gets a 500+ LOC staged-state-machine | `packages/creator` | `freeside-worlds-creator` |
| (base scaffold) | already extracted as standalone | [`world-base`](https://github.com/0xHoneyJar/world-base) |
| registry needs runtime queries | fold into `loa-freeside` | (not extracted; merged) |

See [`docs/splitting-paths.md`](docs/splitting-paths.md) for the full doctrine.

## Status

- 2026-04-28 — design doctrine landed at `world-system-pattern`
- 2026-04-28 — initial scaffold implemented + published
- 2026-04-28 — renamed from `freeside-world` (singular) → `freeside-worlds` (plural — registry of multiple)
- 2026-04-28 — `packages/base/starter/` removed; `world-base` is the canonical scaffold
- gate: `bin/generate-tf.ts` produces canonical-form terraform for the 4 active worlds (apdao + mibera + midi + rektdrop). Idempotency report: `packages/registry/IDEMPOTENCY-REPORT.md`.

## License

MIT.

---

🌱 instance-N+1 lives. Future world-authoring reads from this META, not from prose.
