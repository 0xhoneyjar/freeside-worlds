# Components — Freeside ECS attachment guide

Worlds are **Entities** with attached **Components** ([`ecs-architecture-freeside`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/ecs-architecture-freeside.md)). The `freeside-world.yaml` manifest in your world's repo (and the `freeside-world/packages/registry/worlds/<slug>.yaml` mirror) declares which Components attach.

This doc maps Components to terraform behavior + identity setup + payment integration + render targets. Reference for COSMOGRAPHER's Stage 5 (Components decision) in `freeside-world/packages/creator`.

---

## Hosting Component (required)

Where the world runs.

| Component | Where | When to choose |
|---|---|---|
| `ECSHosting` | AWS Fargate-Spot via `loa-freeside/infrastructure/terraform/modules/world/` | Default. Single-task SQLite-on-EFS. Most worlds. |
| `VercelHosting` | Vercel | (reserved) For surfaces where Vercel's edge + Next.js build pipeline is load-bearing and Freeside-control isn't needed yet. |
| `RailwayHosting` | Railway | Solo-phase Phase 1. $5/mo. Migrates to ECSHosting at Phase 2+. |
| `MobileBinaryDistribution` | iOS / Android binaries | (reserved) For native app surfaces. Composes with `Render: iOSWrapperRender` / `SolanaMobileRender`. |

**Schema fields**: `cpu` (default 256), `memory` (default 512), `port` (default 3000), `health_check_path` (default `/`), `desired_count` (default 1, max 1 — SQLite single-writer).

**Health check**: if `/` does any IO (DB query, external API call), set `health_check_path: /api/health` and ship a static-200 endpoint that returns immediately. Cold-cache renders on `/` exceed the 5s container timeout and kill tasks (see mibera + midi precedents).

---

## Identity Component (one or more)

What credential systems the world accepts.

| Component | Use case |
|---|---|
| `DynamicAuth` | Dynamic Labs SDK — JWT + wallet + social. Cookie domain matters (subdomain isolation vs cross-subdomain SSO). |
| `SIWEAdmin` | SIWE (Sign-In with Ethereum) for admin-only allowlist. Lightweight. |
| `SIwTHJAuth` | THJ-internal SSO. See [`sign-in-with-thj`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/sign-in-with-thj.md). |
| `PasskeyAuth` | Passkey-based passwordless. |
| `SolanaSeedVaultAuth` | Solana Seed Vault for mobile binaries. |

Multiple Identity Components compose (e.g., DynamicAuth for users + SIWEAdmin for admin wallet).

---

## Network extras (rare)

Beyond the world module's defaults (HTTPS:443, EFS:2049, Finn:3000), some worlds need extras:

| Pattern | Example |
|---|---|
| Custom inbound | score-api ↔ RDS (5432, bidirectional rule pair) |
| Broad outbound | mibera (Railway Postgres on 30555 + WebSocket upgrades on non-443 ports) |

Declare in `network.extra_egress_rules` / `network.extra_ingress_rules`. The generator emits standalone `aws_security_group_rule` resources alongside the module call.

---

## Component Categories Reserved (Phase 2+)

These categories appear in [`ecs-architecture-freeside`](https://github.com/0xHoneyJar/loa-hivemind/blob/main/wiki/concepts/ecs-architecture-freeside.md) but aren't yet load-bearing in the v1.0 schema. Reserved for additive minor bumps:

- **Payment**: `NOWPayments`, `CreditLedger`, `AshLedger`
- **Economy**: `AshBalance`, `AshBurnRate`, `AshRunway`
- **Social**: `DiscordIntegration`, `TelegramIntegration`, `XIntegration`, `FarcasterIntegration`
- **Verification**: `NFTGate`, `TokenHolding`, `QuizGate`, `WalletAllowlist`
- **Render**: `WebPWARender`, `iOSWrapperRender`, `SolanaMobileRender`, `BaseMiniappRender`, `XThreadRender`, `TGMiniappRender`, `SteamRender`, `RobloxRender`

When a world needs one of these, add to `world-manifest.schema.json` v1.1+ and document the System that consumes it (e.g., `AshLedger` is consumed by `AshLedgerSystem` in Freeside).

---

## Mapping to existing 5 worlds

| world | Hosting | Identity | Network extras |
|---|---|---|---|
| apdao | ECSHosting (256/512) | — | — |
| rektdrop | ECSHosting (256/512) | — | — |
| mibera | ECSHosting (512/1024, /api/health) | DynamicAuth | broad TCP outbound |
| midi | ECSHosting (256/512, /api/health) | DynamicAuth | — |
| score-api | ECSHosting (256/512, /v1/health) | — | RDS bidirectional rule pair |

The five existing worlds map cleanly; no Component categories beyond Hosting + Identity + network extras are needed for v1.0.
