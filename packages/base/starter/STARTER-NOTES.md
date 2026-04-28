# Starter Notes — content port pending

This directory is the cloneable scaffold for new worlds. Per migration step 8 (per [`world-system-pattern`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/world-system-pattern.md)), the actual content gets ported in from [`0xHoneyJar/world-template`](https://github.com/0xHoneyJar/world-template) — the existing solo-world starter being absorbed.

## To complete the port

```bash
# From the freeside-world repo root:
WORLD_TEMPLATE=~/Documents/GitHub/world-template

# Copy the substantive files (not git history; not node_modules):
cp $WORLD_TEMPLATE/CLAUDE.md packages/base/starter/CLAUDE.md
cp $WORLD_TEMPLATE/README.md packages/base/starter/README.md
cp -r $WORLD_TEMPLATE/src packages/base/starter/src
cp $WORLD_TEMPLATE/svelte.config.js packages/base/starter/svelte.config.js
cp $WORLD_TEMPLATE/vite.config.ts packages/base/starter/vite.config.ts
cp $WORLD_TEMPLATE/drizzle.config.ts packages/base/starter/drizzle.config.ts
cp $WORLD_TEMPLATE/tsconfig.json packages/base/starter/tsconfig.json
cp $WORLD_TEMPLATE/Dockerfile packages/base/starter/Dockerfile
cp -r $WORLD_TEMPLATE/scripts packages/base/starter/scripts
```

Adjust the copied `package.json` to declare workspaces (per `packages/base/README.md`):

```json
{
  "name": "world-template-starter",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*"],
  ...
}
```

Then archive `0xHoneyJar/world-template` with a redirect note pointing here.

## What the starter ships (after port)

- SvelteKit 5 with Svelte runes
- Turso/Drizzle (SQLite + type-safe ORM)
- Vanilla EIP-6963 wallet discovery (~100 LOC)
- SSE realtime helper
- `taste.md` → `tokens.css` design pipeline
- `src/lib/{db,score,wire,design}/` module scaffold
- `apps/` + `packages/` slots ready (with `.gitkeep`)
- bun + Railway/Freeside Dockerfile
- Solo phase ready; graduates to multi-app per [`docs/PHASES.md`](../docs/PHASES.md)
