# Phases — solo → hybrid → multi-app → unified-state

A growable world scaffold. One starting point; documented graduation path. No fork required.

---

## Phase 1: Solo (default starting state)

**Shape**: single SvelteKit app at the repo root.

```
<slug>-world/
├── src/
│   ├── lib/
│   │   ├── db/         Drizzle + Turso
│   │   ├── score/      scoring module (reads/writes db/)
│   │   ├── wire/       data pipeline (reads/writes db/, doesn't import score/)
│   │   ├── design/     taste.md → tokens.css pipeline
│   │   ├── wallet.svelte.ts
│   │   └── realtime.svelte.ts
│   └── routes/
├── apps/                ← slot ready, empty
├── packages/            ← slot ready, empty
├── svelte.config.js
├── drizzle.config.ts
├── vite.config.ts
├── Dockerfile
├── package.json         ← workspaces declared, but unused
└── turbo.json           ← present, unused in solo phase
```

**Deploy**: Railway ($5/mo) for prototype phase; Freeside ECS for production.

**When to stay**: single app. Reasonable scope. No second-app pressure.

**Triggers to graduate**: see Phase 2.

---

## Phase 2: Hybrid (transitional)

**Shape**: root SvelteKit app preserved; first sibling app spawning under `apps/`.

```
<slug>-world/
├── src/                 ← still here; root app continues to deploy from here
├── apps/
│   └── <new-app>/       ← second app starts here
├── packages/            ← shared types start to hoist as cross-app duplication appears
├── ...
```

**When to enter Phase 2**: 
- Second app is being authored
- Duplication of types between intended-second-app and root is starting

**When to stay**: actively authoring the second app; not ready for the root migration.

**Triggers to graduate**: second app working; cross-app coordination friction (shared types, shared auth helpers, shared design tokens) becoming load-bearing.

---

## Phase 3: Multi-app turborepo (mibera/sprawl-shape)

**Shape**: root app retired into `apps/`; multiple apps coexist; shared `packages/`.

```
<slug>-world/
├── apps/
│   ├── first-app/       ← formerly the root
│   ├── second-app/
│   └── third-app/
├── packages/
│   ├── @<slug>/types/         shared trait/contract types
│   ├── @<slug>/auth-hooks/    Dynamic JWT + SIWE + admin helpers
│   ├── @<slug>/manifest-schema/  per-world schemas (mibera precedent)
│   └── @<slug>/design-tokens/    shared OKLCH tokens
├── turbo.json           ← per-task pipeline now meaningful
└── package.json         ← workspaces actively used
```

**Migration from Phase 2 → 3**: see [`GRADUATION.md`](GRADUATION.md). One-line: `git mv src apps/<slug>/src` + adjust workspace globs.

**When to stay**: multi-app reality; shared substrate is types-and-schemas (per-app DBs OK).

**Triggers to graduate**: cross-app live-state cohesion becomes the load-bearing requirement (shared presence, shared design tokens in DB, shared chat memory).

---

## Phase 4: Convex unified-state (purupuru-shape) — *evolution target only*

**Shape**: single root app + sibling sites under `sites/` + unified Convex schema.

```
<slug>-world/
├── app/                 single Next.js root
├── sites/               sibling sites consuming the same Convex DB
│   ├── site-a/
│   └── site-b/
├── convex/              unified schema (23 tables in purupuru's case)
├── components/          shared UI
└── ...
```

**When to evolve to Phase 4**: cross-site state cohesion is the load-bearing feature. Examples:
- Shared chat memory across surfaces
- Live presence (who's where in the world)
- Design tokens stored in DB for live tuning (taste.md becomes a live experiment surface)
- ERC-6551 token-bound accounts as cross-site identity anchor

**Why not default**: Phase 4 trades type-and-schema sharing for live-state sharing — a substantial migration. Most worlds don't need it. Mibera-world ADR (instance-1 of consolidation) explicitly documents purupuru-style as **evolution target**, not starting point.

**Triggers**: 3+ sites needing the same live data; Convex's reactive primitives become load-bearing; identity model wants ERC-6551 token-binding.

---

## Anti-patterns

- **Premature monorepo**: starting at Phase 3 with one app + speculative second. Stay solo until the second app is real.
- **Premature Phase 4**: adopting Convex before there's any live-state cross-site cohesion to share. Convex is excellent for the right shape; wrong shape is migration debt.
- **Stuck in Phase 2 forever**: hybrid is transitional. If the second app is working and shared types are growing, complete the migration to Phase 3.
- **Forking the scaffold**: every world should be able to graduate without forking. If the scaffold doesn't fit, file a PR to `freeside-world/packages/base` rather than diverging.
