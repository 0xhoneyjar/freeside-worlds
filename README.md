# freeside-world

> The META layer that produces world-architecture instances. Authoring + scaffolding + sealed schemas + registry — the four pieces that take a world from intent to a live ECS task on Freeside.

This repo houses the system that produces every world deployed onto Freeside. Each existing world (`apdao`, `mibera`, `midi`, `rektdrop`, `score-api`, …) is an **instance**; this repo is the **production system** for instance-N.

Doctrine: [`world-system-pattern`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/world-system-pattern.md) (instance-N+1 of [`contracts-as-bridges`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/contracts-as-bridges.md)). This repo is instance-1 of [`freeside-modules-as-installables`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/freeside-modules-as-installables.md) (siblings: `freeside-score`, `freeside-metadata`, `freeside-ruggy`).

## The four packages

```
freeside-world/
├── packages/
│   ├── creator/    📜 apprenticeship — COSMOGRAPHER guides world authoring across 11 stages
│   ├── base/       🪨 growable scaffold — solo SvelteKit → multi-app turborepo, no fork required
│   ├── protocol/   📐 sealed schemas every world consumes (world-manifest, components, attachments)
│   └── registry/   🗂 YAML source-of-truth → auto-generates world-{name}.tf in loa-freeside
└── docs/           extraction triggers, naming family map, scaffold phases
```

| package | role | analogous to |
|---|---|---|
| `creator/` | authoring surface (apprenticeship, refusal-gated stages) | [`construct-creator`](https://github.com/0xHoneyJar/construct-creator) |
| `base/` | t=0 scaffold for new worlds | [`construct-base`](https://github.com/0xHoneyJar/construct-base) (absorbs former `world-template`) |
| `protocol/` | wire-format contracts (Draft 2020-12 JSON Schema, enum-locked versioning) | [`loa-constructs/.claude/schemas/`](https://github.com/0xHoneyJar/loa-constructs/tree/main/.claude/schemas) |
| `registry/` | declarative source-of-truth + Terraform generator | implicit today: `loa-freeside/infrastructure/terraform/world-{name}.tf` (hand-written) |

## How a world gets created

```
COSMOGRAPHER (packages/creator)
    │  guides 11 stages
    ▼
clone packages/base/starter into <slug>-world repo
    │  Phase 1: solo SvelteKit at root
    │  Phase 3: graduate to apps/* + packages/* turborepo
    ▼
declare freeside-world.yaml (Component attachments per ECS doctrine)
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

Per [`loa-org-naming-conventions`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/loa-org-naming-conventions.md) (attachment-prefix doctrine, 2026-04-28):

- `freeside-*` — operational modules attaching to Freeside (deploy + host + runtime). `freeside-world`, `freeside-metadata`.
- `packages/protocol/` — sealed schemas, single consistent vocabulary across every `freeside-*` module.
- `loa-*` — engine layer (loa-finn, loa-freeside, loa-constructs, …).
- `construct-*` — skill packs.
- `{world}-*` — per-world apps (mibera-honeyroad, mibera-codex, purupuru-world, …).

See [`docs/family-map.md`](docs/family-map.md) for the full diagram.

## Splitting paths (when packages extract)

This repo is a monorepo today. Pre-documented extraction triggers:

| signal | extract | new repo |
|---|---|---|
| 2+ external repos consume `packages/protocol` | `packages/protocol` first | `freeside-world-protocol` (or per attachment-prefix at extraction time) |
| creator gets a 500+ LOC staged-state-machine | `packages/creator` | `freeside-world-creator` |
| base template hits 5+ consumers | `packages/base` as GitHub template | `freeside-world-base` |
| registry needs runtime queries | fold into `loa-freeside` | (not extracted; merged) |

See [`docs/splitting-paths.md`](docs/splitting-paths.md) for the full doctrine.

## Status

- 2026-04-28 — design doctrine landed at `world-system-pattern`
- 2026-04-28 — implementation kickoff: this repo, MVP scope (protocol + registry + base + creator)
- gate: `bin/generate-tf.ts` must produce zero-diff `terraform plan` against the 5 existing worlds (apdao, mibera, midi, rektdrop, score-api)

## License

MIT.

---

🌱 instance-N+1 lives. Future world-authoring reads from this META, not from prose.
