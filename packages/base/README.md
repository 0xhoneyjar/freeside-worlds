# packages/base — guidance for using world-base

This package carries **docs only**. The actual t=0 scaffold lives at [`0xHoneyJar/world-base`](https://github.com/0xHoneyJar/world-base) (created 2026-03-31; same content as the legacy `world-template`).

Operator decision 2026-04-28 late: don't duplicate the scaffold here. `world-base` is the canonical home; this package's job is to explain how to use it across the world's life cycle (solo → multi-app → optional Convex evolution).

## Layout

```
packages/base/
└── docs/
    ├── PHASES.md        when to graduate solo → hybrid → multi-app
    ├── GRADUATION.md    literal `git mv src apps/<slug>/src` migration steps
    └── COMPONENTS.md    Freeside Component attachment guide (Hosting/Identity/Payment/Render…)
```

## How to use

### Spawn a new world

```bash
# Once 0xHoneyJar/world-base is marked as a GitHub Template repo:
gh repo create 0xHoneyJar/world-<slug> --template 0xHoneyJar/world-base --public

# Until then (manual clone):
gh repo clone 0xHoneyJar/world-base world-<slug>
cd world-<slug>
rm -rf .git
git init && git add -A && git commit -m "init from world-base"
gh repo create 0xHoneyJar/world-<slug> --public --source . --push
```

(Note: existing worlds today follow the legacy `<slug>-world` suffix naming. Operator decision 2026-04-28 late flips this to `world-<slug>` prefix going forward, mirroring `construct-<slug>`. Existing repos need `gh repo rename` — coordination move tracked separately.)

### Graduate a solo world to multi-app

See [`docs/GRADUATION.md`](docs/GRADUATION.md). One-line summary: `git mv src apps/<existing-name>/src`, drop a second app, hoist shared types into `packages/{world}-types/`.

## Stack (in `world-base`)

Solo phase (Phase 1):
- **SvelteKit 5** with Svelte runes
- **Turso/Drizzle** — SQLite with type-safe ORM
- **Vanilla wallet** — EIP-6963 multi-provider discovery (~100 LOC, no SDK)
- **SSE realtime** helper
- **Design tokens** — `taste.md` → `tokens.css` generation pipeline
- **Module scaffold** — `score/`, `wire/`, `design/` ready under `src/lib/`
- **bun** package manager (never pnpm or npm)
- **Railway** deploy ($5/mo) for solo phase; **Freeside ECS** for graduation phase

## Why docs-here, scaffold-there

Per [[freeside-modules-as-installables]]: each module is cleanly installable. `world-base` is itself a freeside-* family member (specifically a `world-*` repo), and it works as a GitHub Template. Embedding its content under `freeside-worlds/packages/base/starter/` would duplicate the source-of-truth.

Docs stay here because they're guidance for using `world-base` across a world's life cycle (PHASES, GRADUATION, COMPONENTS attachment) — guidance lives near the META, while the scaffold lives in its own repo.

## Ancestry

- `0xHoneyJar/world-template` → renamed `0xHoneyJar/world-base` 2026-03-31 by operator (sovereign-stack starter; SvelteKit 5 + Turso/Drizzle + Railway $5/mo).
- This package's `docs/` were authored 2026-04-28 to explain how to use `world-base` per the doctrine [[world-system-pattern]].
