# Family Map — where freeside-worlds fits in the org

Per [`loa-org-naming-conventions`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/loa-org-naming-conventions.md). This is the visual reference: which prefix declares attachment to which layer.

---

## The five families

```
                                 ┌─────────────────────────────────┐
                                 │   loa-* (engine layer)          │
                                 │   ────────────────────          │
                                 │   loa-finn      L3 routing      │
                                 │   loa-freeside  L4 deployment   │
                                 │   loa-hounfour  L2 ceremony     │
                                 │   loa-dixie     L5 intelligence │
                                 │   loa-constructs (substrate)    │
                                 └────────────────┬────────────────┘
                                                  │ attached-to
                                                  ▼
              ┌──────────────────────────────────────────────────────────┐
              │   freeside-* (installable modules attaching to Freeside) │
              │   ─────────────────────────────────────────────          │
              │   freeside-worlds      ← THIS REPO                        │
              │       packages/creator    apprenticeship                  │
              │       packages/base       scaffold                        │
              │       packages/protocol   sealed schemas                  │
              │       packages/registry   world manifests + tf generator  │
              │   freeside-score      (sibling — score schemas, scaffolded│
              │       packages/protocol    NATS events, branded types)    │
              │       packages/ports       IScoreServiceClient            │
              │       packages/mcp-tools   agent-callable surface         │
              │       packages/adapters    typed clients                  │
              │   freeside-metadata   (stub — NFT metadata + storage)     │
              │       packages/protocol    (pending design session)       │
              │   freeside-ruggy      (in flight — zerker authoring)      │
              │       persona-bot consuming freeside-score schemas        │
              │                                                            │
              │   Doctrine: freeside-modules-as-installables               │
              │   (extends freeside-as-subway)                             │
              └──────────────────────────────────────────────────────────┘
                                                  │ produces
                                                  ▼
                                 ┌─────────────────────────────────┐
                                 │   {world}-* (per-world apps)    │
                                 │   ──────────────────────────    │
                                 │   apdao-world                   │
                                 │   mibera-world                  │
                                 │     apps/honeyroad              │
                                 │     apps/dimensions             │
                                 │     packages/@mibera/...        │
                                 │   purupuru-world                │
                                 │   sprawl-world                  │
                                 │   world-template (archived →    │
                                 │     freeside-worlds/packages/base)│
                                 └─────────────────────────────────┘

                                 ┌─────────────────────────────────┐
                                 │   construct-* (skill packs)     │
                                 │   ──────────────────────────    │
                                 │   construct-creator (CURATOR)   │
                                 │   construct-base                │
                                 │   construct-the-orchard         │
                                 │   construct-the-weaver          │
                                 │   construct-artisan             │
                                 │   construct-observer            │
                                 │   ... 20+ more                  │
                                 └─────────────────────────────────┘

                                 ┌─────────────────────────────────┐
                                 │   top-level sealed schemas      │
                                 │   ──────────────────────────    │
                                 │   (precedent: score-vault was   │
                                 │   proposed; superseded by       │
                                 │   freeside-score per attachment-│
                                 │   prefix doctrine. New sealed   │
                                 │   schemas default to a freeside-│
                                 │   * module's packages/protocol/.)│
                                 └─────────────────────────────────┘
```

---

## How prefixes carry meaning

| prefix | declares | example |
|---|---|---|
| `loa-*` | attaches to / is part of the engine layer (L1-L5 of [`sovereign-stack`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/sovereign-stack.md)) | `loa-finn`, `loa-freeside`, `loa-constructs` |
| `freeside-*` | installable module attaching to Freeside (each owns sealed schemas + adapters; per [`freeside-modules-as-installables`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/freeside-modules-as-installables.md)) | `freeside-worlds`, `freeside-score`, `freeside-metadata` |
| `freeside-{persona}` | persona-bot repo; bot USER name is bare (`@ruggy`) but repo carries the prefix | `freeside-ruggy` |
| `construct-*` | skill pack repo; slug after dash is the construct identity | `construct-creator`, `construct-the-orchard` |
| `{world}-*` | per-world apps + tooling | `mibera-honeyroad`, `purupuru-world` |

---

## Why freeside-worlds picks this prefix

The repo holds the system that **produces** worlds for Freeside. It doesn't ship as part of the Loa engine itself; it doesn't ship as a per-world app; it doesn't ship as a reusable construct. It's an operational module that attaches to Freeside — same as `freeside-metadata`, same shape as future `freeside-payment` or `freeside-observability` modules.

The repo name signals: "this thing produces stuff that lives on Freeside."

The internal structure follows freeside's own sub-package convention: `packages/protocol/` for sealed schemas (matches `loa-freeside/themes/sietch/src/packages/core/protocol/`).

---

## What's NOT in any family yet

| Repo | Family | Notes |
|---|---|---|
| `world-template` | (legacy) | Solo-world starter. Being absorbed into `freeside-worlds/packages/base/` (migration step 8). After absorption: archived with redirect. |
| `mibera-codex` | `mibera-*` (per-world) | Lore + per-token codex; lives in mibera world's codex tooling. Not a freeside-* attachment. |
| `mibera-contracts` | `mibera-*` | Smart contracts. Per-world; not freeside-attached. |

---

## Cross-references

- [`freeside-modules-as-installables`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/freeside-modules-as-installables.md) — names the freeside-* family as installable modules; this repo is instance-1
- [`freeside-as-subway`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/freeside-as-subway.md) — parent doctrine; modules are subway items
- [`loa-org-naming-conventions`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/loa-org-naming-conventions.md) — the locked attachment-prefix doctrine
- [`world-system-pattern`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/world-system-pattern.md) — the design that produced this repo
- [`sovereign-stack`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/sovereign-stack.md) — L1-L5 stack architecture
- [`two-layer-bot-model`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/two-layer-bot-model.md) — sietch + ruggy split, persona-bot naming precedent
