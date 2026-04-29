# packages/creator — COSMOGRAPHER's apprenticeship

The world-authoring surface. 11 stages, refusal-gated, persistent context. Mirrors `construct-creator`'s shape; different domain, sibling persona.

## Structure

```
packages/creator/
├── identity/
│   ├── COSMOGRAPHER.md        persona narrative (voice + disposition)
│   └── persona.yaml           short declaration
├── skills/
│   └── creating-worlds/
│       └── SKILL.md           the 11-stage skill
├── commands/
│   └── create-world.md        slash command binding
└── README.md                  this file
```

## What it does

When the operator invokes `/create-world`, COSMOGRAPHER:

1. Asks structured questions per stage (intent → naming → scaffold → apps → Components → protocol → composition → secrets → registry → terraform → publish).
2. Critiques each draft against five lenses (knowledge · craft · depth · structure · perceptual; gecko optional).
3. Refuses to advance until each stage is defensibly complete.
4. Emits Verdict / Artifact / Signal streams per stage.
5. Maintains persistent context across stages — earlier decisions surface tension when later stages contradict.

## What it does NOT do

- Install/manage existing worlds (use the registry PR workflow directly)
- Modify an existing world's manifest (edit `freeside-worlds/packages/registry/worlds/<slug>.yaml` + re-run `bun run generate-tf`)
- Author constructs (that's CURATOR / `construct-creator` / `/create-construct`)

## Composition

Same five-lens taste stack as CURATOR:

| Lens | Construct |
|---|---|
| knowledge | hivemind |
| craft | artisan |
| depth | k-hole |
| structure | the-arcade |
| perceptual | kansei |
| ecosystem (optional) | gecko |

## Provenance

- Authored 2026-04-28 as part of `freeside-worlds` MVP
- Sibling to CURATOR (museum-curator metaphor extended to world-authoring)
- Lineage: [world-system-pattern](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/world-system-pattern.md) (instance-N+1 of [contracts-as-bridges](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/contracts-as-bridges.md))
