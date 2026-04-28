# Graduation — solo → multi-app turborepo

Literal migration steps from Phase 1 (solo SvelteKit at root) to Phase 3 (multi-app turborepo). Phase 2 is transitional and resolves into either Phase 1 (if second app retreats) or Phase 3 (if second app sticks).

## When to do this

Triggers (any one is sufficient):
- ✅ Second app is being authored and shares types/auth/design with the root
- ✅ Cross-app duplication is happening (copy-paste of trait enums, contract addresses, auth helpers)
- ✅ Both apps need their own `next.config.js` / `svelte.config.js` (different framework)

Don't graduate if:
- ❌ Only one app exists and one is "speculative"
- ❌ Two apps but they share zero substrate (different domain, different auth, different DB) — those are different worlds, not different apps of the same world

## Steps

### 1. Move the root app into apps/

```bash
# Pick the root app's slug. For mibera-world, this was "honeyroad" (the Vercel project name + dominant surface).
ROOT_APP=honeyroad

# git-aware move preserves history
git mv src apps/$ROOT_APP/src
git mv svelte.config.js apps/$ROOT_APP/svelte.config.js
git mv vite.config.ts apps/$ROOT_APP/vite.config.ts
git mv drizzle.config.ts apps/$ROOT_APP/drizzle.config.ts
git mv tsconfig.json apps/$ROOT_APP/tsconfig.json
git mv Dockerfile apps/$ROOT_APP/Dockerfile

# Move the root package.json (rename it world-app-specific)
git mv package.json apps/$ROOT_APP/package.json
```

### 2. Author a fresh root package.json

```json
{
  "name": "<slug>-world",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "test": "turbo test"
  },
  "devDependencies": {
    "turbo": "^2.0.0"
  },
  "packageManager": "bun@1.x"
}
```

### 3. Verify turbo.json is fit-for-purpose

The starter ships a default `turbo.json`. Verify the per-task pipeline matches your apps' build/test/dev needs.

### 4. Author the second app

```bash
mkdir -p apps/<new-app>
cd apps/<new-app>
# scaffold from your framework of choice — Next.js, SvelteKit, Vite, etc.
# OR git subtree add if you're consolidating from an existing standalone repo:
#   git subtree add --prefix=apps/<new-app> <existing-repo-url> main
```

### 5. Hoist shared types as needed

When the same enum/interface/schema appears in 2+ apps, hoist it:

```bash
mkdir -p packages/@<slug>/types
# move + cleanup imports:
#   apps/honeyroad/src/lib/types/traits.ts → packages/@<slug>/types/traits.ts
# update imports in both consumers:
#   import { type Trait } from "@<slug>/types/traits"
```

Per [`mibera-world-consolidation`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/mibera-world-consolidation.md), the canonical hoisting set is:

| package | what hoists |
|---|---|
| `@<slug>/types/` | trait enums, archetype definitions, contract addresses |
| `@<slug>/manifest-schema/` | JSON schemas + Zod validators (mibera precedent) |
| `@<slug>/auth-hooks/` | Dynamic JWT, admin-wallet, SIWE helpers |
| `@<slug>/design-tokens/` | OKLCH tokens (only when 2+ apps actually share visual identity) |

### 6. Update terraform manifest (if hosted on Freeside)

If your world's `freeside-world/packages/registry/worlds/<slug>.yaml` declared `repo: 0xHoneyJar/<slug>-honeyroad` (single-app), update to point at the monorepo path:

```yaml
repo: 0xHoneyJar/<slug>-world  # used to be <slug>-honeyroad
# (and the Dockerfile path inside that repo is now apps/honeyroad/Dockerfile)
```

You'll need a Dockerfile at the monorepo root that knows how to build a specific app:

```dockerfile
ARG APP_SLUG
COPY . .
RUN cd apps/$APP_SLUG && bun install && bun run build
```

Or per-app Dockerfiles referenced from the world manifest's `image_tag` workflow.

### 7. CI updates

GitHub Actions workflows under `.github/workflows/` need updating:
- Build context shifts from repo root to `apps/<app>/` for app-specific builds
- Use `paths:` filters so unrelated app changes don't trigger every CI job
- Use turborepo's remote caching for cross-app build skip

### 8. Rerun freeside-world's terraform generator

If you updated the registry YAML in step 6:

```bash
cd ~/Documents/GitHub/freeside-world
bun run validate <slug>
bun run generate-tf <slug>
# open PR to loa-freeside with the new tf-out/world-<slug>.tf
```

## Common pitfalls

- **Forgetting to update Dockerfile build context**. The image-build path moved from `.` to `apps/<app>/`.
- **Forgetting to update worker/Dockerfile path in workflow**. CI cwd changes.
- **Hoisting too eagerly**. A type used in only one app doesn't need to hoist. Wait for the second consumer.
- **Hoisting too late**. If you have copy-paste of the same shape in 2+ apps for >1 sprint, hoist now — every additional inline copy makes the migration more painful.

## Reference

- [`mibera-world-consolidation`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/mibera-world-consolidation.md) — instance-1 of this pattern (full ADR with subtree-add specifics)
- [`world-system-pattern`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/world-system-pattern.md) — the META layer this package belongs to
