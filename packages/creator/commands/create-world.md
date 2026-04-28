---
name: create-world
description: Author a new world through COSMOGRAPHER's 11-stage apprenticeship. Refusal-gated; produces a registry-PR-ready world manifest + a clone-ready base scaffold.
---

# /create-world — COSMOGRAPHER's authoring command

Invokes the `creating-worlds` skill. COSMOGRAPHER guides you through 11 stages (intent → naming → scaffold → apps → Components → protocol → composition → secrets → registry → terraform → publish), refusing to advance until each stage is defensibly complete.

## Usage

```
/create-world                         start a new world from Stage 1
/create-world resume <slug>           resume a draft at grimoires/freeside-world/drafts/<slug>/
/create-world intervene <slug>        full critique + alternatives, when stuck
/create-world glance <slug>           quick status: "Stage N complete · M Components attached"
```

## What you'll need before invoking

- A world thesis (one-breath: who inhabits, what for, one-noun name)
- Familiarity with [`world-system-pattern`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/world-system-pattern.md) and [`ecs-architecture-freeside`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/ecs-architecture-freeside.md)
- Write access to `0xHoneyJar/freeside-world` (for the registry PR in Stage 9)
- Write access to `0xHoneyJar/loa-freeside` (for the terraform PR in Stage 10) OR the operator who has it ready to merge

## What you'll get

| Stage | Artifact |
|---|---|
| 1 | `grimoires/freeside-world/drafts/<slug>/intent.md` — captured world thesis |
| 3 | a fresh `<slug>-world/` repo from `packages/base/starter` |
| 5 | `<slug>-world/freeside-world.yaml` — Component attachments declared |
| 9 | PR to `freeside-world/packages/registry/worlds/<slug>.yaml` |
| 10 | PR to `loa-freeside/infrastructure/terraform/world-<slug>.tf` |
| 11 | live world on Freeside ECS |

## Refusal model

COSMOGRAPHER will refuse to advance a stage when it's not defensibly complete. This isn't pedantry — it's the structural seam telling you something. Re-name, re-shape, re-attach until the shape holds.

See `freeside-world/packages/creator/skills/creating-worlds/SKILL.md` for the full refusal table.

## Sibling commands

- `/create-construct` — CURATOR's apprenticeship for skill-pack authorship (different domain, same shape)
- `/explore-network` — CURATOR's wayfinding for finding existing constructs

## Provenance

Authored 2026-04-28 as part of `freeside-world` MVP. Persona: COSMOGRAPHER. Skill: `creating-worlds`.
