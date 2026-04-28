# packages/base — growable world scaffold

The t=0 scaffold for new worlds. Single starter that grows from solo SvelteKit at root → multi-app turborepo, without forking.

## Layout

```
packages/base/
├── starter/             cloneable directory tree (the actual scaffold)
│   ├── README.md        becomes the new world's README
│   ├── CLAUDE.md        world-level agent instructions stub
│   ├── package.json     bun + workspaces:["apps/*", "packages/*"]
│   ├── src/lib/         solo-phase root SvelteKit module scaffold
│   ├── apps/            slot ready (empty until graduation)
│   ├── packages/        slot ready (empty until graduation)
│   ├── svelte.config.js
│   ├── drizzle.config.ts
│   ├── vite.config.ts
│   ├── Dockerfile
│   └── tsconfig.json
└── docs/
    ├── PHASES.md        when to graduate solo → hybrid → multi-app
    ├── GRADUATION.md    literal `git mv src apps/<slug>/src` migration steps
    └── COMPONENTS.md    Freeside Component attachment guide (Hosting/Identity/Payment/Render…)
```

## How to use

### Spawn a new world

```bash
# Manual (until template-from-subdir lands):
mkdir <slug>-world && cd <slug>-world
cp -r ~/Documents/GitHub/freeside-world/packages/base/starter/. .
git init && git add -A && git commit -m "init from freeside-world/packages/base"
gh repo create 0xHoneyJar/<slug>-world --public --source . --push
```

Future: a `bin/spawn-world.sh <slug>` helper inside `freeside-world` that automates this.

### Graduate a solo world to multi-app

See [`docs/GRADUATION.md`](docs/GRADUATION.md). One-line summary: `git mv src apps/<existing-name>/src`, drop a second app, hoist shared types into `packages/{world}-types/`.

## Stack

Solo phase (Phase 1):
- **SvelteKit 5** with Svelte runes
- **Turso/Drizzle** — SQLite with type-safe ORM
- **Vanilla wallet** — EIP-6963 multi-provider discovery (~100 LOC, no SDK)
- **SSE realtime** helper
- **Design tokens** — `taste.md` → `tokens.css` generation pipeline
- **Module scaffold** — `score/`, `wire/`, `design/` ready under `src/lib/`
- **bun** package manager (never pnpm or npm)
- **Railway** deploy ($5/mo) for solo phase; **Freeside ECS** for graduation phase

## Ancestry

This package **absorbs** [`0xHoneyJar/world-template`](https://github.com/0xHoneyJar/world-template). The original repo will be archived with a redirect once `freeside-world/packages/base/starter/` is content-complete (migration step 8 per the design doctrine).
